#!/usr/bin/env bash
# Instala o servidor OpenMausBot (fork, com os itens A–H) como LaunchAgent
# headless no Mac, servindo ~/.openmausbot em http://127.0.0.1:8799, e
# (opcional) desloca o app desktop para o seu próprio data dir.
#
# Passos (cada um pode ser saltado com a flag indicada):
#   1. build   pnpm build:server && pnpm exec vite build &&
#              node scripts/build-npm-package.mjs && (cd release/npm && npm pack)
#              → release/npm/openmausbot-<ver>.tgz        [--skip-build]
#              (scripts reais: package.json "build:server", scripts/
#              build-npm-package.mjs:1-6 — a UI vem de `vite build`, não há
#              script "build:ui"; `npm pack` corre em release/npm.)
#   2. npm i -g ./openmausbot-<ver>.tgz  → bin `openmausbot`  [--skip-install]
#   3. lease: recusa se ~/.openmausbot/openmausbot-server.lease pertence a um
#      processo vivo (o app desktop está a servir esse data dir).
#   4. plist: substitui os __PLACEHOLDERS__ do template e faz bootstrap em
#      gui/$UID; espera /api/health.
#   5. --desktop-env: `launchctl setenv OMB_DATA_DIR ~/.openmausbot-desktop`
#      (+ um LaunchAgent que repete isso a cada login) para o app desktop
#      arrancar com o seu próprio data dir e ser só um CLIENTE do headless.
#
# Uso: ./install-headless.sh [--skip-build] [--skip-install] [--desktop-env]
# Variáveis: OMB_FORK_DIR (checkout do fork), OMB_PORT, OMB_DATA_DIR,
#            OMB_LABEL, OMB_DESKTOP_DATA_DIR.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

# ── Variáveis do operador ──────────────────────────────────────────────────
OMB_FORK_DIR="${OMB_FORK_DIR:-$HOME/Projetos/OpenMausBot}"
OMB_PORT="${OMB_PORT:-8799}"
OMB_DATA_DIR="${OMB_DATA_DIR:-$HOME/.openmausbot}"
OMB_LABEL="${OMB_LABEL:-Mac headless}"
OMB_DESKTOP_DATA_DIR="${OMB_DESKTOP_DATA_DIR:-$HOME/.openmausbot-desktop}"
LOG_DIR="$HOME/Library/Logs/OpenMausBot"
PLIST_LABEL="com.openmausbot.server"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
ENV_LABEL="com.openmausbot.desktop-env"
ENV_PLIST="$HOME/Library/LaunchAgents/$ENV_LABEL.plist"
# ───────────────────────────────────────────────────────────────────────────

log()  { printf '%s\n' "▸ $*" >&2; }
warn() { printf '%s\n' "⚠ $*" >&2; }
die()  { printf '%s\n' "✖ $*" >&2; exit 1; }

SKIP_BUILD=0; SKIP_INSTALL=0; DESKTOP_ENV=0
for a in "$@"; do case "$a" in
  --skip-build) SKIP_BUILD=1 ;; --skip-install) SKIP_INSTALL=1 ;; --desktop-env) DESKTOP_ENV=1 ;;
  -h|--help) sed -n 2,26p "$0"; exit 0 ;; *) die "argumento desconhecido: $a" ;;
esac; done

[[ "$(uname -s)" == "Darwin" ]] || die "este instalador é para macOS (launchd)"
command -v node >/dev/null || die "node não está no PATH (brew install node@24)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 24 )) || die "o servidor exige Node ≥ 24 (tem $(node --version)); package.json engines"

# 1) build + pack
if [[ $SKIP_BUILD -eq 0 ]]; then
  [[ -f "$OMB_FORK_DIR/package.json" ]] || die "OMB_FORK_DIR=$OMB_FORK_DIR não é um checkout do fork"
  command -v pnpm >/dev/null || die "pnpm não está no PATH (corepack enable)"
  log "build em $OMB_FORK_DIR (HEAD $(git -C "$OMB_FORK_DIR" rev-parse --short HEAD 2>/dev/null || echo '?'))"
  ( cd "$OMB_FORK_DIR"
    pnpm install --frozen-lockfile
    pnpm build:server
    pnpm exec vite build
    node scripts/build-npm-package.mjs
    cd release/npm && npm pack --silent )
fi
TGZ="$(ls -t "$OMB_FORK_DIR"/release/npm/openmausbot-*.tgz 2>/dev/null | head -1 || true)"

# 2) instalar globalmente
if [[ $SKIP_INSTALL -eq 0 ]]; then
  [[ -n "$TGZ" ]] || die "nenhum openmausbot-*.tgz em $OMB_FORK_DIR/release/npm (rode sem --skip-build)"
  log "npm i -g $TGZ"
  npm install -g "$TGZ"
