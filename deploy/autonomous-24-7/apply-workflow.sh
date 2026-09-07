#!/usr/bin/env bash
# Reconfigura o workflow "Entrega contínua · nuria-platform" para operação
# contínua 24/7, via PATCH /api/workflows/:id (server/workflow-api.ts:396-409).
# Idempotente: lê o estado atual, calcula o estado desejado e aplica; rodar
# duas vezes produz o mesmo resultado. Faz backup antes de escrever.
#
# O que muda (e só isto — instructions, botId, timeouts, retries, requires e
# outcomes dos nós NÃO são tocados):
#   (a) trigger interval + activeHours      (b) maxNodeExecutions
#   (c) nó wait "pausa" e o ciclo            (d) alwaysAllow por nó
#   (e) aprovacao-merge: renotify            (f) fallbackBotId
#   (g) stuckAfterMinutes, digestAt, auditGroupId (opcional)
#   (h) preflight.checks
#
# Formato do corpo: schema zod em workflow-api.ts:73-209 (nós :73-122,
# triggers :125-149, preflight :161-186, topo :188-209). `store.update`
# é um spread raso (workflow-store.ts:127-137): `nodes`, `edges` e `layout`
# vão completos; campos ausentes ficam como estão; `null` limpa só os de
# CLEARABLE_FIELDS (:303-312).

set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

# ── Variáveis do operador ──────────────────────────────────────────────────
WORKFLOW_ID="${WORKFLOW_ID:-eb42a861-2e2a-414e-b2ef-606ec89ce2ad}"
REPO_DIR="${REPO_DIR:-/Users/osvaldo/Projetos/nuria-platform}"
PROJECT_NUMBER="${PROJECT_NUMBER:-10}"
PROJECT_OWNER="${PROJECT_OWNER:-dinhogehm}"

# (a) trigger — schema: interval.minutes inteiro ≥5 (WORKFLOW_INTERVAL_MINUTES_MIN),
#     activeHours {start,end HH:MM, weekdays 0=dom..6=sáb}. Avaliado no fuso do Mac.
INTERVAL_MINUTES="${INTERVAL_MINUTES:-60}"
ACTIVE_START="${ACTIVE_START:-07:00}"
ACTIVE_END="${ACTIVE_END:-23:00}"
ACTIVE_WEEKDAYS="${ACTIVE_WEEKDAYS:-1,2,3,4,5,6}"     # seg–sáb

# (b) cap de passos de bot por run — validado 1..1000 (shared/workflow.ts:22-23).
#     Só nós agent/approval contam; wait/notify são grátis (plano, item D §3).
MAX_NODE_EXECUTIONS="${MAX_NODE_EXECUTIONS:-60}"

# (c) ciclo. Wait entre "sem demanda" e a próxima triagem (1..1440 min).
PAUSE_NODE_ID="${PAUSE_NODE_ID:-pausa}"
PAUSE_MINUTES="${PAUSE_MINUTES:-30}"
# Volta após uma entrega. update-canal é um nó AGENT (não notify): uma aresta
# direta agent→entry faz o cap terminar o run como `failed` (plano D §3 "What
# happens at the cap"). Um wait de 1 min no meio faz o cap fechar a volta
# como `completed` e apaga o aviso `cycle-without-wait`. 0 = aresta direta
# update-canal:avisado→triagem, exatamente como o brief pediu.
DELIVERY_PAUSE_MINUTES="${DELIVERY_PAUSE_MINUTES:-1}"
DELIVERY_PAUSE_NODE_ID="${DELIVERY_PAUSE_NODE_ID:-pausa-entrega}"

# (e) aprovação humana — onExpire enum (workflow-api.ts:103), maxRenotify 1..30.
APPROVAL_EXPIRES_HOURS="${APPROVAL_EXPIRES_HOURS:-12}"
APPROVAL_MAX_RENOTIFY="${APPROVAL_MAX_RENOTIFY:-5}"

