#!/usr/bin/env bash
# Restaura um workflow a partir de um backup-<timestamp>.json gerado por
# apply-workflow.sh. Envia PATCH com TODOS os campos do modelo
# (workflow-api.ts:188-209): os que o backup não tem vão como `null`, que
# limpa os campos de CLEARABLE_FIELDS (:303-312). Campos do engine
# (nextRunAt, refusalStreak, lastDigestAt, issues, id, createdAt, updatedAt)
# são ignorados pelo zod (objeto não-estrito), por isso não vão no corpo.
#
# Uso: ./revert-workflow.sh backup-20260907-101500.json [WORKFLOW_ID]

set -euo pipefail
# Resolve o backup ANTES de mudar de pasta (os backups vivem na pasta do kit,
# mas o operador pode passar um caminho relativo à sua própria).
BACKUP="${1:-}"
[[ -n "$BACKUP" && -r "$BACKUP" ]] || { printf '%s\n' "uso: $0 backup-<timestamp>.json [WORKFLOW_ID]" >&2; exit 1; }
BACKUP="$(cd "$(dirname "$BACKUP")" && pwd)/$(basename "$BACKUP")"
cd "$(dirname "$0")"
source ./lib.sh

need curl; need jq
WORKFLOW_ID="${2:-$(jq -r .id "$BACKUP")}"

omb_check_auth

PATCH="$(jq -c '{
  name, description: (.description // null), entryNodeId, nodes, edges, layout,
  triggers: (.triggers // null),
  maxNodeExecutions: (.maxNodeExecutions // null),
  providerOutage: (.providerOutage // null),
  stuckAfterMinutes: (.stuckAfterMinutes // null),
  auditGroupId: (.auditGroupId // null),
  digestAt: (.digestAt // null),
  preflight: (.preflight // null)
}' "$BACKUP")"

log "restaurando $WORKFLOW_ID a partir de $BACKUP"
omb_call PATCH "/api/workflows/$WORKFLOW_ID" "$PATCH" 200
printf '%s' "$OMB_BODY" | jq '{name: .workflow.name, schedule: .workflow.triggers.schedule, nodes: (.workflow.nodes|length), edges: (.workflow.edges|length), issues: [.workflow.issues[] | .code]}'
log "restaurado. Runs em curso não são cancelados por isto; cancele-os no app se necessário."
