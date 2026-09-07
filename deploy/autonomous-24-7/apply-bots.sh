#!/usr/bin/env bash
# Cria bots DEDICADOS ao pipeline clonando os partilhados com o Chief of Staff
# "CEO": Eng Core → "Eng Core · pipeline", QA → "QA · pipeline",
# SRE → "SRE · pipeline", Merge → "Merge · pipeline". Copia engine/modelo,
# cwd, alwaysAllow, canMerge/canDeploy, approvalMode (ask|auto), soul, title,
# description, section, computer e browser. Idempotente: um clone que já
# existe (mesmo nome) é reutilizado e re-sincronizado.
#
# Porquê: o engine trata "bot ocupado" como contenção — o run fica estacionado
# até o bot ficar livre (plano, item B; `activeRunForBot`, re-park de 30 s) e
# o pre-flight `bots-ready` espera até BOTS_WAIT_MINUTES. Um bot que o CEO usa
# em conversas/rotinas rouba o slot do pipeline a qualquer hora. Bots
# dedicados eliminam essa contenção (o CEO continua com os originais).
#
# Rotas (server/index.ts):
#   POST  /api/bots        :10540-10587 — só name/title/description/section/
#                           modelSelection {instanceId, model, effort?}
#   PATCH /api/bots/:id    :10706-11070 — cwd (:10849), alwaysAllow (:10984),
#                           canMerge/canDeploy (:10921), approvalMode (:10864;
#                           full/custom só do desktop, :10903-10911), soul via
#                           parseBotProfilePatch (server/bot-profile.ts),
#                           computer (:10776), browser (:10812), section.
#   Regra de "loosening" (:10990-11026): sem sessão pareada e sem Origin, um
#   PATCH que ALARGA alwaysAllow/peers só passa com TODOS os bots ociosos
#   (409 caso contrário). Com sessão (omb-token.sh) não há essa barreira.
#
# Uso:
#   ./apply-bots.sh                  # cria/sincroniza os clones e imprime os ids
#   ./apply-bots.sh --rewire         # e re-aponta os nós do workflow para eles
#   ./apply-bots.sh --fallback-cwd   # e dá cwd=REPO_DIR aos bots Claude de fallback
#   ./apply-bots.sh --dry-run

set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

# ── Variáveis do operador ──────────────────────────────────────────────────
WORKFLOW_ID="${WORKFLOW_ID:-eb42a861-2e2a-414e-b2ef-606ec89ce2ad}"
REPO_DIR="${REPO_DIR:-/Users/osvaldo/Projetos/nuria-platform}"
SUFFIX="${SUFFIX:- · pipeline}"
# prefixo do id de origem → nós do workflow que passam a usar o clone
SRC_ENG_CORE="${SRC_ENG_CORE:-ceb18a56}";  NODES_ENG_CORE="codificacao"
SRC_QA="${SRC_QA:-fcb1f903}";              NODES_QA="testes-pre testes-prod"
SRC_SRE="${SRC_SRE:-c6f38be5}";            NODES_SRE="deploy rollback"
SRC_MERGE="${SRC_MERGE:-603790bf}";        NODES_MERGE="revisao merge"
# bots Claude de fallback (só para --fallback-cwd)
FALLBACK_BOTS="${FALLBACK_BOTS:-52904419 011e490c f9f6b7f8 abb9b772}"   # Rigel Pixel Ada Lin
# ───────────────────────────────────────────────────────────────────────────

REWIRE=0; FALLBACK_CWD=0; DRY=0
for a in "$@"; do case "$a" in
  --rewire) REWIRE=1 ;; --fallback-cwd) FALLBACK_CWD=1 ;; --dry-run) DRY=1 ;;
  -h|--help) sed -n 2,32p "$0"; exit 0 ;; *) die "argumento desconhecido: $a" ;;
esac; done

need curl; need jq
omb_check_auth
omb_check_build
omb_load_bots

busy="$(printf '%s' "$BOTS_JSON" | jq -r '[.bots[] | select(.busy==true) | .name] | join(", ")')"
[[ -z "$busy" ]] || warn "bots ocupados agora: $busy — sem sessão pareada, o PATCH de alwaysAllow devolve 409 até ficarem ociosos"

