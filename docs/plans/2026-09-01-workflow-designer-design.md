# Workflow Designer — Design

Data: 2026-09-01
Status: validado em conversa (brainstorming)

## Objetivo

Permitir que o usuário **desenhe** fluxos de trabalho de agentes dentro do OpenMausBot
(nós = etapas executadas por bots do roster, arestas = caminhos condicionais) e que esses
fluxos sejam executados **de forma estritamente determinística**, inclusive em modo
automático 24/7 (demandas entrando por webhook/cron e sendo processadas em fila).

Caso de uso de referência: pipeline de desenvolvimento — entrada de demandas (Telegram,
planilha, issue GitHub) → codificação → revisão de PR → merge → deploy → testes em
produção → doc/artigo → atualização do canal de origem.

## Decisões validadas

1. **Motor determinístico**: o servidor executa o grafo. O agente trabalha dentro do nó,
   mas nunca escolhe o próximo passo — quem segue a aresta é o motor.
2. **MVP completo**: desenhar + executar + observar ao vivo, no mesmo canvas.
3. **Tipos de nó do MVP**: agente (com saídas nomeadas/ramificação condicional),
   aprovação humana, notificação em canal; triggers manual, cron e webhook.
4. **24/7 por construção**: nenhum estado espera sem timer; um reconciliador periódico
   garante progresso (auto-cura após crash/hang/restart).

## Modelo de dados

Novo tipo compartilhado em `shared/workflow.ts` (precedente: `server/team-manifest.ts`):

```ts
type Workflow = {
  id: string; name: string; description?: string
  entryNodeId: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]            // { from, outcome, to } — ciclos permitidos
  layout: Record<string, { x: number; y: number }>  // posições no canvas
}

type WorkflowNode =
  | { kind: "agent"; botId: string; instructions: string;
      outcomes: string[];          // ex.: ["aprovado", "reprovado"]
      timeoutMinutes?: number;     // default 30
      retries?: number }           // default 2, com backoff
  | { kind: "approval"; prompt: string;
      expiresHours?: number;       // default 24
      onExpire?: string }          // outcome default ao expirar (ex.: "rejected")
  | { kind: "notify"; targetGroupId: string; template: string }  // saída única "sent"
```

- Nós de agente **referenciam bots existentes** do sidebar (`BotRecord`): personalidade,
  modelo e permissões vêm do bot. O workflow é a coreografia; o elenco é o roster.
- **Saídas nomeadas** declaradas no nó; cada saída vira uma aresta. Outcome implícito
  `falhou` (retries esgotados/timeout) é roteável como qualquer outro.
- Persistência: `workflows.json` e `workflow-runs.json` (JSON atômico via
  `server/atomic.ts`, padrão de `routines.json`). Cada nó executado roda numa
  `TaskRecord` normal do bot — transcrição auditável no chat.
- Export/import **`openmaus.workflow`**, portável (padrão do `openmaus.team`).

```ts
type WorkflowRun = {
  id: string; workflowId: string
  status: "running" | "waiting-approval" | "completed" | "failed" | "cancelled"
  currentNodeId?: string
  input: string                    // payload do trigger (marcado untrusted)
  nodeResults: Array<{ nodeId: string; outcome: string; summary: string;
                       threadId: string; startedAt: number; endedAt: number }>
  startedAt: number; endedAt?: number
  usage?: { tokens: number; costUsd?: number }
}
```

## Motor de execução (`server/workflow-run.ts`)

- **Hub central**: despacha cada nó via `startTurn(botId, …, { threadId, unattended,
  automationSource: "workflow" })` (`server/index.ts:2436`). O agente nunca chama outro
  agente — `MAX_COMMS_DEPTH = 1` não é tocado; payload externo entra marcado como
  não-confiável no system prompt.