# (f) fallbacks (prefixo do id ou vazio para não configurar). Só nós SEM
#     `requires`: revisao/merge exigem canMerge, deploy/rollback canDeploy, e
#     os bots Claude não têm essas flags → `fallback-missing-capability`
#     (aviso) e o engine simplesmente ignora o fallback (plano B §3). Não
#     vale a pena configurar o que nunca dispara.
FALLBACK_CODIFICACAO="${FALLBACK_CODIFICACAO:-52904419}"   # Rigel (claude)
FALLBACK_TESTES_PRE="${FALLBACK_TESTES_PRE:-011e490c}"     # Pixel (claude)
FALLBACK_SPEC="${FALLBACK_SPEC:-f9f6b7f8}"                 # Ada (claude)

# (g) monitorização — stuckAfterMinutes 10..1440; digestAt HH:MM local.
STUCK_AFTER_MINUTES="${STUCK_AFTER_MINUTES:-120}"
DIGEST_AT="${DIGEST_AT:-18:00}"
# Sala de auditoria: cole o id, ou deixe AUDIT_GROUP_NAME e o script procura
# uma sala com esse nome. Vazio nos dois = não mexe no campo.
AUDIT_GROUP_ID="${AUDIT_GROUP_ID:-}"
AUDIT_GROUP_NAME="${AUDIT_GROUP_NAME:-pipeline}"

# (h) pre-flight — timeoutSeconds 5..300; bots-ready waitMinutes 0..120.
PREFLIGHT_TIMEOUT_SECONDS="${PREFLIGHT_TIMEOUT_SECONDS:-90}"
BOTS_WAIT_MINUTES="${BOTS_WAIT_MINUTES:-15}"

DRY_RUN="${DRY_RUN:-0}"   # 1 = mostra o PATCH e não aplica
# ───────────────────────────────────────────────────────────────────────────

need curl; need jq
omb_check_auth
omb_check_build
omb_load_bots

# (d) Chaves de always-allow por nó. VERIFICADO em server/auto-approve.ts:
#   • approvalKey (:124-132) = `${tool}:${programa}` para ferramentas de
#     comando (COMMAND_TOOLS :86 — bash, shell, …), senão o nome puro.
#   • O driver Codex nomeia comandos como "shell" e edições como "edit"
#     (server/drivers/codex.ts:702-713) → num turno Codex a chave é
#     `shell:gh`, nunca `Bash:gh`. `Bash:gh` é o nome do driver Claude.
#     Os `Bash:*` já nos bots Codex do usuário NUNCA disparam num turno
#     Codex — é uma das causas dos cartões sem dono. Por isso cada nó
#     recebe as DUAS grafias: `shell:X` (bot Codex) e `Bash:X` (bot Claude
#     de fallback, que corre sob a união bot ∪ nó — effectiveAlwaysAllow
#     :335-343 e a lista do nó é enviada em todo dispatch).
#   • `edit` é BLIND_EDIT_TOOLS (:99) e só é honrado unattended quando o NÓ
#     o declara (:303-307, unattendedHonoredGrants :353-373) — é o caso aqui.
#   • `session_search`/`list_bots` são chaves MCP de nome puro (:292).
#   • O validador (bad-always-allow, shared/workflow.ts:824) só recusa
#     brancos, espaços nas pontas e repetidos.
keys() {  # keys "gh git jq" [extras...] → JSON array
  local progs="$1"; shift
  local -a out=()
  for p in $progs; do out+=("shell:$p" "Bash:$p"); done
  for e in "$@"; do out+=("$e"); done
  printf '%s\n' "${out[@]}" | jq -R . | jq -sc .
}
ALLOW_TRIAGEM="$(keys "gh git jq" session_search list_bots)"
ALLOW_SPEC="$(keys "gh git rg cat" session_search)"
ALLOW_COD="$(keys "gh git pnpm node npx" session_search edit)"
ALLOW_TESTES="$(keys "pnpm node npx gh git")"
ALLOW_MERGE="$(keys "gh git")"
ALLOW_DEPLOY="$(keys "pnpm git gh cat")"
ALLOW_DOC="$(keys "git gh" edit)"

