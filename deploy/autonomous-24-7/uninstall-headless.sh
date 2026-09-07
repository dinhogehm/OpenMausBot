#!/usr/bin/env bash
# Desfaz install-headless.sh: pára e remove o LaunchAgent, (opcional) devolve
# o data dir ao app desktop e (opcional) desinstala o pacote npm global.
# NUNCA apaga ~/.openmausbot nem ~/.openmausbot-desktop.
#
# Uso: ./uninstall-headless.sh [--desktop-env] [--npm]
#   --desktop-env  remove o OMB_DATA_DIR das apps GUI (launchctl unsetenv +
#                  LaunchAgent com.openmausbot.desktop-env) → o app desktop
#                  volta a servir ~/.openmausbot no próximo arranque
#   --npm          npm uninstall -g openmausbot

set -euo pipefail
PLIST_LABEL="com.openmausbot.server"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
ENV_LABEL="com.openmausbot.desktop-env"
ENV_PLIST="$HOME/Library/LaunchAgents/$ENV_LABEL.plist"
log()  { printf '%s\n' "▸ $*" >&2; }
die()  { printf '%s\n' "✖ $*" >&2; exit 1; }

DESKTOP_ENV=0; NPM=0
for a in "$@"; do case "$a" in
  --desktop-env) DESKTOP_ENV=1 ;; --npm) NPM=1 ;;
  -h|--help) sed -n 2,11p "$0"; exit 0 ;; *) die "argumento desconhecido: $a" ;;
esac; done

if launchctl print "gui/$UID/$PLIST_LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID/$PLIST_LABEL"
  log "agente $PLIST_LABEL parado (o serve manda SIGTERM ao servidor; o lease é libertado)"
else
  log "agente $PLIST_LABEL não estava carregado"
fi
[[ -f "$PLIST_DST" ]] && { rm -f "$PLIST_DST"; log "removido $PLIST_DST"; }

if [[ $DESKTOP_ENV -eq 1 ]]; then
  launchctl bootout "gui/$UID/$ENV_LABEL" 2>/dev/null || true
  rm -f "$ENV_PLIST"
  launchctl unsetenv OMB_DATA_DIR
  log "OMB_DATA_DIR removido do ambiente das apps GUI; feche e reabra o app desktop — ele volta a servir ~/.openmausbot"
  log "os dados que o desktop criou em ~/.openmausbot-desktop ficam lá (apague à mão se quiser)"
fi

if [[ $NPM -eq 1 ]]; then
  npm uninstall -g openmausbot && log "pacote npm global removido"
fi

log "pronto. Logs antigos em ~/Library/Logs/OpenMausBot/ (não removidos). Token do kit, se existir: ~/.config/openmausbot-kit/token — revogue com \`openmausbot sessions revoke <id>\` no servidor que o emitiu."
