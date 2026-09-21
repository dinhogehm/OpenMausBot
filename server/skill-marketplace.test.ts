import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CATALOG_FORMAT,
  catalogView,
  fetchCatalog,
  installCatalogEntry,
  marketplaceSourceSchema,
  updateCatalogSkill,
  type CatalogEntry,
} from "./skill-marketplace.ts";
import { installedCatalogSkills, listSkills, readSkillFile, setSkillEnabled } from "./skills.ts";

const SOURCE = { id: "nuria", name: "Nuria skills", url: "https://example.test/catalog.json" };

function catalog(entries: Array<Partial<CatalogEntry> & { id: string }>) {
  return {
    format: CATALOG_FORMAT,
    version: 1,
    name: "Nuria skills",
    skills: entries.map((entry) => ({
      description: "Publishes the release carrier",
      source: "https://github.com/owner/repo/tree/main/skills/release",
      version: "1.0.0",
      ...entry,
    })),
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A SKILL.md the reviewed install path accepts. */
const skillMd = (name: string, body = "Run the carrier, then publish.") =>
  `---\nname: ${name}\ndescription: ${name} instructions for the fixture\n---\n\n${body}\n`;

/** skill-fetch resolves `owner/repo/path` through the GitHub contents API and
 * then downloads each file, so the double answers three shapes: the catalog
 * index, a directory listing, and the raw markdown. */
const RAW = "https://raw.test/SKILL.md";
function fetcherFor(markdown: string, catalogBody: unknown) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === SOURCE.url) return jsonResponse(catalogBody);
    if (url.includes("/contents/")) {
      return jsonResponse([{ name: "SKILL.md", path: "skills/release/SKILL.md", type: "file", download_url: RAW }]);
    }
    if (url === RAW) return new Response(markdown, { status: 200, headers: { "content-type": "text/plain" } });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("marketplace source", () => {
  it("accepts an https index and refuses anything else", () => {
    expect(marketplaceSourceSchema.safeParse(SOURCE).success).toBe(true);
    expect(marketplaceSourceSchema.safeParse({ ...SOURCE, url: "http://example.test/c.json" }).success).toBe(false);
    expect(marketplaceSourceSchema.safeParse({ ...SOURCE, id: "Nuria Skills" }).success).toBe(false);
    expect(marketplaceSourceSchema.safeParse({ ...SOURCE, id: "" }).success).toBe(false);
  });
});

describe("fetchCatalog", () => {
  it("reads an index, keeps the first of duplicate ids and defaults the version", async () => {
    const body = catalog([{ id: "release" }, { id: "release", description: "a second claim on the same id" }, { id: "triage", version: undefined as never }]);
    const result = await fetchCatalog(SOURCE, fetcherFor(skillMd("unused"), body));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((entry) => entry.id)).toEqual(["release", "triage"]);
    expect(result.entries[0]!.description).toBe("Publishes the release carrier");
    expect(result.entries[1]!.version).toBe("0");
    expect(result.name).toBe("Nuria skills");
  });

  it("degrades to a message instead of throwing", async () => {
    const cases: Array<[unknown, RegExp]> = [
      ["not json at all", /not valid JSON/],
      [{ format: "something.else", version: 1, skills: [] }, /openmaus\.marketplace v1/],
      [{ format: CATALOG_FORMAT, version: 2, skills: [] }, /openmaus\.marketplace v1/],
      [catalog([{ id: "release", source: "" }]), /openmaus\.marketplace v1/],
    ];
    for (const [body, expected] of cases) {
      const result = await fetchCatalog(SOURCE, fetcherFor(skillMd("unused"), body));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(expected);
    }
    const http = await fetchCatalog(SOURCE, (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch);
    expect(http).toMatchObject({ ok: false, error: expect.stringContaining("503") });
    const offline = await fetchCatalog(SOURCE, (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch);
    expect(offline).toMatchObject({ ok: false, error: expect.stringContaining("could not reach") });
  });

  it("never follows a redirect and bounds the index", async () => {
    const seen: RequestInit[] = [];
    const fetcher = (async (_input: unknown, init: RequestInit) => {
      seen.push(init);
      return jsonResponse("x".repeat(600 * 1024));
    }) as unknown as typeof fetch;
    const result = await fetchCatalog(SOURCE, fetcher);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("512KB") });
    expect(seen[0]!.redirect).toBe("manual");
  });
});

describe("catalogView", () => {
  const entries = [
    { id: "release", description: "d", source: "https://github.com/owner/repo", version: "2.0.0" },
    { id: "triage", description: "d", source: "https://github.com/owner/repo", version: "1.0.0" },
    { id: "unrelated", description: "d", source: "https://github.com/owner/repo", version: "1.0.0" },
  ] satisfies CatalogEntry[];

  it("tells installed, outdated and available apart by recorded provenance", () => {
    const view = catalogView("nuria", entries, {
      "release-carrier": { marketplaceId: "nuria", entryId: "release", version: "1.0.0" },
      triagem: { marketplaceId: "nuria", entryId: "triage", version: "1.0.0" },
      other: { marketplaceId: "another-catalog", entryId: "unrelated", version: "1.0.0" },
    });
    expect(view.map((entry) => [entry.id, entry.state])).toEqual([
      ["release", "outdated"],
      ["triage", "installed"],
      // installed from a different catalog: not this catalog's business
      ["unrelated", "available"],
    ]);
    expect(view[0]).toMatchObject({ installedAs: "release-carrier", installedVersion: "1.0.0" });
  });
});