- **Declaração de saída**: o prompt do nó exige envelope final
  `<openmaus-workflow>{"outcome": "...", "summary": "..."}</openmaus-workflow>`
  (padrão do `<openmaus-goal>` de `server/group-goal-run.ts`). `outcome` deve ser um dos
  declarados. Envelope ausente/inválido → 1 cobrança; falhou de novo → conta como falha
  do nó (entra na política de retry).
- **Contexto entre nós**: cada nó recebe o input original do run + a cadeia de resumos
  `{nó, outcome, summary}` já percorridos. Nunca a transcrição inteira.
- **Máquina de estados** persistida a cada transição (crash-safe).

### Garantias de vida (24/7)

1. **Reconciliador** (tick ~30s no daemon): nó despachado sem evento do driver há N min →
   interrompe o turno e aplica retry; run `running` órfão pós-restart → re-despacha o nó
   atual; workflow sem run ativo e fila não-vazia → inicia o próximo.
2. **Falha vira aresta**: retry automático por nó (default 2, backoff); esgotado, o
   outcome `falhou` segue o grafo. Só pausa (com notificação e "retomar daqui") se a
   aresta de falha não foi desenhada.
3. **Fila por bot, FIFO por idade** de enfileiramento — impede starvation entre
   workflows que compartilham bots.
4. **Aprovação com prazo**: expiração configurável + ação default + lembrete via push no
   companion. Gate humano nunca segura a fila para sempre.
5. **Tetos por run**: guarda de ciclo (~30 execuções de nó) + orçamento de tokens/custo.
   Estouro → caminho normal de falha.
6. **Concorrência**: um run ativo por workflow; triggers enfileiram.
7. **Loop de demandas**: webhooks enfileiram na hora; cron de segurança dispara o nó de
   triagem ("pega a mais prioritária"); backlog vazio → `outcome: "vazio"` encerra o run
   em segundos.

**Dependência conhecida**: o server é filho do Electron — app fechado, nada roda. Para
24/7 real: app aberto (com bloqueio de sleep) ou `server/` headless via launchd. Fase 2.

## Canvas (página "Workflows")

- Evolução da `src/components/TeamMapPage.tsx`; **única dependência nova:
  `@xyflow/react`**. Reusa `src/lib/team-map.ts` e o SSE existente (`/api/events`).
- **Edição**: paleta com os tipos de nó; nó de agente abre painel (bot do roster,
  instruções, saídas, timeout/retries). Cada saída declarada é um **conector de origem
  nomeado** — a aresta nasce de "aprovado"/"reprovado". Layout salvo em `workflow.layout`.
- **Validação = contrato**: salvar/rodar só com grafo íntegro. Erros inline no nó:
  saída sem aresta, nó inalcançável, bot deletado; aviso (não erro) para falha sem
  aresta com retry esgotado.
- **Observação ao vivo**: nó atual pulsando, arestas percorridas acesas com o outcome,
  nó falho em vermelho com "retomar daqui", aprovação com aprovar/rejeitar no canvas.
  Clique no nó executado → transcrição da task no chat do bot. Histórico de runs com
  timeline e custo.
- **Triggers** no painel do workflow: rodar manual, cron (reusa `server/routines.ts`),
  webhook (reusa `server/webhooks.ts` + `webhook-ingress.ts`); aparecem como nós de
  entrada no canvas.

## API

- CRUD: `GET/POST/PATCH/DELETE /api/workflows`
- Runs: `GET/POST /api/workflows/:id/runs`, `POST /api/workflow-runs/:id/cancel`,
  `POST /api/workflow-runs/:id/resume`, aprovação via card existente
- Eventos de run no `GET /api/events` (SSE) existente

## Fora de escopo (fase 2)

- Runs paralelos do mesmo workflow (com isolamento por worktree)
- Nó "decisão de agente" (LLM escolhe entre arestas rotuladas)
- Prioridade além de FIFO por idade
- Server headless/launchd para 24/7 sem app aberto
- Sub-workflows / composição