ALLOW_MAP="$(jq -nc \
  --argjson t "$ALLOW_TRIAGEM" --argjson s "$ALLOW_SPEC" --argjson c "$ALLOW_COD" \
  --argjson q "$ALLOW_TESTES" --argjson m "$ALLOW_MERGE" --argjson d "$ALLOW_DEPLOY" --argjson o "$ALLOW_DOC" '
  { triagem:$t, "update-canal":$t, "sem-demanda":$t, "avisar-falha":$t,
    spec:$s, codificacao:$c, "testes-pre":$q, "testes-prod":$q,
    revisao:$m, merge:$m, deploy:$d, rollback:$d, doc:$o }')"

# (f) resolve prefixos → ids completos e confere engine diferente do primário.
resolve_fallback() {  # resolve_fallback NODE PREFIX → id ou vazio
  local node="$1" prefix="$2"
  [[ -n "$prefix" ]] || { printf ''; return; }
  local id; id="$(omb_bot_id "$prefix")"
  local primary; primary="$(printf '%s' "$WF" | jq -r --arg n "$node" '.nodes[] | select(.id==$n) | .botId')"
  local e1 e2
  e1="$(omb_bot_field "$primary" '.modelSelection.instanceId')"
  e2="$(omb_bot_field "$id" '.modelSelection.instanceId')"
  if [[ "$e1" == "$e2" ]]; then
    warn "fallback de $node ($(omb_bot_field "$id" .name)) tem a MESMA engine ($e2) do primário; o engine nunca o usará (fallbackEligible). Ignorado."
    printf ''; return
  fi
  local cwd; cwd="$(omb_bot_field "$id" '.cwd // ""')"
  [[ "$cwd" == "$REPO_DIR" ]] || warn "fallback $(omb_bot_field "$id" .name) tem cwd='${cwd:-<nenhum>}' e não '$REPO_DIR' — corrija no app (ou ./apply-bots.sh --fallback-cwd)"
  printf '%s' "$id"
}

log "lendo o workflow $WORKFLOW_ID"
WF="$(omb_get_workflow "$WORKFLOW_ID")"
NAME="$(printf '%s' "$WF" | jq -r .name)"
log "workflow: \"$NAME\" (entry $(printf '%s' "$WF" | jq -r .entryNodeId), $(printf '%s' "$WF" | jq '.nodes|length') nós, $(printf '%s' "$WF" | jq '.edges|length') arestas)"

# Sanidade do grafo que o brief descreve.
for n in triagem sem-demanda update-canal avisar-falha aprovacao-merge; do
  printf '%s' "$WF" | jq -e --arg n "$n" '.nodes[] | select(.id==$n)' >/dev/null || die "nó '$n' não existe no workflow; este script foi escrito para o grafo do brief"
done
printf '%s' "$WF" | jq -e '.nodes[] | select(.id=="sem-demanda") | .outcomes | index("ok")' >/dev/null || die "sem-demanda não tem outcome 'ok'"
printf '%s' "$WF" | jq -e '.nodes[] | select(.id=="update-canal") | .outcomes | index("avisado")' >/dev/null || die "update-canal não tem outcome 'avisado'"

FB_COD="$(resolve_fallback codificacao "$FALLBACK_CODIFICACAO")"
FB_TESTES="$(resolve_fallback testes-pre "$FALLBACK_TESTES_PRE")"
FB_SPEC="$(resolve_fallback spec "$FALLBACK_SPEC")"
FALLBACK_MAP="$(jq -nc --arg c "$FB_COD" --arg t "$FB_TESTES" --arg s "$FB_SPEC" \
  '{codificacao:$c, "testes-pre":$t, spec:$s} | with_entries(select(.value != ""))')"

