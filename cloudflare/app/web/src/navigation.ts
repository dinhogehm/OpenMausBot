import type { Section } from "./organization";

export const sectionPaths: Record<Section, string> = {
  coding: "tarefas", missions: "missoes", browser: "navegador", reports: "relatorios",
  repositories: "repositorios", agents: "agentes", marketplace: "marketplace",
  credentials: "conexoes", company: "empresa", runs: "ambiente",
};
export function routeHash(section: Section, organizationId: string): string {
  return `#/${sectionPaths[section]}${organizationId ? `?${new URLSearchParams({ empresa: organizationId })}` : ""}`;
}
export function readRoute(hash: string, search = ""): { section: Section; organizationId: string } {
  const callback = new URLSearchParams(search);
  if (callback.has("github")) return { section: "repositories", organizationId: callback.get("organization") ?? "" };
  const match = /^#\/([a-z-]+)(?:\?(.*))?$/.exec(hash);
  const section = match && (Object.keys(sectionPaths) as Section[]).find((key) => sectionPaths[key] === match[1]);
  if (!section) return { section: "coding", organizationId: "" };
  return { section, organizationId: new URLSearchParams(match[2]).get("empresa") ?? "" };
}
export function resolveOrganization(requested: string, memberships: Array<{ id: string }>): string {
  return memberships.some((membership) => membership.id === requested) ? requested : memberships[0]?.id ?? "";
}
