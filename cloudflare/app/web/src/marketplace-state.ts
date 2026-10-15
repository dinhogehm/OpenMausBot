import type { MarketplaceEntry } from "../../src/marketplace-types";

export type MarketplaceAvailability = "all" | "importable" | "installed" | "reference";
type SearchableEntry = Pick<MarketplaceEntry, "name" | "description" | "category" | "source" | "installable" | "installed">;
export const marketplaceCategory = (category: string) => ({ Engineering: "Engenharia", Sales: "Vendas", Strategy: "Estratégia", Marketing: "Marketing" })[category] ?? category;
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();

export function filterMarketplace<T extends SearchableEntry>(entries: readonly T[], search: string, source: string, availability: MarketplaceAvailability): T[] {
  const words = normalize(search).split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    if (source !== "all" && entry.source !== source) return false;
    if (availability === "importable" && !entry.installable) return false;
    if (availability === "installed" && entry.installed === "not_installed") return false;
    if (availability === "reference" && entry.installable) return false;
    const text = normalize(`${entry.name} ${entry.description} ${entry.category} ${marketplaceCategory(entry.category)}`);
    return words.every((word) => text.includes(word));
  });
}

export function marketplaceInstallDecision(entry: Pick<MarketplaceEntry, "installable" | "installed">, canInstall: boolean) {
  if (!entry.installable) return "reference";
  if (entry.installed !== "not_installed") return "installed";
  return canInstall ? "ready" : "admin_required";
}

export function sourceLink(value: string | null) {
  try { const url = new URL(value ?? ""); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}
