import type { AppEnv } from "./env";
import { HttpError, json } from "./http";
import { requireMembership } from "./organizations";
import { agentCatalogRoute, readAgentCatalog, validateCatalogDrafts } from "./agent-catalog";
import type { AgentCatalogDraft, AgentCatalogResponse, AgentCatalogState } from "./agent-catalog-types";
import type { MarketplaceEntry, MarketplaceInstallResult, MarketplaceListing, MarketplacePreview, MarketplaceSource } from "./marketplace-types";
import { GROK_SNAPSHOT_DIGEST, MARKETPLACE_CHECKED_AT, OMB_LICENSE, OMB_REVISION, grokListings, ombTeams } from "./marketplace-data";

const repository = "https://github.com/milind-soni/openmausbot-teams";
const snapshotVersion = `omb-${OMB_REVISION}-grok-${GROK_SNAPSHOT_DIGEST}`;
const excluded = ["Skills e plugins do pacote", "Rotinas e agendamentos", "Conexões, credenciais e autorizações externas", "Salas, memória e histórico"];
type Definition = Omit<MarketplaceEntry, "installed" | "profileIds"> & { profiles: AgentCatalogDraft[] };
const definitions: Definition[] = [
  ...ombTeams.map((team): Definition => {
    const profiles = validateCatalogDrafts(team.members.map((member) => ({
      sourceId: `marketplace-omb-${team.slug}-${member.key}`, name: member.name, title: member.title,
      description: member.description, instructions: team.bulletin, section: team.name,
      sourceEngine: "", sourceModel: "", sourceEffort: "",
    })));
    return { id: `omb-${team.slug}`, source: "omb", kind: "team", name: team.name, description: team.summary,
      category: team.category, author: "Milind Soni e colaboradores do OpenMausBot/BotMRR", sourceUrl: `${repository}/blob/${OMB_REVISION}/${team.manifest}`,
      version: OMB_REVISION, license: { id: "MIT", url: `${repository}/blob/${OMB_REVISION}/LICENSE`, notice: OMB_LICENSE },
      installable: true, unavailableReason: null, profileCount: profiles.length, profiles,
      requiredCapabilities: team.requiredApps, excludedFeatures: excluded };
  }),
  ...grokListings.map((bot): Definition => ({ id: `grokbot-${bot.slug}`, source: "grokbot", kind: "agent", name: bot.name,
    description: "Referência do catálogo oficial. Consulte a página de origem para conhecer o perfil e seus requisitos.",
    category: bot.category, author: bot.author, sourceUrl: `https://x.ai/bot/marketplace/bots/${bot.slug}`,
    version: `snapshot-${GROK_SNAPSHOT_DIGEST}`, license: { id: null, url: null, notice: null },
    installable: false, unavailableReason: "A licença de redistribuição do perfil não foi confirmada. O Veltram oferece o link oficial; este bot não é instalado nem executado aqui.",
    profileCount: 0, profiles: [], requiredCapabilities: ["Requisitos e conexões devem ser conferidos no Grok Bot"], excludedFeatures: ["Perfil e instruções do bot", "Integrações e automações do Grok Bot"] })),
];
const sources: MarketplaceSource[] = [
  { id: "omb", name: "OpenMausBot · BotMRR", url: repository, checkedAt: MARKETPLACE_CHECKED_AT, coverage: "complete_snapshot", revision: OMB_REVISION,
    note: `As ${ombTeams.length} equipes do catalog.json nesta revisão. Instala somente os ${ombTeams.reduce((sum, team) => sum + team.members.length, 0)} perfis de compatibilidade e a orientação compartilhada; não instala pacotes completos.` },
  { id: "grokbot", name: "Grok Bot", url: "https://x.ai/bot/marketplace", checkedAt: MARKETPLACE_CHECKED_AT, coverage: "complete_snapshot", revision: GROK_SNAPSHOT_DIGEST,
    note: `${grokListings.length} referências únicas observadas no índice público e em suas nove categorias. Snapshot de nomes, autores, categorias e links; não inclui perfis privados nem copia instruções ou imagens. A fonte pode mudar após a consulta.` },
];

function draftOf(profile: AgentCatalogDraft): AgentCatalogDraft {
  const { sourceId, name, title, description, instructions, section, sourceEngine, sourceModel, sourceEffort } = profile;
  return { sourceId, name, title, description, instructions, section, sourceEngine, sourceModel, sourceEffort };
}
function view(definition: Definition, catalog: AgentCatalogState): MarketplaceEntry {
  const { profiles, ...entry } = definition;
  const existing = profiles.flatMap((profile) => { const found = catalog.agents.find((agent) => agent.sourceId === profile.sourceId); return found ? [found] : []; });
  const customized = existing.some((agent) => JSON.stringify(draftOf(agent)) !== JSON.stringify(profiles.find((profile) => profile.sourceId === agent.sourceId)));
  return { ...entry, installed: customized ? "modified" : profiles.length > 0 && existing.length === profiles.length ? "installed" : "not_installed", profileIds: existing.map((agent) => agent.id) };
}

/** The reviewed bundle is the only source of content. No caller-supplied URL, script or plugin is fetched or executed. */
export async function handleMarketplaceRoute(request: Request, env: AppEnv, userId: string, body: Record<string, unknown> = {}): Promise<Response | null> {
  const match = /^\/api\/organizations\/([A-Za-z0-9_-]{1,80})\/marketplace(?:\/([A-Za-z0-9_-]{1,100}))?$/.exec(new URL(request.url).pathname);
  if (!match) return null;
  const [, organizationId, suffix] = match;
  const installing = request.method === "POST" && suffix === "install";
  const role = await requireMembership(env.DB, organizationId, userId, installing);
  if (installing) {
    const definition = definitions.find((item) => item.id === body.entryId);
    if (!definition) throw new HttpError(404, "marketplace_not_found");
    if (!definition.installable) throw new HttpError(409, "marketplace_external_only");
    if (body.version !== definition.version) throw new HttpError(409, "marketplace_version_changed");
    // Internal preserveExisting is never accepted from an HTTP payload. Known
    // retries replay their receipt before checking later customized profiles.
    const response = await agentCatalogRoute(env, organizationId, userId, "POST", {
      expectedVersion: body.expectedCatalogVersion, requestId: body.requestId, agents: definition.profiles,
    }, true, true);
    const catalog = await response.json() as AgentCatalogResponse;
    return json({ entryId: definition.id, catalog, profileIds: catalog.agents.filter((agent) => definition.profiles.some((profile) => profile.sourceId === agent.sourceId)).map((agent) => agent.id) } satisfies MarketplaceInstallResult);
  }
  if (request.method !== "GET") throw new HttpError(404, "not_found");
  const catalog = await readAgentCatalog(env, organizationId), canInstall = role !== "member";
  if (suffix) {
    const definition = definitions.find((item) => item.id === suffix);
    if (!definition) throw new HttpError(404, "marketplace_not_found");
    return json({ entry: view(definition, catalog), catalogVersion: catalog.version, canInstall, profiles: definition.profiles } satisfies MarketplacePreview);
  }
  return json({ version: snapshotVersion, catalogVersion: catalog.version, canInstall, sources, items: definitions.map((definition) => view(definition, catalog)) } satisfies MarketplaceListing);
}
