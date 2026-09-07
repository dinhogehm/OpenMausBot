# Kit "autonomous 24/7" — pipeline nuria-platform

Scripts que o operador roda **no próprio Mac** para pôr o workflow
"Entrega contínua · nuria-platform" a correr em ciclo contínuo sobre a build
do fork que contém os itens A–H (`docs/plans/2026-09-07-autonomous-24-7.md`).
Tudo fala com a API real em `http://127.0.0.1:8799`; nada edita ficheiros em
`~/.openmausbot` à mão.

| ficheiro | faz |
|---|---|
| `lib.sh` | funções comuns: URL, autenticação, `omb_api`, resolução de ids de bot |
| `omb-token.sh` | troca um código de pareamento por um token `omb_sess_…` (só preciso com o servidor do app desktop) |
| `apply-workflow.sh` | `PATCH /api/workflows/:id` com trigger interval, ciclo com wait, cap, always-allow por nó, renotify, fallbacks, watchdog/digest/sala, pre-flight; backup antes |
| `revert-workflow.sh` | restaura um `backup-<timestamp>.json` |
| `apply-bots.sh` | clona Eng Core/QA/SRE/Merge em bots "· pipeline" dedicados; `--rewire` re-aponta o workflow; `--fallback-cwd` dá o repo aos bots Claude |
| `smoke.sh` | health + pre-flight; `--run` dispara e acompanha um run |
| `com.openmausbot.server.plist` | template do LaunchAgent (servidor headless) |
| `install-headless.sh` / `uninstall-headless.sh` | build + `npm pack` + `npm i -g`, LaunchAgent, migração do desktop |

Pré-requisitos no Mac: `curl`, `jq` (`brew install jq`), `gh` autenticado,
Node ≥ 24, pnpm (só para o headless). Todos os scripts têm as variáveis no topo
e aceitam-nas pelo ambiente (`INTERVAL_MINUTES=30 ./apply-workflow.sh`).

## 1. Pré-requisito: a build certa

O servidor tem de ser a build do fork com os itens A–H (HEAD `e1f2459c` ou
posterior). Como saber: `GET /api/workflows/health` existe só nela. Os scripts
verificam isso e param com `este servidor não é a build com os itens A–H`
caso contrário. Dois modos de ter essa build no ar:

* **app desktop** empacotado a partir do fork (`pnpm package:mac`) — os
  scripts precisam de um token (§2);
* **servidor headless** via launchd (§4) — os scripts não precisam de token.

Confirme também que `~/.openmausbot` é o data dir que o servidor está a
servir (o workflow `eb42a861-…` tem de aparecer em `GET /api/workflows`).

## 2. Autenticação dos scripts (leia antes de correr o que quer que seja)

Verificado em `server/request-auth.ts`:

* Uma requisição de loopback sem `Origin` é o **dono** quando o servidor
  corre fora do desktop (headless): `resolveRequestAuth` dá `admin+client`
  sem credencial (`:354-375`). Nada a fazer.
* No **app desktop empacotado**, o Electron gera um token aleatório por
  lançamento (`electron/main.mjs:263`) e injeta-o como header
  `x-openmausbot-desktop-owner` em toda requisição da janela
  (`main.mjs:890-910`). Sem esse header, qualquer mutação (`PATCH`, `POST`)
  recebe **403** (`request-auth.ts:296-312, 367-373`). Um script não tem como
  conhecer o token. `openmausbot pair` também recebe 403 aí (a cunhagem é
  `POST /api/auth/pairing`, uma mutação).
* Um bearer `Authorization: Bearer omb_sess_…` (sessão pareada) **vence** a
  regra de loopback e tem escopos `admin+client` (`:334-351`; escopos por
  omissão em `sessions.ts openPairing`).

Portanto, com o app desktop:

1. No app: menu **View → Toggle Developer Tools → Console** e cole
   ```js
   fetch('/api/auth/pairing',{method:'POST',headers:{'content-type':'application/json'},
     body:JSON.stringify({label:'omb-kit'})}).then(r=>r.json()).then(j=>console.log(j.code))
   ```
   Sai um código `XXXX-XXXX-XXXX` (uso único, 5 min).
2. No terminal: `./omb-token.sh XXXX-XXXX-XXXX` — troca em `POST /api/auth/pair`
   (rota pública por desenho, `index.ts:7983-8007`) e guarda o token em
   `~/.config/openmausbot-kit/token` (chmod 600, 30 dias). Os scripts leem-no
   sozinhos; `OMB_TOKEN=…` no ambiente também serve.
3. Revogar: `openmausbot sessions` / `openmausbot sessions revoke <id>` (no
   desktop essas rotas são GET/DELETE — a lista funciona; a revogação faça-a
   pelo app ou com o token: `curl -X DELETE -H "authorization: Bearer $(cat ~/.config/openmausbot-kit/token)" http://127.0.0.1:8799/api/auth/sessions/<id>`).

