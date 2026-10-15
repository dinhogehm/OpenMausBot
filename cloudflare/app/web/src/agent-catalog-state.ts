import type { AgentCatalogDraft, CatalogAgent } from "../../src/agent-catalog-types";

const encoder = new TextEncoder();
export const instructionBytes = (value: string) => encoder.encode(value).length;
export const catalogFileLimit = 2 * 1024 * 1024;

export function matchesCatalogSearch(agent: Pick<AgentCatalogDraft, "name" | "title" | "section">, query: string): boolean {
  const normalize = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR");
  const searchable = normalize(`${agent.name} ${agent.title} ${agent.section}`);
  return normalize(query).trim().split(/\s+/u).every((word) => searchable.includes(word));
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("O arquivo contém um perfil inválido.");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, chars: number, bytes: number, line = false, required = false): string {
  const input = value ?? "";
  if (typeof input !== "string" || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input) || input.includes("\0") || input.length > chars || instructionBytes(input) > bytes || (required && !input.trim()) || (line && /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(input))) throw new Error(`Confira o campo ${name}. O conteúdo está vazio, inválido ou ultrapassa o limite.`);
  return input;
}

/** Allowlisted projection is performed before any imported file reaches the server. */
export function catalogDraft(agent: AgentCatalogDraft | CatalogAgent): AgentCatalogDraft {
  const { sourceId, name, title, description, instructions, section, sourceEngine, sourceModel, sourceEffort } = agent;
  return { sourceId, name, title, description, instructions, section, sourceEngine, sourceModel, sourceEffort };
}
export function validateCatalogProfiles(values: unknown[]): AgentCatalogDraft[] {
  if (!values.length || values.length > 100) throw new Error("Selecione entre 1 e 100 perfis de agentes.");
  const seen = new Set<string>();
  const agents = values.map((value) => {
    const profile = object(value);
    const sourceId = text(profile.sourceId, "identificador de origem", 80, 80, true, true);
    if (!/^[A-Za-z0-9_-]+$/.test(sourceId) || seen.has(sourceId)) throw new Error("Cada perfil precisa ter um identificador de origem válido e único no arquivo.");
    seen.add(sourceId);
    return { sourceId, name: text(profile.name, "nome", 100, 400, true, true), title: text(profile.title, "título", 200, 800, true), description: text(profile.description, "descrição", 4000, 16000), instructions: text(profile.instructions, "instruções (até 20.000 bytes)", 20000, 20000), section: text(profile.section, "seção", 100, 400, true), sourceEngine: text(profile.sourceEngine, "motor de origem", 80, 320, true), sourceModel: text(profile.sourceModel, "modelo de origem", 120, 480, true), sourceEffort: text(profile.sourceEffort, "esforço de origem", 30, 120, true) };
  });
  if (instructionBytes(JSON.stringify(agents)) > 262144) throw new Error("Os perfis ultrapassam o limite de 256 KiB do catálogo. Importe um conjunto menor.");
  return agents;
}
export function importCatalogProfiles(content: string): AgentCatalogDraft[] {
  if (instructionBytes(content) > catalogFileLimit) throw new Error("Escolha um arquivo JSON de até 2 MiB.");
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error("Não foi possível ler o JSON. Confira o arquivo exportado."); }
  const root = Array.isArray(parsed) ? parsed : object(parsed);
  const profiles = Array.isArray(root) ? root : root.agents ?? root.bots;
  if (!Array.isArray(profiles)) throw new Error("O arquivo precisa conter uma lista de perfis ou um campo agents com essa lista.");
  return validateCatalogProfiles(profiles.map((value) => {
    const profile = object(value);
    const selection = profile.modelSelection && typeof profile.modelSelection === "object" && !Array.isArray(profile.modelSelection) ? profile.modelSelection as Record<string, unknown> : {};
    return { sourceId: profile.sourceId ?? profile.id, name: profile.name, title: profile.title, description: profile.description,
      instructions: profile.instructions ?? profile.soul, section: profile.section, sourceEngine: profile.sourceEngine ?? selection.instanceId,
      sourceModel: profile.sourceModel ?? selection.model, sourceEffort: profile.sourceEffort ?? selection.effort };
  }));
}
