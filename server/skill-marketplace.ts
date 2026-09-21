// Skill catalogs: a configured source publishes an index, and a person picks
// from it. Deliberately NOT a single store — the workspace lists the sources
// it trusts (`marketplaces` in config.json), exactly as a package manager
// lists repositories, so a team can publish its own index in its own repo.
//
// The security posture is the one skills.ts already sets and this file does
// not widen: a catalog install fetches the same way a pasted URL does
// (skill-fetch.ts), is scanned and reviewed the same way, and lands DISABLED.
// A catalog can only ever tell a person that a skill exists and where it is;
// it never enables anything, and its `source` is refetched rather than
// trusted as content.
import { z } from "zod";

import { fetchSkillFromSource } from "./skill-fetch.ts";
import {
  installSkill,
  installedCatalogSkills,
  removeSkill,
  type SkillCatalogProvenance,
  type SkillListing,
} from "./skills.ts";

/** One catalog fetch: small, bounded, and quick to fail. An index is a list
 * of pointers, so a megabyte is already far more than any real one needs. */
const INDEX_MAX_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
export const MAX_CATALOG_ENTRIES = 300;
export const MAX_MARKETPLACES = 20;

export const marketplaceSourceSchema = z.object({
  /** Stable handle the install records, so a rename of the display name does
   * not orphan what is already installed. */
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "id must be lowercase letters, digits and hyphens"),
  name: z.string().trim().min(1).max(80).optional(),
  url: z.string().trim().url().refine((value) => value.startsWith("https://"), "the index URL must be https"),
});
export type MarketplaceSource = z.output<typeof marketplaceSourceSchema>;

const catalogEntrySchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().min(1).max(1024),
  /** What skill-fetch.ts already understands: owner/repo, a folder inside
   * one, or a direct SKILL.md URL. The catalog points; it never ships bytes. */
  source: z.string().trim().min(1).max(2000),
  version: z.string().trim().min(1).max(64).default("0"),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  license: z.string().trim().max(120).optional(),
  homepage: z.string().trim().url().max(2000).optional(),
});
export type CatalogEntry = z.output<typeof catalogEntrySchema>;

export const CATALOG_FORMAT = "openmaus.marketplace" as const;
const catalogSchema = z.object({
  format: z.literal(CATALOG_FORMAT),
  version: z.literal(1),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(1024).optional(),
  skills: z.array(catalogEntrySchema).max(MAX_CATALOG_ENTRIES),
});

export type CatalogFetch =
  | { ok: true; name: string; description?: string; entries: CatalogEntry[] }
  | { ok: false; error: string };

/** Read one index. Never throws: a broken or hostile source degrades to a
 * message beside that marketplace, and the others still list. */
export async function fetchCatalog(source: MarketplaceSource, fetcher: typeof fetch = fetch): Promise<CatalogFetch> {
  let response: Response;
  try {
    response = await fetcher(source.url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // The key-free public index is still someone else's host: never replay
      // the request wherever its front door points today.
      redirect: "manual",
    });
  } catch (error) {
    return { ok: false, error: `could not reach the catalog: ${(error as Error).message}` };
  }
  if (!response.ok) return { ok: false, error: `the catalog returned HTTP ${response.status}` };
  const size = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(size) && size > INDEX_MAX_BYTES) return { ok: false, error: "the catalog is larger than 512KB" };
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return { ok: false, error: `could not read the catalog: ${(error as Error).message}` };
  }
  if (Buffer.byteLength(text) > INDEX_MAX_BYTES) return { ok: false, error: "the catalog is larger than 512KB" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "the catalog is not valid JSON" };
  }
  const catalog = catalogSchema.safeParse(parsed);
  if (!catalog.success) {
    return { ok: false, error: `this is not an ${CATALOG_FORMAT} v1 index: ${catalog.error.issues[0]?.message ?? "invalid"}` };
  }
  const seen = new Set<string>();
  const entries = catalog.data.skills.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
  return { ok: true, name: catalog.data.name ?? source.name ?? source.id, description: catalog.data.description, entries };
}