Com o servidor headless salte tudo isto (`./omb-token.sh --mint` funciona lá
se quiser um token na mesma).

## 3. Ordem de aplicação

```sh
cd deploy/autonomous-24-7
./smoke.sh                       # 0. estado atual: build certa, engine viva, pre-flight (ainda o antigo)
./apply-bots.sh                  # 1. cria "Eng Core · pipeline", "QA · pipeline", "SRE · pipeline", "Merge · pipeline"
./apply-bots.sh --rewire --fallback-cwd   #    re-aponta codificacao/testes-*/deploy/rollback/revisao/merge; cwd nos bots Claude
./apply-workflow.sh              # 2. trigger, ciclo, cap, always-allow, renotify, fallbacks, watchdog, pre-flight
./smoke.sh                       # 3. health ok + pre-flight todos ok
./smoke.sh --run                 # 4. (opcional) um run manual acompanhado; ver nota abaixo
```

Antes do passo 2, crie no app uma sala chamada **pipeline** (ou passe
`AUDIT_GROUP_ID=<id>`): o script procura-a pelo nome e liga-a como sala de
auditoria; sem sala, avisa e não mexe no campo.

O que `apply-workflow.sh` grava (valores nas variáveis do topo):

| item | valor | onde no schema (`server/workflow-api.ts`) |
|---|---|---|
| trigger | `interval` 60 min, `activeHours` 07:00–23:00, seg–sáb | `:136-146` |
| cap | `maxNodeExecutions` 60 (só passos agent/approval contam) | `:198`, faixa 1..1000 |
| ciclo | `sem-demanda:ok → pausa(30 min) → triagem`; `update-canal:avisado → pausa-entrega(1 min) → triagem` | nó `wait` `:115-121` |
| always-allow | por nó, nas duas grafias `shell:X` **e** `Bash:X` + `session_search`/`list_bots`/`edit` conforme o nó | `:90` |
| aprovação | `onExpire: renotify`, `maxRenotify 5`, `expiresHours 12` | `:95-108` |
| fallback | codificacao→Rigel, testes-pre→Pixel, spec→Ada | `:93` |
| watchdog | `stuckAfterMinutes 120`, `digestAt 18:00`, `auditGroupId` | `:201-207` |
| pre-flight | `gh auth status`; `git -C <repo> status --porcelain` ≙ `^$`; `gh project view 10 --owner dinhogehm --format json`; `bots-ready` 15 min; timeout 90 s | `:161-186` |

`instructions`, `botId`, `timeoutMinutes`, `retries`, `requires` e
`outcomes` dos nós existentes não são reescritos: o script parte do JSON
atual e altera apenas os campos acima (`DRY_RUN=1` mostra o PATCH sem
aplicar). O PATCH responde 200 mesmo com issues; o script lista-as —
**erros** bloqueiam o Run, **avisos** não. Esperados após aplicar: dois
`unwired-failure` (sem-demanda/update-canal não têm aresta `failed`, como
antes). Se aparecer `cycle-without-wait` é porque pôs
`DELIVERY_PAUSE_MINUTES=0`.

Nota sobre `--run` num ciclo: o run só termina no cap (60 passos ≈ 5 voltas
completas), numa falha, ou ao cancelar. `smoke.sh --run` acompanha até
`MAX_MINUTES` (180) e sai deixando o run vivo; `--cancel-at-end` cancela-o.
Enquanto houver run vivo o trigger não arma outro; ao ficar ocioso, a
próxima run arma em `fim + 60 min` dentro da janela.

## 4. Servidor headless (o app fecha, o pipeline continua)

Por quê: o servidor embutido morre com o app (turnos mortos em cada
restart, causa observada no brief), e o Mac dorme. `install-headless.sh`
instala `openmausbot serve` como LaunchAgent sob `caffeinate -s -i`.

```sh
OMB_FORK_DIR=~/Projetos/OpenMausBot ./install-headless.sh --desktop-env
```

Faz, por ordem: `pnpm build:server && pnpm exec vite build && node
scripts/build-npm-package.mjs && (cd release/npm && npm pack)` (são os
scripts reais — a UI é `vite build`, não há `build:ui`), `npm i -g` do tgz,
verifica o **lease** (`~/.openmausbot/openmausbot-server.lease`, tomado
por `server/index.ts:382`: se o app desktop está a servir esse data dir o
instalador para e pede para fechar o app), renderiza o plist com caminhos
absolutos, `launchctl bootstrap gui/$UID`, espera `/api/health` e confirma
`/api/workflows/health`. Logs: `~/Library/Logs/OpenMausBot/serve.log`.

`--desktop-env` faz `launchctl setenv OMB_DATA_DIR ~/.openmausbot-desktop`
(e um LaunchAgent que repete isso a cada login), para o app desktop deixar
de disputar `~/.openmausbot` e passar a ser só um cliente. Depois:

