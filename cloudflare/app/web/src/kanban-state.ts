import type { CodingRecord } from "../../src/coding-types.ts";

export const boardColumns = [
  { id: "approval", name: "A aprovar", hint: "Tarefas aguardando sua aprovação." },
  { id: "queued", name: "Na fila", hint: "Tarefas aprovadas, prontas para começar." },
  { id: "working", name: "Em execução", hint: "Planejamento, código e testes em andamento." },
  { id: "review", name: "Em revisão", hint: "Revisão das alterações e criação do PR." },
  { id: "completed", name: "Concluídas", hint: "Confira os testes e o PR. Merge e publicação seguem as regras do projeto." },
  { id: "attention", name: "Precisam de atenção", hint: "Falhas, interrupções e cancelamentos." },
] as const;
export type BoardColumn = typeof boardColumns[number]["id"];

export function boardColumn(run: Pick<CodingRecord, "status" | "agentStage" | "result">): BoardColumn {
  if (run.status === "pending_approval") return "approval";
  if (run.status === "queued") return "queued";
  if (run.status === "completed") return "completed";
  if (["failed", "canceled", "interrupted"].includes(run.status)) return "attention";
  if (run.status === "publishing" || (run.status === "running" && run.agentStage === "reviewer")) return "review";
  return "working";
}

const searchable = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
export function filterBoardRuns<T extends CodingRecord>(runs: T[], filters: { query: string; repository: string; agent: string }): T[] {
  const query = searchable(filters.query.trim());
  return runs.filter((run) => (!filters.repository || run.repositoryName === filters.repository)
    && (!filters.agent || run.agents?.some((agent) => agent.name === filters.agent))
    && (!query || searchable([run.task, run.repositoryName, ...(run.agents?.map((agent) => agent.name) ?? [])].join(" ")).includes(query)));
}
