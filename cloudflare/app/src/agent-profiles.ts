import type { AppEnv } from "./env";
import { HttpError, json } from "./http";
import { requireMembership } from "./organizations";
import { credentialVersion } from "./model-broker";
import type { AgentProfile, CodingRunInput, ResolvedAgent } from "./coding-types";
import { catalogueInstructions, parseAgentSelections, readAgentCatalog } from "./agent-catalog";

export const defaultAgents: AgentProfile[] = [
  { role: "coordinator", name: "Coordenador", instructions: "Entenda o objetivo, leia as instruções do repositório e prepare um plano curto com critérios verificáveis. Respeite o escopo aprovado e o processo de entrega do projeto.", provider: "inherit", model: "" },
  { role: "programmer", name: "Programador", instructions: "Implemente o plano com alterações focadas. Leia o código antes de editar, preserve o trabalho existente e corrija as falhas relevantes de testes.", provider: "inherit", model: "" },
  { role: "reviewer", name: "Revisor", instructions: "Revise o diff e os resultados reais dos testes. Procure defeitos, regressões e falhas de autorização. Aprove somente se o resultado atender ao objetivo; descreva correções necessárias de forma concreta.", provider: "inherit", model: "" },
];
export function validateAgents(value: unknown): AgentProfile[] {
  if (!Array.isArray(value) || value.length !== 3) throw new HttpError(400, "invalid_agents");
  const seen = new Set<string>();
  const profiles = value.map((profile) => {
    if (!profile || typeof profile !== "object") throw new HttpError(400, "invalid_agents");
    const p = profile as Record<string, unknown>;
    if (!["coordinator", "programmer", "reviewer"].includes(String(p.role)) || seen.has(String(p.role))
      || typeof p.name !== "string" || !p.name.trim() || p.name.length > 80 || !p.name.isWellFormed()
      || typeof p.instructions !== "string" || !p.instructions.trim() || p.instructions.length > 4000 || !p.instructions.isWellFormed()
      || !["inherit", "openai", "anthropic", "openrouter"].includes(String(p.provider))
      || typeof p.model !== "string" || p.model.length > 120 || (p.model !== "" && !/^[A-Za-z0-9_][A-Za-z0-9_./:@-]*$/.test(p.model))
      || (p.provider !== "inherit" && !p.model)) throw new HttpError(400, "invalid_agents");
    seen.add(String(p.role));
    return { role: p.role, name: p.name.trim(), instructions: p.instructions.trim(), provider: p.provider, model: p.model } as AgentProfile;
  });
  return defaultAgents.map((agent) => profiles.find((profile) => profile.role === agent.role)!);
}
export async function readAgentTeam(env: AppEnv, organizationId: string) {
  const row = await env.DB.prepare("SELECT version, profiles FROM agent_teams WHERE organization_id = ?").bind(organizationId).first<{ version: number; profiles: string }>();
  return { version: row?.version ?? 0, agents: row ? validateAgents(JSON.parse(row.profiles)) : structuredClone(defaultAgents) };
}
export async function agentProfilesRoute(env: AppEnv, organizationId: string, userId: string, method: string, body: Record<string, unknown>) {
  await requireMembership(env.DB, organizationId, userId, method === "PUT");
  if (method === "GET") return json(await readAgentTeam(env, organizationId));
  if (method !== "PUT") throw new HttpError(404, "not_found");
  const agents = validateAgents(body.agents); const expected = body.expectedVersion;
  if (!Number.isSafeInteger(expected) || Number(expected) < 0) throw new HttpError(400, "invalid_version");
  const result = await env.DB.prepare(`INSERT INTO agent_teams (organization_id, version, profiles, updated_at, updated_by)
    SELECT ?, 1, ?, ?, ? WHERE ? = 0 AND EXISTS (SELECT 1 FROM memberships WHERE organization_id = ? AND user_id = ? AND role IN ('owner','admin'))
    ON CONFLICT(organization_id) DO NOTHING`).bind(organizationId, JSON.stringify(agents), Date.now(), userId, expected, organizationId, userId).run();
  if (Number(expected) > 0) {
    const updated = await env.DB.prepare(`UPDATE agent_teams SET version=version+1, profiles=?, updated_at=?, updated_by=? WHERE organization_id=? AND version=?
      AND EXISTS (SELECT 1 FROM memberships WHERE organization_id=? AND user_id=? AND role IN ('owner','admin'))`)
      .bind(JSON.stringify(agents), Date.now(), userId, organizationId, expected, organizationId, userId).run();
    if (updated.meta.changes !== 1) throw new HttpError(409, "agents_changed");
  } else if (result.meta.changes !== 1) throw new HttpError(409, "agents_changed");
  return json({ version: Number(expected) + 1, agents });
}
export async function resolveAgents(env: AppEnv, organizationId: string, input: CodingRunInput): Promise<ResolvedAgent[]> {
  const catalogue = await readAgentCatalog(env, organizationId);
  const selection = input.agentSelections === undefined
    ? catalogue.selections && { catalogVersion: catalogue.version, ...catalogue.selections }
    : parseAgentSelections(input.agentSelections);
  if (selection) {
    if (selection.catalogVersion !== catalogue.version) throw new HttpError(409, "agent_catalog_changed");
    const profiles = defaultAgents.map(({ role }) => {
      const profile = catalogue.agents.find((agent) => agent.id === selection[role]);
      if (!profile) throw new HttpError(400, "invalid_agent_selection");
      return { role, name: profile.name, instructions: catalogueInstructions(profile), provider: input.provider, model: input.model,
        profileId: profile.id, profileRevision: profile.revision, catalogVersion: catalogue.version };
    });
    const version = await credentialVersion(env, organizationId, input.provider);
    return profiles.map((profile) => ({ ...profile, credentialVersion: version }));
  }
  const team = await readAgentTeam(env, organizationId);
  return Promise.all(team.agents.map(async (agent) => {
    const provider = agent.provider === "inherit" ? input.provider : agent.provider;
    return { ...agent, provider, model: agent.model || input.model, credentialVersion: await credentialVersion(env, organizationId, provider) };
  }));
}
