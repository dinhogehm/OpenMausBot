/** Persona metadata never grants tools, credentials, integrations, or execution roles. */
export interface AgentCatalogDraft {
  sourceId: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  section: string;
  sourceEngine: string;
  sourceModel: string;
  sourceEffort: string;
}
export interface CatalogAgent extends AgentCatalogDraft { id: string; revision: number }
export interface CatalogSelections { coordinator: string; programmer: string; reviewer: string }
export interface AgentSelections extends CatalogSelections { catalogVersion: number }
export interface AgentCatalogState {
  version: number;
  agents: CatalogAgent[];
  selections: CatalogSelections | null;
  decisionMode: "team";
}
export interface AgentCatalogResponse extends AgentCatalogState {
  mutation?: { requestId: string; appliedVersion: number; replayed: boolean };
}
export const AGENT_CATALOG_LIMITS = { count: 100, bytes: 262_144, instructionBytes: 20_000 } as const;