# (g) sala de auditoria
if [[ -z "$AUDIT_GROUP_ID" && -n "$AUDIT_GROUP_NAME" ]]; then
  AUDIT_GROUP_ID="$(omb_group_id_by_name "$AUDIT_GROUP_NAME")"
  [[ -n "$AUDIT_GROUP_ID" ]] && log "sala \"$AUDIT_GROUP_NAME\" → $AUDIT_GROUP_ID" || warn "nenhuma sala chamada \"$AUDIT_GROUP_NAME\"; auditGroupId fica como está (crie a sala no app e rode de novo)"
fi

WEEKDAYS_JSON="$(printf '%s' "$ACTIVE_WEEKDAYS" | tr ',' '\n' | jq -R 'tonumber' | jq -sc .)"

CFG="$(jq -nc \
  --arg repo "$REPO_DIR" --arg owner "$PROJECT_OWNER" --arg project "$PROJECT_NUMBER" \
  --argjson interval "$INTERVAL_MINUTES" --arg start "$ACTIVE_START" --arg end "$ACTIVE_END" --argjson weekdays "$WEEKDAYS_JSON" \
  --argjson cap "$MAX_NODE_EXECUTIONS" \
  --arg pauseId "$PAUSE_NODE_ID" --argjson pause "$PAUSE_MINUTES" \
  --arg dpauseId "$DELIVERY_PAUSE_NODE_ID" --argjson dpause "$DELIVERY_PAUSE_MINUTES" \
  --argjson expires "$APPROVAL_EXPIRES_HOURS" --argjson renotify "$APPROVAL_MAX_RENOTIFY" \
  --argjson allow "$ALLOW_MAP" --argjson fallback "$FALLBACK_MAP" \
  --argjson stuck "$STUCK_AFTER_MINUTES" --arg digest "$DIGEST_AT" --arg audit "$AUDIT_GROUP_ID" \
  --argjson pfTimeout "$PREFLIGHT_TIMEOUT_SECONDS" --argjson botsWait "$BOTS_WAIT_MINUTES" \
  '$ARGS.named')"

