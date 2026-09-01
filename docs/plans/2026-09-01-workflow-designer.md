# Workflow Designer — Plano de Implementação

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Canvas para desenhar fluxos de agentes (nós = bots do roster, arestas = saídas nomeadas) executados por um motor determinístico auto-curável, com aprovação humana, notificação, triggers manual/cron/webhook e observação ao vivo.

**Architecture:** Motor novo em `server/workflow-run.ts` no padrão `RoutineManager` (DI de `startTurn`/`botState`/`emit`, tick de 10s como reconciliador). Definições e runs persistidos em JSON atômico (`workflows.json`, `workflow-runs.json`). Saída do agente declarada por envelope `<openmaus-workflow>` (padrão do `<openmaus-goal>`). UI: nova `activeView: "workflows"` com canvas `@xyflow/react` que edita e observa via SSE existente.

**Tech Stack:** TypeScript strict, Node `--experimental-strip-types`, vitest, zod, React 19 + Vite + Tailwind, `@xyflow/react` (única dependência nova).

**Design de referência:** `docs/plans/2026-09-01-workflow-designer-design.md`

**Verificação global (rodar ao fim de toda task):**
- `pnpm typecheck` — sem erros
- `npx vitest run <arquivo do teste>` — verde
- Ao fim de tudo: `pnpm lint`, `npx vitest run` completo, e a skill do projeto **verify-omb** (valida server contra fake-engine isolado)

**Convenções obrigatórias (do código existente):**
- Persistência: sempre `writeFileAtomic` de `server/atomic.ts`, mode 0600, arquivo com `{ version: 1, ... }`
- Nunca `Date.now()` direto em módulo de server testável — injete `now?: () => number` (padrão `RoutineManagerOptions`, `server/routines.ts:144`)
- Erros de agente redigidos com `redactSecretsInText` (`server/redact.ts`) e truncados
- Todo write emite mudança para o SSE via `emit` injetado (frames `{ kind, ... }`)
- Testes: vitest, `rmSync(DATA_DIR, {recursive, force})` no `beforeEach`, stubs que capturam despachos, helper `waitFor` (copiar de `server/delegations.test.ts:57-66`)

---

## Task 1: Modelo compartilhado — tipos, parser de envelope, validador de grafo

**Files:**
- Create: `shared/workflow.ts`
- Test: `shared/workflow.test.ts`

Módulo **puro** (sem I/O) usado por server e renderer. Espelha `shared/group-goal-run.ts`.

**Step 1: Escrever os testes que falham**

