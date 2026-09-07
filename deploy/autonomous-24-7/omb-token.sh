#!/usr/bin/env bash
# Troca um código de pareamento por um token de sessão `omb_sess_…` e o guarda
# em $OMB_TOKEN_FILE (chmod 600). Necessário SÓ quando o servidor é o do app
# desktop empacotado (ver lib.sh, cabeçalho). Num servidor headless este
# script continua a funcionar, mas é dispensável.
#
# Uso:
#   ./omb-token.sh XXXX-XXXX-XXXX          # código já cunhado
#   ./omb-token.sh --mint [--label NOME]   # cunha E troca (só funciona onde o
#                                          # loopback é dono: servidor headless)
#
# De onde vem o código:
#  • Servidor headless:  `openmausbot pair --label omb-kit` (server/cli.ts:242)
#                        ou este script com --mint (POST /api/auth/pairing,
#                        index.ts:8053).
#  • App desktop: `openmausbot pair` recebe 403 (POST /api/auth/pairing é uma
#    mutação pública sem o header de owner, request-auth.ts:296-312). O único
#    cliente que carrega esse header é a janela do app (o Electron injeta-o em
#    toda requisição do renderer ao servidor, electron/main.mjs:890-910).
#    Logo: no app, menu View → Toggle Developer Tools → Console, e cole:
#
#      fetch('/api/auth/pairing',{method:'POST',headers:{'content-type':'application/json'},
#        body:JSON.stringify({label:'omb-kit'})}).then(r=>r.json()).then(j=>console.log(j.code))
#
#    Copie o código impresso (XXXX-XXXX-XXXX; vale 5 min, uso único,
#    server/sessions.ts) e rode `./omb-token.sh XXXX-XXXX-XXXX`.
#
# A troca (POST /api/auth/pair, index.ts:7983-8007) é pública por desenho: a
# posse do código de uso único é a autorização. Sem `scopes` o pareamento é
# admin+client (sessions.ts openPairing; ver plano, item C "Scope").

set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

need curl; need jq
LABEL="omb-kit"
CODE=""
MINT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mint) MINT=1 ;;
    --label) LABEL="$2"; shift ;;
    -h|--help) sed -n 2,30p "$0"; exit 0 ;;
    *) CODE="$1" ;;
  esac
  shift
done

if [[ $MINT -eq 1 ]]; then
  # Sem token: a cunhagem tem de passar como loopback-dono (headless).
  OMB_TOKEN=""
  omb_api POST /api/auth/pairing "$(jq -nc --arg l "$LABEL" '{label:$l}')"
  [[ "$OMB_STATUS" == "200" ]] || die "POST /api/auth/pairing → $OMB_STATUS: $(printf '%s' "$OMB_BODY" | jq -r .error). Se isto é o app desktop, cunhe o código pelo DevTools (cabeçalho deste script)."
  CODE="$(printf '%s' "$OMB_BODY" | jq -r .code)"
  log "código cunhado: $CODE (expira em 5 min)"
fi

[[ -n "$CODE" ]] || die "informe o código de pareamento (ou --mint num servidor headless)"

OMB_TOKEN=""
omb_call POST /api/auth/pair "$(jq -nc --arg c "$CODE" --arg l "$LABEL" '{code:$c,label:$l}')" 200
body="$OMB_BODY"
token="$(printf '%s' "$body" | jq -r .token)"
[[ "$token" == omb_sess_* ]] || die "resposta sem token: $body"

mkdir -p "$(dirname "$OMB_TOKEN_FILE")"
umask 077
printf '%s\n' "$token" > "$OMB_TOKEN_FILE"
chmod 600 "$OMB_TOKEN_FILE"
log "sessão '$(printf '%s' "$body" | jq -r .session.label)' criada; escopos: $(printf '%s' "$body" | jq -c .session.scopes)"
log "token guardado em $OMB_TOKEN_FILE (30 dias; revogue com: openmausbot sessions revoke $(printf '%s' "$body" | jq -r .session.id))"