# ── O PATCH, calculado a partir do estado atual ────────────────────────────
PATCH="$(printf '%s' "$WF" | jq -c --argjson cfg "$CFG" '
  def entry: .entryNodeId;
  # nós: mantém tudo, altera só os campos listados
  def agent_patch:
    if .kind == "agent" then
      (if $cfg.allow[.id] then .alwaysAllow = $cfg.allow[.id] else . end)
      | (if $cfg.fallback[.id] then .fallbackBotId = $cfg.fallback[.id] else . end)
    elif .kind == "approval" and .id == "aprovacao-merge" then
      .onExpire = "renotify" | .maxRenotify = $cfg.renotify | .expiresHours = $cfg.expires
    else . end;
  def without_ids($ids): map(select(.id as $i | ($ids | index($i)) | not));
  def wait_node($id; $m): {kind:"wait", id:$id, minutes:$m};
  # arestas que este script possui: as que saem dos sinks do ciclo e dos waits
  def owned_edge: (.from == "sem-demanda" and .outcome == "ok")
               or (.from == "update-canal" and .outcome == "avisado")
               or (.from == $cfg.pauseId) or (.from == $cfg.dpauseId);
  . as $wf
  | ($wf.layout["sem-demanda"] // $wf.layout[entry] // {x:0,y:0}) as $anchor
  | ($cfg.dpause > 0) as $useDpause
  | {
      triggers: { schedule: { type:"interval", minutes:$cfg.interval,
                              activeHours:{ start:$cfg.start, end:$cfg.end, weekdays:$cfg.weekdays } } },
      maxNodeExecutions: $cfg.cap,
      nodes: ( ($wf.nodes | without_ids([$cfg.pauseId, $cfg.dpauseId]) | map(agent_patch))
               + [ wait_node($cfg.pauseId; $cfg.pause) ]
               + (if $useDpause then [ wait_node($cfg.dpauseId; $cfg.dpause) ] else [] end) ),
      edges: ( ($wf.edges | map(select(owned_edge | not)))
               + [ {from:"sem-demanda", outcome:"ok", to:$cfg.pauseId},
                   {from:$cfg.pauseId, outcome:"elapsed", to:entry} ]
               + (if $useDpause
                  then [ {from:"update-canal", outcome:"avisado", to:$cfg.dpauseId},
                         {from:$cfg.dpauseId, outcome:"elapsed", to:entry} ]
                  else [ {from:"update-canal", outcome:"avisado", to:entry} ] end) ),
      layout: ( $wf.layout
                | del(.[$cfg.dpauseId])
                | (if .[$cfg.pauseId] then . else .[$cfg.pauseId] = {x:$anchor.x, y:($anchor.y + 160)} end)
                | (if $useDpause then .[$cfg.dpauseId] = ($wf.layout[$cfg.dpauseId] // {x:($anchor.x + 260), y:($anchor.y + 160)}) else . end) ),
      stuckAfterMinutes: $cfg.stuck,
      digestAt: $cfg.digest,
      preflight: {
        timeoutSeconds: $cfg.pfTimeout,
        checks: [
          {kind:"command", name:"gh auth",    command:"gh auth status"},
          {kind:"command", name:"repo limpo", command:("git -C " + $cfg.repo + " status --porcelain"), expectStdoutMatch:"^$"},
          {kind:"command", name:"board",      command:("gh project view " + $cfg.project + " --owner " + $cfg.owner + " --format json")},
          {kind:"bots-ready", name:"bots", waitMinutes:$cfg.botsWait}
        ]
      }
    }
  | (if $cfg.audit != "" then .auditGroupId = $cfg.audit else . end)
')"

# Backup do estado atual, sempre (é o que `reverter` no README usa).
BACKUP="./backup-$(omb_timestamp).json"
printf '%s\n' "$WF" | jq . > "$BACKUP"
log "backup em $BACKUP"

if [[ "$DRY_RUN" == "1" ]]; then
  printf '%s\n' "$PATCH" | jq .
  log "DRY_RUN=1: nada aplicado"
  exit 0
fi

log "aplicando PATCH /api/workflows/$WORKFLOW_ID"
omb_call PATCH "/api/workflows/$WORKFLOW_ID" "$PATCH" 200
RESP="$OMB_BODY"

# O PATCH é 200 mesmo com issues (workflow-api.ts:393-395); a execução é que
# é recusada. Mostra-as: erros bloqueiam o Run, avisos não.
ISSUES="$(printf '%s' "$RESP" | jq -c '.workflow.issues')"
ERRS="$(printf '%s' "$ISSUES" | jq '[.[] | select(.severity=="error")] | length')"
log "issues após o PATCH: $(printf '%s' "$ISSUES" | jq 'length') (erros: $ERRS)"
printf '%s' "$ISSUES" | jq -r '.[] | "  [\(.severity)] \(.code)\(if .nodeId then " @" + .nodeId else "" end): \(.message)"' >&2
[[ "$ERRS" == "0" ]] || warn "há erros de validação — o engine vai recusar o Run até serem corrigidos (o backup está em $BACKUP)"

echo
log "estado atual (GET /api/workflows → este id):"
omb_get_workflow "$WORKFLOW_ID" | jq '{name, entryNodeId, triggers, maxNodeExecutions, stuckAfterMinutes, digestAt, auditGroupId, preflight,
  nodes: [.nodes[] | {id, kind, minutes, alwaysAllow, fallbackBotId, onExpire, maxRenotify, expiresHours} | with_entries(select(.value != null))],
  edges: [.edges[] | "\(.from):\(.outcome)→\(.to)"]}'
echo
log "GET /api/workflows/health:"
omb_call GET /api/workflows/health "" 200; printf '%s' "$OMB_BODY" | jq .

cat >&2 <<EOF

Próximos passos:
  • O trigger interval arma a próxima run em (fim da última run + ${INTERVAL_MINUTES} min), movida
    para a janela ${ACTIVE_START}–${ACTIVE_END}; não há run imediata. Para testar já: ./smoke.sh --run
  • Reverter: ./revert-workflow.sh $BACKUP   (ver README §5)
EOF