```ts
// shared/workflow.test.ts
import { describe, expect, it } from "vitest";
import {
  parseWorkflowOutcome,
  validateWorkflow,
  WORKFLOW_FAIL_OUTCOME,
  type Workflow,
} from "./workflow.ts";

const wf = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: "wf1",
  name: "Pipeline",
  entryNodeId: "code",
  nodes: [
    { kind: "agent", id: "code", botId: "b1", instructions: "codifique", outcomes: ["done"] },
    { kind: "agent", id: "review", botId: "b2", instructions: "revise", outcomes: ["approved", "rejected"] },
  ],
  edges: [
    { from: "code", outcome: "done", to: "review" },
    { from: "review", outcome: "approved", to: "code" }, // ciclo é permitido
    { from: "review", outcome: "rejected", to: "code" },
  ],
  layout: {},
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

describe("parseWorkflowOutcome", () => {
  it("extrai o último envelope completo com outcome permitido", () => {
    const text = `Revisei o PR.\n<openmaus-workflow>{"outcome":"approved","summary":"LGTM, 2 nits"}</openmaus-workflow>`;
    expect(parseWorkflowOutcome(text, ["approved", "rejected"])).toEqual({
      outcome: "approved",
      summary: "LGTM, 2 nits",
    });
  });
  it("rejeita outcome fora da lista declarada", () => {
    const text = `<openmaus-workflow>{"outcome":"maybe","summary":"x"}</openmaus-workflow>`;
    expect(parseWorkflowOutcome(text, ["approved"])).toBeNull();
  });
  it("último envelope completo vence (exemplo citado antes não conta)", () => {
    const text = [
      `<openmaus-workflow>{"outcome":"rejected","summary":"exemplo"}</openmaus-workflow>`,
      `<openmaus-workflow>{"outcome":"approved","summary":"real"}</openmaus-workflow>`,
    ].join("\n");
    expect(parseWorkflowOutcome(text, ["approved", "rejected"])?.outcome).toBe("approved");
  });
  it("JSON malformado, envelope ausente ou summary vazio → null", () => {
    expect(parseWorkflowOutcome("sem envelope", ["a"])).toBeNull();
    expect(parseWorkflowOutcome(`<openmaus-workflow>{oops</openmaus-workflow>`, ["a"])).toBeNull();
    expect(parseWorkflowOutcome(`<openmaus-workflow>{"outcome":"a","summary":""}</openmaus-workflow>`, ["a"])).toBeNull();
  });
  it("trunca summary em 2000 chars", () => {
    const long = "x".repeat(5000);
    const text = `<openmaus-workflow>{"outcome":"a","summary":"${long}"}</openmaus-workflow>`;
    expect(parseWorkflowOutcome(text, ["a"])?.summary.length).toBe(2000);
  });
});

describe("validateWorkflow", () => {
  it("grafo íntegro → sem issues de erro", () => {
    expect(validateWorkflow(wf()).filter((i) => i.severity === "error")).toEqual([]);
  });
  it("saída declarada sem aresta → erro no nó", () => {
    const issues = validateWorkflow(wf({ edges: wf().edges.filter((e) => e.outcome !== "rejected") }));
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "unwired-outcome", nodeId: "review" }),
    );
  });
  it("nó inalcançável a partir da entrada → erro", () => {
    const w = wf();
    w.nodes.push({ kind: "notify", id: "orphan", targetGroupId: "g1", template: "oi" });
    expect(validateWorkflow(w)).toContainEqual(
      expect.objectContaining({ severity: "error", code: "unreachable", nodeId: "orphan" }),
    );
  });
  it("aresta apontando para nó inexistente, entryNodeId inválido, ids duplicados → erro", () => {
    const w = wf();
    w.edges.push({ from: "review", outcome: "approved", to: "ghost" });
    expect(validateWorkflow(w).some((i) => i.code === "dangling-edge")).toBe(true);
    expect(validateWorkflow(wf({ entryNodeId: "nope" })).some((i) => i.code === "bad-entry")).toBe(true);
    const dup = wf();
    dup.nodes.push({ ...dup.nodes[0]! });
    expect(validateWorkflow(dup).some((i) => i.code === "duplicate-node-id")).toBe(true);
  });
  it("nó agente sem aresta para o outcome implícito 'failed' → warning (não erro)", () => {
    const issues = validateWorkflow(wf());
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "warning", code: "unwired-failure", nodeId: "code" }),
    );
  });
  it("outcome reservado 'failed' não pode ser declarado manualmente", () => {
    const w = wf();
    (w.nodes[0] as { outcomes: string[] }).outcomes = ["done", WORKFLOW_FAIL_OUTCOME];
    expect(validateWorkflow(w).some((i) => i.code === "reserved-outcome")).toBe(true);
  });
});
```

**Step 2:** `npx vitest run shared/workflow.test.ts` → FAIL (módulo não existe).

**Step 3: Implementar `shared/workflow.ts`**

```ts
/** Declarative agent workflow: the drawing IS the contract. The engine in
 * server/workflow-run.ts follows edges; agents never choose the next step. */

export const WORKFLOW_CONTROL_OPEN = "<openmaus-workflow>";
export const WORKFLOW_CONTROL_CLOSE = "</openmaus-workflow>";
/** Implicit routable outcome emitted by the engine when retries are exhausted. */
export const WORKFLOW_FAIL_OUTCOME = "failed";
export const WORKFLOW_APPROVAL_OUTCOMES = ["approved", "rejected"] as const;
export const WORKFLOW_NOTIFY_OUTCOME = "sent";

export const WORKFLOW_NODE_TIMEOUT_DEFAULT_MIN = 30;
export const WORKFLOW_NODE_RETRIES_DEFAULT = 2;
export const WORKFLOW_MAX_NODE_EXECUTIONS = 30;
export const WORKFLOW_APPROVAL_EXPIRES_DEFAULT_H = 24;
const SUMMARY_MAX = 2_000;

export type WorkflowNode =
  | {
      kind: "agent";
      id: string;
      botId: string;
      instructions: string;
      outcomes: string[];
      timeoutMinutes?: number;
      retries?: number;
    }
  | { kind: "approval"; id: string; prompt: string; expiresHours?: number; onExpire?: "approved" | "rejected" }
  | { kind: "notify"; id: string; targetGroupId: string; template: string };

export interface WorkflowEdge {
  from: string;
  outcome: string;
  to: string;
}

export interface WorkflowTriggers {
  /** Reuses the routine schedule shape; engine computes nextRunAt on tick. */
  schedule?: { type: "daily"; time: string; weekdays: number[] } | { type: "once"; at: number };
  webhookId?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  entryNodeId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  layout: Record<string, { x: number; y: number }>;
  triggers?: WorkflowTriggers;
  maxNodeExecutions?: number;
  createdAt: number;
  updatedAt: number;
}

export type WorkflowRunStatus = "running" | "waiting-approval" | "completed" | "failed" | "cancelled";

export interface WorkflowNodeResult {
  nodeId: string;
  outcome: string;
  summary: string;
  threadId?: string;
  startedAt: number;
  endedAt: number;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  currentNodeId?: string;
  /** Attempt counter for the current node; resets when the run advances. */
  attempt: number;
  input: string;
  nodeResults: WorkflowNodeResult[];
  error?: string;
  startedAt: number;
  endedAt?: number;
}

/** Outcomes a node can settle with, including the engine-reserved failure. */
export function nodeOutcomes(node: WorkflowNode): string[] {
  if (node.kind === "agent") return [...node.outcomes, WORKFLOW_FAIL_OUTCOME];
  if (node.kind === "approval") return [...WORKFLOW_APPROVAL_OUTCOMES];
  return [WORKFLOW_NOTIFY_OUTCOME];
}

export interface ParsedWorkflowOutcome {
  outcome: string;
  summary: string;
}

/** Last complete envelope wins, mirroring parseGroupGoalDecision: a quoted
 * example earlier in the reply can never steer the run. Malformed protocol
 * is a null, never a guess. */
export function parseWorkflowOutcome(text: string, allowed: string[]): ParsedWorkflowOutcome | null {
  const closeAt = text.lastIndexOf(WORKFLOW_CONTROL_CLOSE);
  const openAt = closeAt < 0 ? -1 : text.lastIndexOf(WORKFLOW_CONTROL_OPEN, closeAt);
  if (openAt < 0 || closeAt < 0) return null;
  const payload = text.slice(openAt + WORKFLOW_CONTROL_OPEN.length, closeAt).trim();
  try {
    const raw = JSON.parse(payload) as Record<string, unknown>;
    const outcome = typeof raw.outcome === "string" ? raw.outcome.trim() : "";
    const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, SUMMARY_MAX) : "";
    if (!outcome || !summary || !allowed.includes(outcome)) return null;
    return { outcome, summary };
  } catch {
    return null;
  }
}

export interface WorkflowIssue {
  severity: "error" | "warning";
  code:
    | "bad-entry"
    | "duplicate-node-id"
    | "dangling-edge"
    | "unwired-outcome"
    | "unwired-failure"
    | "unreachable"
    | "reserved-outcome";
  nodeId?: string;
  message: string;
}

/** The strictness lives here: a workflow that validates with zero errors has
 * exactly one edge for every declared outcome and every node reachable. */
export function validateWorkflow(workflow: Workflow): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const ids = new Set<string>();
  for (const node of workflow.nodes) {
    if (ids.has(node.id)) {
      issues.push({ severity: "error", code: "duplicate-node-id", nodeId: node.id, message: `Duplicate node id "${node.id}"` });
    }
    ids.add(node.id);
    if (node.kind === "agent" && node.outcomes.includes(WORKFLOW_FAIL_OUTCOME)) {
      issues.push({
        severity: "error", code: "reserved-outcome", nodeId: node.id,
        message: `"${WORKFLOW_FAIL_OUTCOME}" is reserved for the engine's retry-exhausted path`,
      });
    }
  }
  if (!ids.has(workflow.entryNodeId)) {
    issues.push({ severity: "error", code: "bad-entry", message: `Entry node "${workflow.entryNodeId}" does not exist` });
  }
  for (const edge of workflow.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      issues.push({
        severity: "error", code: "dangling-edge", nodeId: ids.has(edge.from) ? edge.to : edge.from,
        message: `Edge ${edge.from} --${edge.outcome}--> ${edge.to} references a missing node`,
      });
    }
  }
  for (const node of workflow.nodes) {
    const wired = new Set(workflow.edges.filter((e) => e.from === node.id).map((e) => e.outcome));
    const declared = node.kind === "agent" ? node.outcomes : nodeOutcomes(node).filter((o) => o !== WORKFLOW_FAIL_OUTCOME);
    for (const outcome of declared) {
      if (!wired.has(outcome)) {
        // Terminal nodes are legitimate: an outcome with no edge ENDS the run
        // successfully only when the node wires NO outcomes at all (pure sink).
        // A partially wired node is ambiguous and therefore an error.
        if (wired.size > 0) {
          issues.push({
            severity: "error", code: "unwired-outcome", nodeId: node.id,
            message: `Outcome "${outcome}" of node "${node.id}" has no edge while others do`,
          });
        }
      }
    }
    if (node.kind === "agent" && !wired.has(WORKFLOW_FAIL_OUTCOME)) {
      issues.push({
        severity: "warning", code: "unwired-failure", nodeId: node.id,
        message: `Node "${node.id}" has no failure edge; exhausted retries will pause the run`,
      });
    }
  }
  // Reachability from entry over declared edges.
  const adjacency = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }
  const seen = new Set<string>();
  const queue = ids.has(workflow.entryNodeId) ? [workflow.entryNodeId] : [];
  while (queue.length) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) queue.push(next);
  }
  for (const node of workflow.nodes) {
    if (!seen.has(node.id) && ids.has(workflow.entryNodeId)) {
      issues.push({
        severity: "error", code: "unreachable", nodeId: node.id,
        message: `Node "${node.id}" is unreachable from the entry node`,
      });
    }
  }
  return issues;
}
```

**Step 4:** `npx vitest run shared/workflow.test.ts` → PASS. Ajuste o teste `unwired-outcome` se a semântica "sink puro é terminal válido" divergir do esperado — a regra validada no design é: **todas as saídas ligadas, ou nenhuma** (nó terminal).

**Step 5:** `pnpm typecheck` → OK.

**Step 6: Commit**

```bash
git add shared/workflow.ts shared/workflow.test.ts
git commit -m "feat(workflow): shared model, envelope parser and graph validator"
```

---

## Task 2: Persistência — `WorkflowStore`

**Files:**
- Create: `server/workflow-store.ts`
- Test: `server/workflow-store.test.ts`

CRUD de `Workflow` + `WorkflowRun`, arquivos `workflows.json` e `workflow-runs.json` em `DATA_DIR` (`server/config.ts` exporta `DATA_DIR`). Espelhar o formato `{ version: 1, workflows: [...] }` / `{ version: 1, runs: [...] }`. Cap de runs retidos: 2000 (padrão `MAX_RUNS` de routines).

**Step 1: Testes que falham** (`server/workflow-store.test.ts`)

Casos (usar `rmSync(DATA_DIR, ...)` no `beforeEach` e opção `file`/`runsFile` apontando para dir temporário do teste, como delegations):

1. `create(input)` gera id, `createdAt/updatedAt` via `now` injetado, persiste e recarrega após `new WorkflowStore(...)` (round-trip de disco).
2. `update(id, patch)` rejeita workflow com issues de severidade `error` (usa `validateWorkflow`) — **salvar fluxo inválido é impossível**; warnings passam.
3. `remove(id)` apaga e é idempotente.
4. `createRun/patchRun/listRuns(workflowId)` persistem; `listRuns` ordena por `startedAt` desc; runs acima de 2000 são podados (mais antigos primeiro).
5. Arquivo corrompido no disco → carrega vazio sem lançar (mesma tolerância dos outros stores: `JSON.parse` com try/catch).
6. Todo write chama o `emit` injetado com `{ kind: "workflow", workflow }` ou `{ kind: "workflow-run", run }` (frames keyed para o SSE).

**Step 2:** rodar → FAIL.

**Step 3: Implementar.** Esqueleto:

```ts
// server/workflow-store.ts
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { writeFileAtomic } from "./atomic.ts";
import { validateWorkflow, type Workflow, type WorkflowRun } from "../shared/workflow.ts";

