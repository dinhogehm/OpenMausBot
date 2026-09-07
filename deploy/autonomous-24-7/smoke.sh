#!/usr/bin/env bash
# Verificação pós-aplicação:
#   1. GET  /api/workflows/health            → ok:true, engine a "tickar"
#   2. POST /api/workflows/:id/preflight     → todos os checks ok
#      (corre os checks GRAVADOS, sem corpo, sem criar run — workflow-api.ts:489-503)
#   3. --run: POST /api/workflows/:id/runs e acompanha GET /api/workflows/:id/runs
#      até completed|failed|cancelled (ou MAX_MINUTES), imprimindo a timeline.
#
# Atenção ao --run num workflow em ciclo: o run só termina no cap de passos,
# numa falha, ou quando o cancelar — por isso o acompanhamento tem um
# limite (MAX_MINUTES) e, ao atingi-lo, o run continua vivo no servidor.
# Enquanto houver run vivo o trigger interval não arma outro (plano D §1).

set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

WORKFLOW_ID="${WORKFLOW_ID:-eb42a861-2e2a-414e-b2ef-606ec89ce2ad}"
MAX_MINUTES="${MAX_MINUTES:-180}"
POLL_SECONDS="${POLL_SECONDS:-20}"
RUN_INPUT="${RUN_INPUT:-}"          # texto opcional passado ao run (schema: input ≤100k)

RUN=0; CANCEL_AT_END=0
for a in "$@"; do case "$a" in
  --run) RUN=1 ;; --cancel-at-end) CANCEL_AT_END=1 ;;
  -h|--help) sed -n 2,14p "$0"; exit 0 ;; *) die "argumento desconhecido: $a" ;;
esac; done

need curl; need jq
omb_check_auth
omb_check_build
FAIL=0

# 1) saúde do engine
omb_call GET /api/workflows/health "" 200
H="$OMB_BODY"
ok="$(printf '%s' "$H" | jq -r .ok)"
lag=$(( ( $(printf '%s' "$H" | jq -r .now) - $(printf '%s' "$H" | jq -r '.engine.lastTickAt // 0') ) / 1000 ))
printf '%s' "$H" | jq '{ok, version, engine, runs: {live: .runs.live, stuck: (.runs.stuck|length), preflight: (.runs.preflight|length)}, lastFailure, workflow: (.workflows[] | select(.id==$id) | {name, schedule, nextRunAt: (.nextRunAt // null | if . then (./1000|todate) else null end), liveRunId, lastRun, refusalStreak})}' --arg id "$WORKFLOW_ID"
if [[ "$ok" != "true" ]]; then warn "health.ok=false — há run(s) parados (runs.stuck)"; FAIL=1; fi
if (( lag > 60 )); then warn "último tick do engine há ${lag}s — reconciler encravado?"; FAIL=1; else log "engine: último tick há ${lag}s"; fi
printf '%s' "$H" | jq -e --arg id "$WORKFLOW_ID" '.workflows[] | select(.id==$id)' >/dev/null || die "workflow $WORKFLOW_ID não aparece no health"

# 2) pre-flight
log "POST /api/workflows/$WORKFLOW_ID/preflight (pode levar até timeoutSeconds + 7 s)"
omb_call POST "/api/workflows/$WORKFLOW_ID/preflight" "" 200
P="$OMB_BODY"
printf '%s' "$P" | jq -r '.preflight.checks[] | "  \(if .ok then "✔" else "✘" end) \(.name) [\(.kind)] \(.durationMs)ms — \(.detail)\(if (.ok|not) and (.stderr // "") != "" then "\n      stderr: " + .stderr else "" end)"'
if [[ "$(printf '%s' "$P" | jq -r .preflight.ok)" == "true" ]]; then log "pre-flight: todos ok"; else warn "pre-flight: há checks a falhar — um Run seria recusado no arranque (failed, sem gastar turno de bot)"; FAIL=1; fi

[[ $RUN -eq 1 ]] || { [[ $FAIL -eq 0 ]] && log "smoke OK" || die "smoke com falhas"; exit 0; }

# 3) run manual acompanhado
[[ $FAIL -eq 0 ]] || warn "prosseguindo com --run apesar das falhas acima"
omb_call POST "/api/workflows/$WORKFLOW_ID/runs" "$(jq -nc --arg i "$RUN_INPUT" 'if $i == "" then {} else {input:$i} end')" 201
RUN_ID="$(printf '%s' "$OMB_BODY" | jq -r .run.id)"
log "run $RUN_ID iniciado (status $(printf '%s' "$OMB_BODY" | jq -r .run.status)); acompanhando até ${MAX_MINUTES} min, a cada ${POLL_SECONDS}s"

seen=0; deadline=$(( $(date +%s) + MAX_MINUTES * 60 )); status=""
while :; do
  omb_call GET "/api/workflows/$WORKFLOW_ID/runs" "" 200
  R="$(printf '%s' "$OMB_BODY" | jq -c --arg id "$RUN_ID" '.runs[] | select(.id==$id)')"
  [[ -n "$R" ]] || die "run $RUN_ID desapareceu da lista"
  status="$(printf '%s' "$R" | jq -r .status)"
  n="$(printf '%s' "$R" | jq '.nodeResults|length')"
  if (( n > seen )); then
    printf '%s' "$R" | jq -r --argjson s "$seen" '.nodeResults[$s:][] | "  \(.startedAt/1000|strflocaltime("%H:%M:%S"))→\(.endedAt/1000|strflocaltime("%H:%M:%S"))  \(.nodeId)  [\(.outcome)]  \(.summary|.[0:120])\(if .fallback then "  (fallback: " + .fallback.botId[0:8] + ")" else "" end)\(if .denials then "\n      denials: " + (.denials|join(" | ")) else "" end)"'
    seen=$n
  fi
  line="$(printf '%s' "$R" | jq -r '"  … \(.status) @ \(.currentNodeId // "-")" + (if .preflightStartedAt then " (pre-flight em curso)" else "" end) + (if .waitUntil then " (wait até " + (.waitUntil/1000|strflocaltime("%H:%M")) + ")" else "" end) + (if .outage then " (outage: tentativa " + (.outage.attempts|tostring) + "/" + (.outage.of|tostring) + ")" else "" end) + (if .nextAttemptAt then " next " + (.nextAttemptAt/1000|strflocaltime("%H:%M:%S")) else "" end)')"
  case "$status" in
    completed|failed|cancelled) break ;;
  esac
  printf '%s\n' "$line" >&2
  if (( $(date +%s) >= deadline )); then
    warn "limite de ${MAX_MINUTES} min atingido; o run $RUN_ID continua vivo no servidor"
    if [[ $CANCEL_AT_END -eq 1 ]]; then omb_call POST "/api/workflow-runs/$RUN_ID/cancel" "" 200; log "run cancelado"; fi
    exit 2
  fi
  sleep "$POLL_SECONDS"
done

echo
printf '%s' "$R" | jq '{status, currentNodeId, error, startedAt: (.startedAt/1000|todate), endedAt: ((.endedAt // 0)/1000|todate), preflight: (.preflight | if . then {ok, checks: [.checks[] | "\(.name):\(if .ok then "ok" else "FAIL — " + .detail end)"]} else null end)}'
case "$status" in
  completed) log "run terminou: completed$( printf '%s' "$R" | jq -r 'if .error then " (" + .error + ")" else "" end')" ;;
  failed) die "run terminou: failed — $(printf '%s' "$R" | jq -r '.error // "?"')" ;;
  cancelled) warn "run cancelado" ;;
esac
