import type { AgentCatalogDraft } from "../../src/agent-catalog-types";

export type ProfileDrafts = Record<string, AgentCatalogDraft>;
export const getProfileDraft = (drafts: ProfileDrafts, sourceId: string): AgentCatalogDraft | undefined =>
  Object.hasOwn(drafts, sourceId) ? drafts[sourceId] : undefined;
const sameProfile = (left: AgentCatalogDraft, right: AgentCatalogDraft) =>
  (Object.keys(left) as (keyof AgentCatalogDraft)[]).every((key) => left[key] === right[key]);
export function updateProfileDraft(drafts: ProfileDrafts, original: AgentCatalogDraft, next: AgentCatalogDraft): ProfileDrafts {
  const result = { ...drafts };
  if (sameProfile(original, next)) delete result[original.sourceId];
  else return { ...result, [original.sourceId]: next };
  return result;
}
export function acceptProfileChanges(drafts: ProfileDrafts, committed: AgentCatalogDraft[]): ProfileDrafts {
  const result = { ...drafts };
  for (const profile of committed) {
    if (getProfileDraft(result, profile.sourceId) && sameProfile(result[profile.sourceId], profile)) delete result[profile.sourceId];
  }
  return result;
}