const MAX_RUNS = 2_000;

export interface WorkflowStoreOptions {
  file?: string;      // default join(DATA_DIR, "workflows.json")
  runsFile?: string;  // default join(DATA_DIR, "workflow-runs.json")
  now?: () => number;
  emit?: (payload: Record<string, unknown>) => void;
}

export type WorkflowInput = Omit<Workflow, "id" | "createdAt" | "updatedAt">;

export class WorkflowStore {
  // load() no construtor; save() com writeFileAtomic({version:1,...}, {mode:0o600});
  // create/update/remove/get/list; createRun/patchRun/getRun/listRuns.
  // update() lança Error("invalid workflow: <primeiro issue>") se houver error-issue.
  // Toda mutação: save() + emit().
}
```

**Step 4:** testes PASS. **Step 5:** `pnpm typecheck`. **Step 6: Commit** — `feat(workflow): persistent store for definitions and runs`.

---

## Task 3: Motor — despacho de nó, envelope e avanço pelo grafo

**Files:**
- Create: `server/workflow-run.ts`
- Test: `server/workflow-run.test.ts`

O coração. Classe `WorkflowEngine`, DI no padrão exato de `RoutineManagerOptions` (`server/routines.ts:144-164`):

```ts
export interface WorkflowEngineOptions {
  store: WorkflowStore;
  now?: () => number;
  emit?: (payload: Record<string, unknown>) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  /** Cria a TaskRecord isolada onde o nó roda (transcrição auditável no chat). */
  createTask: (botId: string, title: string) => { threadId: string } | null;
  startTurn: (
    botId: string,
    threadId: string,
    prompt: string,
    onDispatchError: (message: string) => void,
  ) => Promise<void>;
  interruptTurn?: (botId: string, threadId: string) => Promise<void>;
  /** Nó notify: posta mensagem simples num canal (sem turno de agente). */
  postGroupMessage?: (groupId: string, text: string) => void;
  /** Falha/pausa/aprovação pendente → notificação ao usuário. */
  notifyUser?: (run: WorkflowRun, message: string) => void;
}
```

Comportamentos desta task (sem retry/tick ainda):

- `startRun(workflowId, input, trigger)` → recusa se `validateWorkflow` tem erro; se já há run ativo (`running`/`waiting-approval`) do mesmo workflow, **enfileira** (status interno de fila: run criado com `status: "running"` só quando despachado; use um array `queue` persistido no run file com status literal `"queued"` — adicionar `"queued"` ao union `WorkflowRunStatus` na Task 1 se preferir; decisão: **adicionar `"queued"` ao union agora**, é mais honesto que fila em memória).
- Despacho de nó agente: `createTask(botId, "Workflow <nome> — <nodeId>")` → `startTurn` com prompt montado por `buildNodePrompt(workflow, node, run)`:
  - input original do run (delimitado como conteúdo não-confiável — copiar o framing usado por rotinas/`automationSource`),
  - cadeia `nodeResults` como `- <nodeId>: <outcome> — <summary>`,
  - instruções do nó,
  - contrato do envelope: `Termine com exatamente um envelope em linha própria: <openmaus-workflow>{"outcome":"<um de: ...>","summary":"..."}</openmaus-workflow>` + "Never mention the envelope in your visible text" (copiar tom de `groupGoalCoordinatorInstructions`).
- `handleRuntimeEvent(event)`: acumular o texto final do assistant por `threadId` (mesmo mecanismo pelo qual `RoutineManager` captura `run.output` — ver `server/routines.ts:806` e o tipo de evento usado lá; replicar). Em `turn.completed` do thread do nó atual:
  - `parseWorkflowOutcome(texto, node.outcomes)` OK → grava `nodeResult`, segue a aresta `{from, outcome}`; sem aresta para o outcome e nó é sink puro → run `completed`; com aresta → despacha o próximo nó.
  - Envelope inválido/ausente na 1ª vez → **uma cobrança**: novo `startTurn` no mesmo thread pedindo só o envelope. Na 2ª → conta como falha de tentativa (Task 4 tratará retry; por ora marca run `failed` com `error`).
- Guarda de ciclo: `nodeResults.length >= (workflow.maxNodeExecutions ?? WORKFLOW_MAX_NODE_EXECUTIONS)` → run `failed`, `error: "node execution cap reached"`.
- Run que termina (qualquer status terminal) → despachar próximo da fila do mesmo workflow.

**Step 1: Testes que falham.** Setup: `WorkflowStore` real em dir temporário; stubs `startTurn` que capturam `{botId, threadId, prompt}` num array; helper para simular a conclusão: chamar `engine.handleRuntimeEvent({type:"assistant_text", threadId, text})` + `({type:"turn.completed", threadId})` (usar os shapes reais de `RuntimeEvent` de `server/contracts.ts:84` — ajustar nomes conforme o contrato real ao implementar). Casos:

1. `startRun` despacha o nó de entrada: 1 chamada a `createTask` + `startTurn`; prompt contém instruções, input e contrato do envelope com os outcomes certos.
2. Conclusão com envelope válido avança pela aresta correta (aprovado → nó X, reprovado → nó Y) e grava `nodeResult` com summary.
3. Envelope ausente → exatamente 1 cobrança no mesmo thread; segunda falha → run `failed`.
4. Outcome sem aresta em nó sink puro → run `completed`.
5. Ciclo funciona (testa → falhou → codifica → testa) e o cap de execuções derruba o run em `failed`.
6. Segundo `startRun` do mesmo workflow com run ativo → fica `queued`; quando o primeiro termina, o da fila despacha sozinho.
7. Prompt do nó marca o input como não-confiável.

**Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS. **Step 5:** `pnpm typecheck`.

**Step 6: Commit** — `feat(workflow): deterministic engine core — dispatch, envelope, graph advance`.

---

## Task 4: Robustez 24/7 — retry, timeout, reconciliador, fila FIFO por bot

**Files:**
- Modify: `server/workflow-run.ts`
- Test: `server/workflow-run.test.ts` (ampliar)

- **Retry:** falha de tentativa (dispatch error, envelope 2× inválido, timeout) → se `attempt < (node.retries ?? WORKFLOW_NODE_RETRIES_DEFAULT)`, re-despacha o nó (novo task/thread) com `attempt+1` e backoff (delay = `attempt * 60_000`, agendado pelo tick — sem `setTimeout` solto). Esgotado → outcome implícito `WORKFLOW_FAIL_OUTCOME`: com aresta `failed` desenhada, **segue o grafo**; sem aresta, run `failed` + `notifyUser` ("retomar daqui" via Task 6).
- **Timeout por nó:** `dispatchedAt` persistido no run; tick detecta `now - dispatchedAt > timeoutMinutes` → `interruptTurn` + falha de tentativa.
- **Reconciliador (`start()`/`tick()`):** espelhar `RoutineManager` (`server/routines.ts:710-711`): `setInterval(() => void this.tick(), 10_000)`, flag `ticking` contra reentrância. O tick faz: (a) timeouts; (b) retries agendados vencidos; (c) run `running` com nó atual sem despacho vivo (crash antes do `startTurn` — detectável por `dispatchedAt` ausente) → re-despacha; (d) fila: workflow sem run ativo e com `queued` → despacha o mais antigo; (e) bot ocupado: despacho pendente aguarda `botState(botId) === "ready"`, ordem FIFO por `startedAt` **global** (entre workflows) por bot.
- **Recuperação pós-restart:** construtor carrega runs `running`/`waiting-approval` do disco; primeiro tick os reconcilia (não confiar em memória).
- **`resumeRun(runId)`** (usado pelo botão "retomar daqui"): run `failed` → volta o nó atual para despacho com `attempt = 0`.
- **`cancelRun(runId)`**: interrompe turno em voo e marca `cancelled`.

**Testes novos:** timeout dispara interrupt + retry; retries esgotados seguem aresta `failed` quando existe e pausam quando não existe; dois workflows disputando o mesmo bot são servidos por idade (o mais antigo primeiro); restart (novo `WorkflowEngine` sobre os mesmos arquivos) re-despacha run órfão no primeiro `tick()` (chamar `tick()` manualmente no teste — não usar timers reais; `now` injetado avança o relógio).

**Commit** — `feat(workflow): retries, timeouts, reconciler tick and per-bot FIFO queue`.

---

## Task 5: Nós approval e notify

**Files:**
- Modify: `server/workflow-run.ts`
- Test: `server/workflow-run.test.ts` (ampliar)

- **approval:** ao chegar no nó → run `waiting-approval`, persiste `approvalRequestedAt`, `emit({kind:"workflow-run", run})`, `notifyUser(run, prompt)`. Método `resolveApproval(runId, decision: "approved" | "rejected")` → segue a aresta. Tick: `now - approvalRequestedAt > expiresHours` → segue `onExpire ?? "rejected"`. Lembrete: `notifyUser` de novo na metade do prazo (um único lembrete; flag persistida).
- **notify:** sem turno de agente — `postGroupMessage(targetGroupId, render(template, run))` onde `render` substitui `{{input}}`, `{{summary}}` (último nodeResult) e `{{workflow}}`; outcome fixo `sent`, avança imediato.

**Testes:** approval pausa e não despacha nada até `resolveApproval`; expiração via tick segue `onExpire`; notify chama `postGroupMessage` com template renderizado e avança no mesmo passo.

**Commit** — `feat(workflow): human approval gate and channel notification nodes`.

---

## Task 6: API HTTP + wiring no server

**Files:**
- Modify: `server/index.ts` (rotas junto ao bloco das rotas de rotinas — procurar `"/api/routines"`; construção do engine junto ao `new RoutineManager` em `server/index.ts:3116`; hookup de eventos junto a `routines?.handleRuntimeEvent(event)` em `server/index.ts:1676`)
- Test: cobertura via testes do engine já feita; para as rotas, seguir o padrão de teste de rotas existente em `server/index.test.ts` **somente se** já houver precedente de teste de rota lá; caso contrário validar via smoke manual (Step 4)

**Rotas:**

| Método/rota | Ação |
|---|---|
| `GET /api/workflows` | lista definições + issues de validação por workflow |
| `POST /api/workflows` | cria (body validado com zod espelhando `shared/workflow.ts`) |
| `PATCH /api/workflows/:id` | atualiza (recusa erro de validação com 400 e issues no body) |
| `DELETE /api/workflows/:id` | remove |
| `GET /api/workflows/:id/runs` | histórico |
| `POST /api/workflows/:id/runs` | `startRun` manual (`{ input }`) |
| `POST /api/workflow-runs/:id/cancel` | cancela |
| `POST /api/workflow-runs/:id/resume` | retoma do nó falho |
| `POST /api/workflow-runs/:id/approval` | `{ decision: "approved" \| "rejected" }` |

**Wiring (espelhar linha a linha o bloco do RoutineManager em `index.ts:3116-3148`):**

```ts
workflowEngine = new WorkflowEngine({
  store: new WorkflowStore({ emit: broadcast }),
  emit: broadcast,
  botState: (botId) => { /* igual ao de routines */ },
  createTask: (botId, title) => { /* igual, com broadcast do bot */ },
  startTurn: (botId, threadId, prompt, onDispatchError) =>
    startTurn(botId, prompt, { threadId, automationSource: "workflow", onDispatchError }).then(() => undefined),
  interruptTurn: async (botId, threadId) => { /* igual ao de routines, sem runOn cloud no MVP */ },
  postGroupMessage: (groupId, text) => { /* localizar como comms-visibility/DM mirror appenda mensagem de sistema num group thread e reusar */ },
  notifyUser: (run, message) => notify(buildNotification("workflow", /* bot do nó atual */, /* threadId */, message)),
});
workflowEngine.start();
```

> `automationSource: "workflow"`: verificar o union de `automationSource` aceito por `startTurn` (`server/index.ts:2436`) e adicionar `"workflow"` a ele — é o que marca o payload como não-confiável no system prompt.

No pipeline de eventos (`index.ts:1676`), adicionar `workflowEngine?.handleRuntimeEvent(event)`.

**Step 4 (smoke):** `pnpm dev:server` + `curl -s localhost:8799/api/workflows` → `[]`; criar um workflow de 1 nó via curl, `POST .../runs`, ver o run avançar nos logs.

**Commit** — `feat(workflow): HTTP API and server wiring for the workflow engine`.

---

## Task 7: Triggers — webhook e cron

**Files:**
- Modify: `server/webhooks.ts`, `server/webhook-ingress.ts` (ler ambos antes: hoje o delivery dispara `RoutineRun`; adicionar tipo de alvo `workflow` mantendo HMAC/secret intactos)
- Modify: `server/workflow-run.ts` (cron no tick)
- Test: `server/workflow-run.test.ts` + seguir precedente de `server/webhooks.test.ts`

- **Webhook:** definição de webhook ganha alvo `{ kind: "workflow", workflowId }` ao lado do alvo atual. Delivery válido → `engine.startRun(workflowId, payloadTexto, "webhook")` (payload já viaja como input não-confiável).
- **Cron:** tick do engine avalia `workflow.triggers.schedule` — replicar o cálculo de `nextRunAt` de `server/routines.ts` (extrair helper para função exportada se necessário, sem duplicar lógica de calendário). Disparo → `startRun(workflowId, "Scheduled trigger", "schedule")`. Backlog vazio é responsabilidade do fluxo (nó de triagem termina com outcome próprio), não do trigger.

**Testes:** schedule vencido no tick dispara exatamente 1 run (idempotência via `nextRunAt` persistido); webhook com alvo workflow enfileira run.

**Commit** — `feat(workflow): webhook and cron triggers`.

---

## Task 8: UI — view "workflows", nav e cliente de API

**Files:**
- Modify: `src/state/store.tsx` — adicionar `"workflows"` ao union `activeView` (`src/state/store.tsx:428`) + action no reducer (espelhar o case que seta `activeView: "routines"` em `:751`); estado `workflows: Workflow[]`, `workflowRuns: WorkflowRun[]`; tratar frames SSE `{kind:"workflow"}` e `{kind:"workflow-run"}` no reducer de eventos; carregar snapshot em `loadSnapshotBoundary` (peripheral novo, padrão dos existentes)
- Modify: `src/App.tsx` — renderizar `<WorkflowsPage />` quando `activeView === "workflows"` (espelhar `TeamMapPage` em `src/App.tsx:248-249`); adicionar entrada de navegação onde "team-map"/"routines" são abertos (procurar o componente que despacha essas views — sidebar/menu)
- Create: `src/components/WorkflowsPage.tsx` — nesta task só: lista de workflows (nome, status de validação, último run), botões criar/renomear/apagar/rodar, usando `api()` de `src/state/store.tsx:1305`
- i18n: rodar `pnpm i18n:check` e seguir o que ele apontar para as strings novas

**Verificação:** `pnpm typecheck`; `pnpm dev` + `pnpm dev:server`, abrir a view, criar/rodar/apagar um workflow trivial.

**Commit** — `feat(workflow): workflows view, navigation, state and API client`.

---

## Task 9: Canvas de edição com validação inline

**Files:**
- `pnpm add @xyflow/react`
- Create: `src/components/WorkflowCanvas.tsx`, `src/components/WorkflowNodeCard.tsx`, `src/components/WorkflowNodePanel.tsx`
- Modify: `src/components/WorkflowsPage.tsx` (lista → abre canvas)

- Custom node `@xyflow/react`: card com avatar/nome do bot (agent), ícones distintos para approval/notify; **um source handle por outcome declarado** (id do handle = outcome) + um handle `failed` discreto em nós agente; um target handle.
- Painel lateral ao selecionar nó: bot (dropdown do roster vindo do estado global), instruções (textarea), outcomes (lista editável), timeout/retries; para approval: prompt/expiração; para notify: canal + template.
- Arestas: `onConnect` grava `{from, outcome: sourceHandle, to}`; posição de nós → `workflow.layout` com debounce; salvar via `PATCH /api/workflows/:id`.
- **Validação**: rodar `validateWorkflow` (import direto de `shared/workflow.ts` — é a mesma função do server) a cada mudança; badge de erro sobre o nó com tooltip da mensagem; botão "Rodar" desabilitado com erro presente; warnings (sem aresta `failed`) em amarelo.
- Estilo: Tailwind, paleta do app (ver tokens usados em `TeamMapPage.tsx`).

**Verificação manual (roteiro):** desenhar o pipeline do design (codifica → revisa → aprovado/reprovado com ciclo), quebrar de propósito (apagar uma aresta) e ver o erro inline + botão desabilitado; recarregar a página e ver layout persistido.

**Commit** — `feat(workflow): editable canvas with inline graph validation`.

---

## Task 10: Canvas de observação ao vivo

**Files:**
- Modify: `src/components/WorkflowCanvas.tsx`, `WorkflowsPage.tsx`
- Create: `src/components/WorkflowRunTimeline.tsx`

- Toggle Editar/Observar. Em Observar, o canvas é read-only e decorado pelo run selecionado (default: ativo ou mais recente): nó atual pulsando (`animate-pulse`), arestas percorridas destacadas com o outcome, nó falho em vermelho com botão **"Retomar daqui"** (`POST /api/workflow-runs/:id/resume`), nó approval pendente com **Aprovar/Rejeitar** inline (`POST .../approval`).
- Clique em nó com `nodeResult.threadId` → navegar para a transcrição (despachar a mesma action usada hoje para abrir um chat/task por threadId — procurar por onde `selectedId` + thread são setados no reducer).
- `WorkflowRunTimeline`: lista de runs (status, duração, gatilho) + passos do run selecionado.
- Tudo alimentado pelos frames SSE `workflow-run` já tratados na Task 8 — sem polling.

**Verificação manual:** rodar o pipeline com 2 bots reais baratos; assistir o avanço ao vivo; forçar uma falha (instrução "responda sem envelope") e usar "Retomar daqui"; aprovar um gate pelo canvas.

**Commit** — `feat(workflow): live run observation on the canvas`.

---

## Task 11: Verificação final e documentação

1. `pnpm typecheck` && `pnpm lint` && `npx vitest run` — tudo verde (broker/electron não são afetados, mas `pnpm test` completo se houver tempo).
2. Rodar a skill do projeto **verify-omb** para validar o server contra o fake-engine isolado.
3. Roteiro e2e manual: workflow de 3 nós com ciclo + approval + notify, disparado manualmente e por webhook (curl com HMAC), app reiniciado no meio de um run (deve retomar sozinho no tick).
4. Docs: página nova `apps/docs` (ou `docs/`) descrevendo o formato `openmaus.workflow`, o envelope e as garantias 24/7 — fonte: o design doc.
5. Atualizar `docs/plans/2026-09-01-workflow-designer-design.md` com desvios de implementação, se houver.

**Commit** — `docs(workflow): user documentation for the workflow designer`.

---

## Fora de escopo (fase 2 — NÃO implementar)

Runs paralelos com worktree, nó "decisão de agente", prioridade além de FIFO, server headless/launchd, sub-workflows, export/import `openmaus.workflow` (o formato está especificado no design; adiado para quando a base estiver estável), card de aprovação dentro do chat (MVP aprova pelo canvas + notificação push).
