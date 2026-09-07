#!/usr/bin/env bash
# Funções partilhadas pelo kit autonomous-24-7. Fonte-a com `source lib.sh`.
# Nada aqui grava segredos: o token de sessão vem de $OMB_TOKEN ou do ficheiro
# $OMB_TOKEN_FILE (chmod 600), criado por omb-token.sh.
#
# ── Como um script no próprio Mac se autentica (server/request-auth.ts) ──
# 1. Servidor headless (`openmausbot serve`): a requisição de loopback sem
#    Origin é o dono (request-auth.ts:354-375, `loopbackMutationToken` é
#    undefined fora do desktop). Nenhum token é preciso.
# 2. Servidor embutido no app desktop empacotado: o Electron entrega ao
#    servidor um token aleatório por lançamento (electron/main.mjs:263,
#    server/index.ts:463-475) e TODA mutação sem o header
#    `x-openmausbot-desktop-owner` recebe 403 (request-auth.ts:367-373).
#    Um script não conhece esse token. A saída é uma SESSÃO pareada: um
#    bearer `omb_sess_…` (request-auth.ts:334-351) vence a regra de loopback
#    e carrega os escopos admin+client. Como obter: omb-token.sh.
# 3. Cookie: só o browser servido usa; não serve a scripts.

set -euo pipefail

OMB_URL="${OMB_URL:-http://127.0.0.1:8799}"
OMB_TOKEN_FILE="${OMB_TOKEN_FILE:-$HOME/.config/openmausbot-kit/token}"
OMB_TOKEN="${OMB_TOKEN:-}"