1. Reabra o app. Ele arranca num data dir vazio; como a 8799 já responde,
   o seu servidor embutido sobe em 18799 (`electron/main.mjs:1033-1049`).
2. `openmausbot pair --label Desktop --public-url http://127.0.0.1:8799`
   imprime `open or scan: http://127.0.0.1:8799/pair#code=…`. Copie a linha;
   no app **Server → Add Server from Copied Pairing Link… → Connect**. O menu
   Server passa a alternar entre "Local" e o headless. Repita com
   `--label iPhone` (QR) para o telemóvel.
3. Os scripts do kit não precisam de token contra o headless.

Avisos:

* **Lease**: só um processo serve um data dir. Nunca apague o lease com o
  processo vivo; o `serve` liberta-o ao receber SIGTERM.
* **gh / claude / codex fora da sessão do Terminal**: o agente corre na
  sua sessão gráfica (`gui/$UID`), por isso o Keychain de login está
  acessível e `gh auth status` normalmente passa. Se falhar só no
  pre-flight, refaça `gh auth login` num Terminal e responda "Sempre
  permitir" ao Keychain. O PATH do plist inclui `/opt/homebrew/bin`.
* **TCC**: o processo é o `node` do Homebrew; pastas protegidas (Desktop,
  Documents, Downloads) exigem Full Disk Access para esse binário.
  `~/Projetos` não é protegida.
* `caffeinate -s` só impede o sleep com o Mac ligado à corrente.

Reverter: `./uninstall-headless.sh --desktop-env [--npm]` — para o agente,
remove o plist, tira o `OMB_DATA_DIR` das apps GUI (o desktop volta a
servir `~/.openmausbot` no próximo arranque). Não apaga dados.

## 5. Validar e reverter

* `./smoke.sh` — `ok:true`, tick recente, pre-flight todo verde.
* `curl -s http://127.0.0.1:8799/api/workflows/health | jq` (com
  `-H "authorization: Bearer …"` no desktop) — `runs.stuck` vazio,
  `workflows[].nextRunAt` armado quando ocioso, `refusalStreak` nulo.
* Timeline no app: o run mostra "Waiting until HH:MM · pausa" entre voltas.
* Reverter o workflow: `./revert-workflow.sh backup-<timestamp>.json`
  (os backups ficam nesta pasta, ignorados pelo git). Restaura trigger
  diário, cap 24, nós/arestas originais e limpa watchdog/pre-flight. Não
  cancela runs vivos — cancele no app se preciso.
* Reverter os bots: `./apply-bots.sh --rewire` gravou um backup do workflow
  antes de re-apontar; use-o com `revert-workflow.sh`. Os clones "· pipeline"
  podem ser apagados no app.

## 6. Decisões tomadas (e por quê)

* **`shell:gh` e não `Bash:gh`.** `approvalKey` (`server/auto-approve.ts:124-132`)
  monta `tool:programa` com o nome que o driver dá à ferramenta; o Codex chama
  `shell` a comandos e `edit` a edições (`server/drivers/codex.ts:702-713`).
  Os `Bash:*` que os bots Codex já têm nunca disparam num turno Codex. Cada
  nó recebe as duas grafias, porque a lista do nó também cobre o bot Claude
  de fallback (`effectiveAlwaysAllow`, união bot ∪ nó). `edit` só é honrado
  quando o **nó** o declara (`:303-307`) — aqui é declarado em codificacao e doc.
* **Wait de 1 min depois de `update-canal`.** `update-canal` é um nó agent;
  uma aresta direta agent→entry faz o cap terminar o run como `failed` com
  notificação de falha (plano D §3). Com um wait no meio o cap fecha a volta
  como `completed`. `DELIVERY_PAUSE_MINUTES=0` dá a aresta direta do brief.
* **Sem fallback em revisao/merge/deploy/rollback.** Exigem `canMerge` /
  `canDeploy`; os bots Claude não têm as flags → `fallback-missing-capability`
  e o engine ignora o fallback. Não se configura o que nunca dispara.
* **Não há `GET /api/workflows/:id`** (`workflow-api.ts:654-659`); o script lê a
  lista e filtra. `store.update` é spread raso, por isso `nodes`/`edges`/`layout`
  vão completos e o resto fica intocado.
* **Bots dedicados por clonagem via API**: `POST /api/bots` só aceita
  nome/perfil/`modelSelection` (`index.ts:10540-10587`); o resto vai num
  `PATCH /api/bots/:id`. `approvalMode` full/custom não pode ser pedido fora
  do desktop (`:10903-10911`) — o clone fica em `ask` e o script avisa.
  Sem sessão pareada, alargar `alwaysAllow` exige todos os bots ociosos
  (`:11019-11026`).
* **Fallback bots precisam de `cwd` no repo** — o engine não copia nada do
  primário; `apply-bots.sh --fallback-cwd` resolve.
