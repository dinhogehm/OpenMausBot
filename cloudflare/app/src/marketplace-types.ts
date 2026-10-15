import type { AgentCatalogDraft, AgentCatalogResponse } from "./agent-catalog-types";

export type MarketplaceSourceId = "omb" | "grokbot";
export interface MarketplaceSource {
  id: MarketplaceSourceId; name: string; url: string; checkedAt: string;
  coverage: "complete_snapshot" | "selection"; revision: string | null; note: string;
}
export interface MarketplaceEntry {
  id: string; source: MarketplaceSourceId; kind: "team" | "agent"; name: string; description: string;
  category: string; author: string; sourceUrl: string; version: string;
  license: { id: string | null; url: string | null; notice: string | null };
  installable: boolean; unavailableReason: string | null; profileCount: number;
  requiredCapabilities: string[]; excludedFeatures: string[];
  installed: "not_installed" | "installed" | "modified"; profileIds: string[];
}
export interface MarketplaceListing {
  version: string; catalogVersion: number; canInstall: boolean;
  sources: MarketplaceSource[]; items: MarketplaceEntry[];
}
export interface MarketplacePreview {
  entry: MarketplaceEntry; catalogVersion: number; canInstall: boolean;
  profiles: AgentCatalogDraft[];
}
export interface MarketplaceInstallInput {
  entryId: string; version: string; expectedCatalogVersion: number; requestId: string;
}
export interface MarketplaceInstallResult { entryId: string; catalog: AgentCatalogResponse; profileIds: string[] }