# clone_bot PREFIXO → imprime o id do clone
clone_bot() {
  local src; src="$(omb_bot_id "$1")"
  local srcJson; srcJson="$(printf '%s' "$BOTS_JSON" | jq -c --arg id "$src" '.bots[] | select(.id==$id)')"
  local name; name="$(printf '%s' "$srcJson" | jq -r .name)"
  local clone="$name$SUFFIX"
  local mode; mode="$(printf '%s' "$srcJson" | jq -r '.approvalMode // (if .autoApprove==true then "auto" else "ask" end)')"

  # 1) criar (ou reutilizar)
  local id; id="$(printf '%s' "$BOTS_JSON" | jq -r --arg n "$clone" '[.bots[] | select(.name==$n) | .id] | first // empty')"
  local create; create="$(printf '%s' "$srcJson" | jq -c --arg n "$clone" '{name:$n, title, description, section, modelSelection} | with_entries(select(.value != null))')"
  if [[ -n "$id" ]]; then
    log "\"$clone\" já existe ($id); re-sincronizando"
  elif [[ $DRY -eq 1 ]]; then
    log "[dry-run] POST /api/bots $create"; id="<novo>"
  else
    omb_call POST /api/bots "$create" 201
    id="$(printf '%s' "$OMB_BODY" | jq -r .bot.id)"
    log "criado \"$clone\" → $id"
  fi

  # 2) sincronizar permissões e ambiente. full/custom não podem ser pedidos
  #    fora do desktop (index.ts:10903-10911): nesse caso deixa em ask e avisa.
  local patch; patch="$(printf '%s' "$srcJson" | jq -c --arg mode "$mode" --arg cwd "$REPO_DIR" '
    { cwd: (.cwd // $cwd), alwaysAllow: (.alwaysAllow // []),
      canMerge: (.canMerge == true), canDeploy: (.canDeploy == true),
      soul, computer, browser, composio }
    | with_entries(select(.value != null))
    | (if ($mode == "ask" or $mode == "auto") then .approvalMode = $mode else . end)')"
  [[ "$mode" == "ask" || "$mode" == "auto" ]] || warn "\"$name\" está em approvalMode=$mode; o clone fica em ask (só o app desktop pode dar $mode)"
  if [[ $DRY -eq 1 ]]; then
    log "[dry-run] PATCH /api/bots/$id $patch"
  else
    omb_call PATCH "/api/bots/$id" "$patch" 200
    log "  $(printf '%s' "$OMB_BODY" | jq -r '.bot | "engine=\(.modelSelection.instanceId)/\(.modelSelection.model) cwd=\(.cwd // "-") canMerge=\(.canMerge) canDeploy=\(.canDeploy) alwaysAllow=\(.alwaysAllow // [] | length) chaves"')"
  fi
  printf '%s' "$id"
}

declare -A CLONE
CLONE[eng]="$(clone_bot "$SRC_ENG_CORE")"
CLONE[qa]="$(clone_bot "$SRC_QA")"
CLONE[sre]="$(clone_bot "$SRC_SRE")"
CLONE[merge]="$(clone_bot "$SRC_MERGE")"

echo
log "ids dos bots dedicados:"
printf '  ENG_CORE_PIPELINE=%s\n  QA_PIPELINE=%s\n  SRE_PIPELINE=%s\n  MERGE_PIPELINE=%s\n' "${CLONE[eng]}" "${CLONE[qa]}" "${CLONE[sre]}" "${CLONE[merge]}"

if [[ $FALLBACK_CWD -eq 1 ]]; then
  for p in $FALLBACK_BOTS; do
    fid="$(omb_bot_id "$p")"
    if [[ $DRY -eq 1 ]]; then log "[dry-run] PATCH /api/bots/$fid {cwd:$REPO_DIR}"; continue; fi
    omb_call PATCH "/api/bots/$fid" "$(jq -nc --arg c "$REPO_DIR" '{cwd:$c}')" 200
    log "fallback $(printf '%s' "$OMB_BODY" | jq -r .bot.name): cwd=$REPO_DIR"
  done
fi

if [[ $REWIRE -eq 1 ]]; then
  [[ $DRY -eq 0 ]] || die "--rewire não combina com --dry-run"
  WF="$(omb_get_workflow "$WORKFLOW_ID")"
  MAP="$(jq -nc --arg e "${CLONE[eng]}" --arg q "${CLONE[qa]}" --arg s "${CLONE[sre]}" --arg m "${CLONE[merge]}" \
    --arg ne "$NODES_ENG_CORE" --arg nq "$NODES_QA" --arg ns "$NODES_SRE" --arg nm "$NODES_MERGE" '
    [ ($ne|split(" ")[] | {key:., value:$e}), ($nq|split(" ")[] | {key:., value:$q}),
      ($ns|split(" ")[] | {key:., value:$s}), ($nm|split(" ")[] | {key:., value:$m}) ] | from_entries')"
  # Só `nodes` no PATCH (spread raso, workflow-store.ts:131): o resto fica.
  PATCH="$(printf '%s' "$WF" | jq -c --argjson map "$MAP" '{nodes: (.nodes | map(if .kind=="agent" and $map[.id] then .botId = $map[.id] else . end))}')"
  BACKUP="./backup-$(omb_timestamp).json"; printf '%s\n' "$WF" | jq . > "$BACKUP"; log "backup do workflow em $BACKUP"
  omb_call PATCH "/api/workflows/$WORKFLOW_ID" "$PATCH" 200
  log "nós re-apontados: $(printf '%s' "$MAP" | jq -r 'keys | join(", ")')"
  printf '%s' "$OMB_BODY" | jq -r '.workflow.issues[] | "  [\(.severity)] \(.code)\(if .nodeId then " @" + .nodeId else "" end): \(.message)"' >&2
  printf '%s' "$OMB_BODY" | jq -e '[.workflow.issues[] | select(.severity=="error")] | length == 0' >/dev/null \
    || warn "há erros de validação (ex.: um clone sem canMerge/canDeploy) — o Run será recusado; reverta com ./revert-workflow.sh $BACKUP"
else
  cat >&2 <<EOF

Para apontar o workflow para estes bots: ./apply-bots.sh --rewire
(codificacao→Eng Core·pipeline, testes-pre/testes-prod→QA·pipeline,
 deploy/rollback→SRE·pipeline, revisao/merge→Merge·pipeline). Os originais
 continuam com o CEO; o pipeline deixa de disputar bots com ele.
EOF
fi
