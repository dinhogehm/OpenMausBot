import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

// A package brings the workspace capabilities its bots need — tool servers
// and skill catalogs — as DEFINITIONS. This walks the whole install against
// a throwaway server: the names arrive, the values do not, an MCP server
// lands off, and a name already configured is left exactly as it was.
it("installs a package's tool servers off and its catalogs, without touching what is already there", async () => {
  const fixture = await launchVerificationServer();
  const url = fixture.info.url;
  const post = (path: string, body: unknown) => request(path, { method: "POST", body: JSON.stringify(body) }, url);

  const packageWith = (overrides: Record<string, unknown>) => ({
    format: "openmaus.package",
    version: 1,
    package: {
      id: "capability-probe",
      release: "1.0.0",
      name: "Capability probe",
      tagline: "Bring the tools along.",
      summary: "Checks that a package can carry workspace capabilities.",
      category: "Testing",
      author: { name: "Fixture" },
      license: "MIT",
      outcomes: ["Install tool servers without secrets."],
      setupMinutes: 2,
      requirements: { apps: [], capabilities: [] },
      agents: [{ key: "probe", name: "Capability probe bot", appearance: { color: "cyan" } }],
      ...overrides,
    },
  });

  try {
    // Something the user already configured, with a value only they have.
    await post("/api/mcp/servers", {
      name: "notes",
      command: "npx",
      args: ["-y", "@user/their-own-notes"],
      env: { NOTES_TOKEN: "the-users-own-token" },
    });

    const installed = await post("/api/teams/import", packageWith({
      mcpServers: [
        { transport: "stdio", name: "notes", reason: "Notes.", command: "npx", args: ["-y", "@pkg/notes"], envKeys: ["NOTES_TOKEN"] },
        { transport: "stdio", name: "tickets", reason: "Reads the tracker.", command: "npx", args: ["-y", "@pkg/tickets"], envKeys: ["TICKETS_TOKEN"] },
        { transport: "http", name: "docs", reason: "Looks things up.", type: "http", url: "https://docs.test/mcp", headerKeys: ["Authorization"] },
      ],
      catalogs: [{ id: "acme", name: "Acme skills", url: "https://acme.test/skills.json" }],
    }));

    expect(installed.capabilities).toEqual({
      mcpServers: ["tickets", "docs"],
      catalogs: ["acme"],
      // the name the user already owns is reported, not overwritten
      skipped: ["notes"],
    });

    const servers = await request("/api/mcp/servers", {}, url);
    const byName = new Map(servers.servers.map((server: { name: string }) => [server.name, server]));
    expect(byName.get("notes")).toMatchObject({ args: ["-y", "@user/their-own-notes"] });
    expect(byName.get("tickets")).toMatchObject({
      command: "npx",
      args: ["-y", "@pkg/tickets"],
      envKeys: ["TICKETS_TOKEN"],
      // off on arrival: the person supplies the value and switches it on
      enabled: false,
    });
    expect(byName.get("docs")).toMatchObject({
      type: "http",
      url: "https://docs.test/mcp",
      headerKeys: ["Authorization"],
      enabled: false,
    });
    // a listing echoes key names only, so no value can have been stored
    expect(JSON.stringify(servers)).not.toContain("the-users-own-token");

    const config = await request("/api/config", {}, url);
    expect(config.marketplaces).toEqual([{ id: "acme", name: "Acme skills", url: "https://acme.test/skills.json" }]);

    // Installing the same package again adds nothing a second time.
    const again = await post("/api/teams/import", packageWith({
      catalogs: [{ id: "acme", name: "Acme skills", url: "https://acme.test/skills.json" }],
    }));
    expect(again.capabilities).toEqual({ mcpServers: [], catalogs: [], skipped: [] });
    expect((await request("/api/config", {}, url)).marketplaces).toHaveLength(1);
  } finally {
    await fixture.close();
  }
}, 90_000);