log()  { printf '%s\n' "▸ $*" >&2; }
warn() { printf '%s\n' "⚠ $*" >&2; }
die()  { printf '%s\n' "✖ $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "preciso de '$1' no PATH (brew install $1)"; }

# Carrega o token do ficheiro se não veio pelo ambiente.
omb_load_token() {
  if [[ -z "$OMB_TOKEN" && -r "$OMB_TOKEN_FILE" ]]; then
    OMB_TOKEN="$(tr -d '[:space:]' < "$OMB_TOKEN_FILE")"
  fi
}

# omb_api METHOD PATH [JSON_BODY] → preenche as globais OMB_STATUS e OMB_BODY.
# (Globais e não stdout: dentro de `$(…)` uma variável morre com o subshell.)
# Sem header Origin de propósito: com Origin não-loopback o servidor recusa
# (request-auth.ts:55-63); sem Origin, curl é um "non-browser client".
OMB_STATUS=""; OMB_BODY=""
omb_api() {
  local method="$1" path="$2" body="${3:-}" tmp
  tmp="$(mktemp)"
  local -a args=(-sS -o "$tmp" -w '%{http_code}' -X "$method" -H 'content-type: application/json')
  [[ -n "$OMB_TOKEN" ]] && args+=(-H "authorization: Bearer $OMB_TOKEN")
  [[ -n "$body" ]] && args+=(--data-binary "$body")
  OMB_STATUS="$(curl "${args[@]}" "$OMB_URL$path")" || { rm -f "$tmp"; die "curl falhou em $method $path (servidor no ar em $OMB_URL?)"; }
  OMB_BODY="$(cat "$tmp")"; rm -f "$tmp"
}

# omb_call METHOD PATH [BODY] EXPECTED_STATUS → como omb_api, mas aborta se o
# status não for o esperado, mostrando o {error} do servidor.
omb_call() {
  local method="$1" path="$2" body="$3" expected="$4"
  omb_api "$method" "$path" "$body"
  omb_expect "$expected" "$OMB_BODY" "$method $path"
}

# Aborta se o status não for o esperado, mostrando o corpo (o servidor sempre
# responde {error, details?}).
omb_expect() {
  local expected="$1" body="$2" what="$3"
  [[ "$OMB_STATUS" == "$expected" ]] || die "$what → HTTP $OMB_STATUS: $(printf '%s' "$body" | jq -r 'if type=="object" then ([.error] + (.details // []) | join("; ")) else . end' 2>/dev/null | head -c 800)"
}

# Verifica quem somos para o servidor e se podemos mutar.
#  - loopback no headless: {kind:"loopback"} e mutações passam.
#  - loopback no desktop: GET passa, mas PATCH dá 403 → precisa de token.
#  - sessão: {kind:"session", scopes:[...]} — exige "admin".
omb_check_auth() {
  omb_load_token
  omb_call GET /api/auth/session "" 200
  local body="$OMB_BODY"
  local kind; kind="$(printf '%s' "$body" | jq -r .kind)"
  if [[ "$kind" == "session" ]]; then
    printf '%s' "$body" | jq -e '.scopes | index("admin")' >/dev/null \
      || die "a sessão do token não tem escopo admin (foi cunhada com --client?); gere outra com omb-token.sh"
    log "auth: sessão pareada '$(printf '%s' "$body" | jq -r .label)' (admin) em $OMB_URL"
  else
    # Sonda barata de mutação: PATCH de um workflow inexistente. No headless
    # responde 404 (passou o gate); no desktop sem token responde 403.
    omb_api PATCH /api/workflows/__omb_kit_probe__ '{}'
    if [[ "$OMB_STATUS" == "403" ]]; then
      die "este servidor é o do app desktop: mutações exigem sessão pareada. Rode ./omb-token.sh (ver README §2) e exporte OMB_TOKEN ou deixe o ficheiro $OMB_TOKEN_FILE"
    fi
    log "auth: loopback é o dono (servidor headless) em $OMB_URL"
  fi
}

# Exige que o servidor seja a build com os itens A–H: a rota
# GET /api/workflows/health só existe nela (workflow-api.ts:643).
omb_check_build() {
  omb_api GET /api/workflows/health
  [[ "$OMB_STATUS" == "200" ]] || die "GET /api/workflows/health → $OMB_STATUS: este servidor não é a build com os itens A–H (ver README §1)"
  log "build: versão $(printf '%s' "$OMB_BODY" | jq -r .version), engine lastTickAt=$(printf '%s' "$OMB_BODY" | jq -r '.engine.lastTickAt')"
}

# Roster de bots (GET /api/bots?messages=0 — index.ts:9341). Cacheado em BOTS_JSON.
omb_load_bots() {
  omb_call GET '/api/bots?messages=0' "" 200
  BOTS_JSON="$OMB_BODY"
}

# omb_bot_id PREFIXO_OU_ID → id completo (o brief só dá os 8 primeiros hex).
omb_bot_id() {
  local prefix="$1" ids
  ids="$(printf '%s' "$BOTS_JSON" | jq -r --arg p "$prefix" '.bots[] | select(.id | startswith($p)) | .id')"
  [[ -n "$ids" ]] || die "nenhum bot com id a começar por '$prefix'"
  [[ "$(printf '%s\n' "$ids" | wc -l | tr -d ' ')" == "1" ]] || die "prefixo '$prefix' é ambíguo: $ids"
  printf '%s' "$ids"
}

# omb_bot_field ID CAMPO_JQ
omb_bot_field() { printf '%s' "$BOTS_JSON" | jq -r --arg id "$1" ".bots[] | select(.id==\$id) | $2"; }

# omb_group_id_by_name NOME → id da sala ou vazio.
omb_group_id_by_name() {
  printf '%s' "$BOTS_JSON" | jq -r --arg n "$1" '[.groups[]? | select(.name==$n) | .id] | first // empty'
}

# Workflow por id (não há GET /api/workflows/:id — workflow-api.ts:654-659
# só aceita PATCH/DELETE nessa rota; a leitura é a lista, :634-637).
omb_get_workflow() {
  local id="$1"
  omb_call GET /api/workflows "" 200
  printf '%s' "$OMB_BODY" | jq -e --arg id "$id" '.workflows[] | select(.id==$id)' \
    || die "workflow $id não existe neste servidor (data dir errado? ver README §1)"
}

omb_timestamp() { date +%Y%m%d-%H%M%S; }