// server/testing/setup.ts already hands this file a throwaway HOME, so the
// installs below land in its own ~/.openmausbot and never the real one.
describe("installing and updating from a catalog", () => {
  // One bot per test: these installs write real files under the throwaway
  // HOME, and a shared bot would let one test's release leak into the next.
  let BOT = "";
  let seq = 0;

  beforeEach(() => {
    BOT = `marketplace-fixture-bot-${++seq}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("installs disabled, records the release, and refuses a second install of the same name", async () => {
    const body = catalog([{ id: "release", version: "1.0.0" }]);
    const fetcher = fetcherFor(skillMd("release-carrier"), body);
    const fetched = await fetchCatalog(SOURCE, fetcher);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;

    const result = await installCatalogEntry(BOT, SOURCE.id, fetched.entries[0]!, fetcher);
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.installed).toHaveLength(1);
    // the reviewed path owns enablement: a catalog never turns a skill on
    expect(result.installed[0]).toMatchObject({ name: "release-carrier", enabled: false });
    expect(installedCatalogSkills(BOT)["release-carrier"]).toEqual({ marketplaceId: "nuria", entryId: "release", version: "1.0.0" });
    expect(readSkillFile(BOT, "release-carrier")).toContain("Run the carrier");

    const again = await installCatalogEntry(BOT, SOURCE.id, fetched.entries[0]!, fetcher);
    expect(again).toMatchObject({ error: expect.stringContaining("already imported") });
  });

  it("an update replaces the files, records the new release and lands disabled again", async () => {
    const first = fetcherFor(skillMd("release-carrier", "version one"), catalog([{ id: "release", version: "1.0.0" }]));
    const fetched = await fetchCatalog(SOURCE, first);
    if (!fetched.ok) throw new Error("catalog fixture did not load");
    await installCatalogEntry(BOT, SOURCE.id, fetched.entries[0]!, first);
    expect(setSkillEnabled(BOT, "release-carrier", true)).toMatchObject({ enabled: true });

    const second = fetcherFor(skillMd("release-carrier", "version two, with a new step"), catalog([{ id: "release", version: "2.0.0" }]));
    const newer = await fetchCatalog(SOURCE, second);
    if (!newer.ok) throw new Error("catalog fixture did not load");
    const updated = await updateCatalogSkill(BOT, SOURCE.id, newer.entries[0]!, "release-carrier", second);
    expect(updated).not.toHaveProperty("error");
    expect(readSkillFile(BOT, "release-carrier")).toContain("version two");
    expect(installedCatalogSkills(BOT)["release-carrier"]!.version).toBe("2.0.0");
    // new text is a new decision: the update does not inherit "enabled"
    expect(listSkills(BOT).find((skill) => skill.name === "release-carrier")).toMatchObject({ enabled: false });
  });

  it("keeps the working skill when the new release cannot be fetched", async () => {
    const first = fetcherFor(skillMd("release-carrier", "version one"), catalog([{ id: "release", version: "1.0.0" }]));
    const fetched = await fetchCatalog(SOURCE, first);
    if (!fetched.ok) throw new Error("catalog fixture did not load");
    await installCatalogEntry(BOT, SOURCE.id, fetched.entries[0]!, first);

    const broken = (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch;
    const failed = await updateCatalogSkill(BOT, SOURCE.id, { ...fetched.entries[0]!, version: "2.0.0" }, "release-carrier", broken);
    expect(failed).toHaveProperty("error");
    expect(readSkillFile(BOT, "release-carrier")).toContain("version one");
    expect(installedCatalogSkills(BOT)["release-carrier"]!.version).toBe("1.0.0");
  });

  it("refuses to update a skill that came from somewhere else", async () => {
    const fetcher = fetcherFor(skillMd("release-carrier"), catalog([{ id: "release" }]));
    const fetched = await fetchCatalog(SOURCE, fetcher);
    if (!fetched.ok) throw new Error("catalog fixture did not load");
    await installCatalogEntry(BOT, SOURCE.id, fetched.entries[0]!, fetcher);
    const foreign = await updateCatalogSkill(BOT, "another-catalog", fetched.entries[0]!, "release-carrier", fetcher);
    expect(foreign).toMatchObject({ error: expect.stringContaining("different catalog entry") });
    const unknown = await updateCatalogSkill(BOT, SOURCE.id, fetched.entries[0]!, "never-installed", fetcher);
    expect(unknown).toMatchObject({ error: expect.stringContaining("not installed from a catalog") });
  });
});