export type CatalogEntryState = "available" | "installed" | "outdated";

export interface CatalogEntryView extends CatalogEntry {
  state: CatalogEntryState;
  /** The skill name this entry is installed under, when it is. */
  installedAs?: string;
  /** The release this bot has, which is what makes an entry outdated. */
  installedVersion?: string;
}

/** The catalog as one bot sees it: untouched entries, the ones it already
 * has, and the ones whose catalog release moved past what it installed.
 * Matching is by (marketplace, entry id) — the recorded provenance — never
 * by display name, so a renamed entry does not read as a second skill. */
export function catalogView(
  marketplaceId: string,
  entries: CatalogEntry[],
  installed: Record<string, SkillCatalogProvenance>,
): CatalogEntryView[] {
  const byEntryId = new Map<string, { name: string; version: string }>();
  for (const [name, provenance] of Object.entries(installed)) {
    if (provenance.marketplaceId === marketplaceId) byEntryId.set(provenance.entryId, { name, version: provenance.version });
  }
  return entries.map((entry) => {
    const mine = byEntryId.get(entry.id);
    if (!mine) return { ...entry, state: "available" as const };
    return {
      ...entry,
      state: mine.version === entry.version ? ("installed" as const) : ("outdated" as const),
      installedAs: mine.name,
      installedVersion: mine.version,
    };
  });
}

/** Install one catalog entry into a bot: refetch from its own source, then
 * hand the files to the same reviewed install path a pasted URL uses. The
 * skill lands disabled with its catalog release recorded. */
export async function installCatalogEntry(
  botId: string,
  marketplaceId: string,
  entry: CatalogEntry,
  fetcher: typeof fetch = fetch,
): Promise<{ installed: SkillListing[]; errors: string[] } | { error: string }> {
  const fetched = await fetchSkillFromSource(entry.source, fetcher);
  if ("error" in fetched) return { error: fetched.error };
  const catalog: SkillCatalogProvenance = { marketplaceId, entryId: entry.id, version: entry.version };
  const results = fetched.skills.map((skill) => installSkill(botId, skill.source, skill.files, { catalog }));
  const installed = results.filter((result): result is SkillListing => !("error" in result));
  const errors = results.flatMap((result) => ("error" in result ? [result.error] : []));
  if (!installed.length) return { error: errors.join("; ") || "nothing importable found at that source" };
  return { installed, errors };
}

/** Replace an installed catalog skill with the catalog's current release.
 * The replacement lands DISABLED like any import: an update is new text to
 * read, not a decision already made. Removal happens only once the new files
 * are in hand, so a failed fetch leaves the working skill in place. */
export async function updateCatalogSkill(
  botId: string,
  marketplaceId: string,
  entry: CatalogEntry,
  skillName: string,
  fetcher: typeof fetch = fetch,
): Promise<{ installed: SkillListing[]; errors: string[] } | { error: string }> {
  const current = installedCatalogSkills(botId)[skillName];
  if (!current) return { error: `"${skillName}" was not installed from a catalog` };
  if (current.marketplaceId !== marketplaceId || current.entryId !== entry.id) {
    return { error: `"${skillName}" came from a different catalog entry — remove it first` };
  }
  const fetched = await fetchSkillFromSource(entry.source, fetcher);
  if ("error" in fetched) return { error: fetched.error };
  const removed = removeSkill(botId, skillName);
  if ("error" in removed) return { error: removed.error };
  const catalog: SkillCatalogProvenance = { marketplaceId, entryId: entry.id, version: entry.version };
  const results = fetched.skills.map((skill) => installSkill(botId, skill.source, skill.files, { catalog }));
  const installed = results.filter((result): result is SkillListing => !("error" in result));
  const errors = results.flatMap((result) => ("error" in result ? [result.error] : []));
  if (!installed.length) return { error: errors.join("; ") || "the new release had nothing importable" };
  return { installed, errors };
}