fi
CLI_BIN="$(command -v openmausbot || true)"
[[ -n "$CLI_BIN" ]] || die "o bin 'openmausbot' não está no PATH depois do npm i -g (PATH do npm global: $(npm prefix -g)/bin)"
# O bin é um wrapper; o launchd precisa do node + cli.js reais (o wrapper
# depende do PATH para achar o node).
CLI_JS="$(npm root -g)/openmausbot/cli.js"
[[ -f "$CLI_JS" ]] || die "não achei $CLI_JS"
NODE_BIN="$(command -v node)"
log "openmausbot $("$NODE_BIN" "$CLI_JS" --help 2>/dev/null | head -1 || echo '')  ($CLI_JS)"

# 3) lease do data dir
LEASE="$OMB_DATA_DIR/openmausbot-server.lease"
if [[ -f "$LEASE" ]]; then
  LEASE_PID="$(node -p 'try{JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid}catch{""}' "$LEASE" 2>/dev/null || true)"
  if [[ -n "$LEASE_PID" ]] && kill -0 "$LEASE_PID" 2>/dev/null; then
    die "o data dir $OMB_DATA_DIR está em uso pelo pid $LEASE_PID ($(ps -o comm= -p "$LEASE_PID" 2>/dev/null)).
   É o app desktop (ou um serve anterior). Feche-o (Cmd+Q) e, para o desktop não voltar a
   tomar este data dir, rode com --desktop-env. Nunca apague o lease com o processo vivo."
  fi
  log "lease antigo em $LEASE sem processo vivo — o servidor vai substituí-lo"
fi

# 4) plist
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__CLI__|$CLI_JS|g" -e "s|__PORT__|$OMB_PORT|g" \
    -e "s|__DATA_DIR__|$OMB_DATA_DIR|g" -e "s|__HOME__|$HOME|g" -e "s|__LABEL__|$OMB_LABEL|g" \
    "$HERE/$PLIST_LABEL.plist" > "$PLIST_DST"
plutil -lint "$PLIST_DST" >/dev/null
log "plist em $PLIST_DST"
launchctl bootout "gui/$UID/$PLIST_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST_DST"
launchctl kickstart -k "gui/$UID/$PLIST_LABEL"
log "à espera de http://127.0.0.1:$OMB_PORT/api/health …"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$OMB_PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$OMB_PORT/api/health" >/dev/null || die "o servidor não respondeu em 60 s; veja $LOG_DIR/serve.log"
curl -fsS "http://127.0.0.1:$OMB_PORT/api/workflows/health" >/dev/null || die "/api/workflows/health não existe: o tgz instalado não é a build com os itens A–H"
log "servidor headless no ar: $(curl -fsS "http://127.0.0.1:$OMB_PORT/.well-known/openmausbot/environment" | node -p 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); `${j.label} · v${j.version} · id ${j.environmentId}`')"

# 5) desktop → cliente
if [[ $DESKTOP_ENV -eq 1 ]]; then
  mkdir -p "$OMB_DESKTOP_DATA_DIR"
  launchctl setenv OMB_DATA_DIR "$OMB_DESKTOP_DATA_DIR"
  cat > "$ENV_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$ENV_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/launchctl</string><string>setenv</string><string>OMB_DATA_DIR</string><string>$OMB_DESKTOP_DATA_DIR</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
  launchctl bootout "gui/$UID/$ENV_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$ENV_PLIST"
  log "OMB_DATA_DIR=$OMB_DESKTOP_DATA_DIR definido para apps GUI (agora e a cada login via $ENV_PLIST)"
fi

cat >&2 <<EOF

Próximos passos
  1. Abra (ou reabra) o app OpenMausBot. Com --desktop-env ele arranca num data dir vazio
     ($OMB_DESKTOP_DATA_DIR) e, como a porta $OMB_PORT já responde, o seu servidor embutido
     sobe em 18799/28799 (electron/main.mjs:1033-1049) — não interfere.
  2. Ligue o app ao headless: no terminal
        openmausbot pair --label Desktop --public-url http://127.0.0.1:$OMB_PORT
     copie a linha "open or scan: http://127.0.0.1:$OMB_PORT/pair#code=…" e no app use
     Server → "Add Server from Copied Pairing Link…" → Connect. Repita com --label iPhone
     (QR) para o telemóvel. O menu Server alterna entre "Local" e o headless.
  3. Scripts do kit: sem token (loopback é dono no headless) — ./smoke.sh
  4. Logs: tail -f $LOG_DIR/serve.log     estado: launchctl print gui/$UID/$PLIST_LABEL

Avisos
  • gh/claude/codex guardam credenciais no Keychain de login; o agente corre na sua
    sessão gráfica, por isso normalmente funciona — se \`gh auth status\` falhar só no
    pre-flight, refaça \`gh auth login\` a partir de um Terminal e responda "Sempre
    permitir" ao Keychain (ou use GH_CONFIG_DIR/--insecure-storage por sua conta).
  • TCC: o processo é o \`node\` do Homebrew, não o app; pastas protegidas (Desktop,
    Documents, Downloads) exigem Full Disk Access para esse binário se os bots as usarem.
    ~/Projetos não é protegida.
  • Só um processo pode servir $OMB_DATA_DIR (lease). Se um dia quiser o desktop de volta
    como servidor: ./uninstall-headless.sh.
EOF
