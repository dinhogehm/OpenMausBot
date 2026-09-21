import { describe, expect, it } from "vitest";

import { createBotPackageExport, portableMcpServers } from "./package-export.ts";
import { parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";
import type { BotRecord } from "./store.ts";

describe("package export", () => {
  it("preserves the exact cron and timezone through export and import", () => {
    const schedule = { type: "cron" as const, expression: "0 9 L * *", timeZone: "America/New_York" };
    const exported = createBotPackageExport({
      name: "Monthly team", authorName: "Tester", groups: [],
      bots: [{ id: "b1", threadId: "t1", name: "Lead", color: "green", createdAt: 1 } as BotRecord],
      routines: [{ id: "r1", name: "Close the month", prompt: "Prepare a report", target: "bot", botId: "b1",
        runOn: "maus", enabled: true, schedule, durationMinutes: 30, nextRunAt: 1, createdAt: 1, updatedAt: 1,
        overlap: "queue", skippedRuns: 4, lastSkippedAt: 1, failureStreak: 2 }],
    });
    expect(exported.package.routines?.[0]).toMatchObject({ schedule, enabledAfterInstall: false });
    expect(parseBotPackage(renderBotPackageMarkdown(exported)).package.routines?.[0]?.schedule).toEqual(schedule);
    const imported = parseBotPackage(renderBotPackageMarkdown(exported)).package.routines?.[0];
    expect(imported?.overlap).toBe("queue");
    expect(imported).not.toHaveProperty("skippedRuns");
    expect(imported).not.toHaveProperty("lastSkippedAt");
    expect(imported).not.toHaveProperty("failureStreak");
  });

  it("keeps collaboration structure while excluding runtime authority and state", () => {
    const exported = createBotPackageExport({
      name: "Launch Crew",
      authorName: "Mira",
      bots: [
        {
          id: "private-id",
          threadId: "private-thread",
          name: "Lead",
          title: "Chief",
          description: "Coordinates",
          soul: "Preserve the mission.\n",
          notifications: true,
          color: "purple",
          unread: false,
          modelSelection: { instanceId: "private-engine", model: "secret-model", effort: "medium" },
          resumeCursors: { provider: "secret-session" },
          chiefOfStaff: true,
          composio: true,
          cwd: "/private/path",
          approvalMode: "full",
          autoApprove: true,
          alwaysAllow: ["everything"],
          installedPackage: {
            id: "source",
            name: "Source",
            release: "1.0.0",
            requiredApps: [{ slug: "github", label: "GitHub", reason: "Read repositories.", optional: true }],
          },
          playbooks: [{ key: "launch", name: "Launch", summary: "Ship", triggers: ["launch plan"], instructions: "Verify the release." }],
          createdAt: 1,
        },
      ],
      groups: [{
        id: "private-room-id",
        threadId: "private-room-thread",
        name: "Launch Room",
        memberIds: ["private-id"],
        defaultResponder: { kind: "member", botId: "private-id" },
        bulletin: "Ship carefully.",
        unread: false,
        createdAt: 1,
      }],
      routines: [
        {
          id: "private-routine-id",
          name: "Release check",
          prompt: "Verify release readiness.",
          target: "bot",
          botId: "private-id",
          runOn: "maus",
          enabled: true,
          schedule: { type: "daily", time: "09:00", weekdays: [1] },
          durationMinutes: 30,
          attachments: [{
            id: "private-attachment",
            kind: "file",
            name: "private.txt",
            path: "/private/calendar/context.txt",
            size: 42,
          }],
          nextRunAt: 123,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "private-room-routine-id",
          name: "Team release review",
          prompt: "Review the release together.",
          target: "room-goal",
          groupId: "private-room-id",
          botId: "private-id",
          runOn: "maus",
          enabled: true,
          schedule: { type: "daily", time: "10:00", weekdays: [1] },
          durationMinutes: 30,
          nextRunAt: 456,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "private-interval-routine-id",
          name: "Frequent release check",
          prompt: "Watch release readiness.",
          target: "bot",
          botId: "private-id",
          runOn: "maus",
          enabled: true,
          schedule: {
            type: "interval",
            everyMinutes: 15,
            anchorAt: 1_788_254_400_000,
            weekdays: [1, 3, 5],
            window: { start: "09:00", end: "17:00" },
            endsAt: 1_790_843_400_000,
          },
          durationMinutes: 30,
          timeoutMinutes: 20,
          nextRunAt: 789,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      skillsByBot: new Map([[
        "private-id",
        [{
          name: "source-check",
          description: "Check sources.",
          source: "conversation:source-check",
          instructions: "---\nname: source-check\ndescription: Check sources.\n---\n\n# Source check\n",
        }],
      ]]),
    });
    expect(exported.package.routines).toHaveLength(2);
    expect(exported.package.agents[0].soul).toBe("Preserve the mission.\n");
    expect(exported.package.routines?.[1]?.schedule).toEqual({
      type: "interval",
      everyMinutes: 15,
      anchorAt: 1_788_254_400_000,
      weekdays: [1, 3, 5],
      window: { start: "09:00", end: "17:00" },
      endsAt: 1_790_843_400_000,
    });
    expect(exported.package.routines?.[1]?.timeoutMinutes).toBe(20);

    expect(exported).toMatchObject({
      format: "openmaus.package",
      package: {
        chiefOfStaff: "lead",
        requirements: { apps: [{ slug: "github" }] },
        rooms: [{ members: ["lead"], defaultResponder: { kind: "agent", agent: "lead" } }],
        routines: [
          { agent: "lead", enabledAfterInstall: false },
          { agent: "lead", enabledAfterInstall: false },
        ],
        playbooks: [{ key: "launch" }],
        skills: { entries: [{ name: "source-check" }] },
        agents: [{ skills: ["source-check"] }],
      },
    });
    expect(JSON.stringify(exported)).not.toMatch(/private-id|private-thread|private-engine|secret-model|secret-session|private\/path|private-attachment|approvalMode|autoApprove|alwaysAllow|nextRunAt/);
  });

  it.each([
    { instructions: "---\nname: shared\ndescription: Shared\n---\ntwo" },
    { description: "Different" }, { source: "other" }, { license: "MIT" }, { compatibility: "Other" },
  ])("refuses conflicting portable skill content across selected bots: %j", (patch) => {
    const bot = (id: string): BotRecord => ({
      id,
      threadId: `thread-${id}`,
      name: id,
      title: "Researcher",
      description: "Researches leads",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "engine", model: "model", effort: "medium" },
      resumeCursors: {},
      createdAt: 1,
    });
    expect(() => createBotPackageExport({
      name: "Conflicting Skills",
      bots: [bot("one"), bot("two")],
      groups: [],
      routines: [],
      skillsByBot: new Map([
        ["one", [{ name: "shared", description: "Shared", instructions: "---\nname: shared\ndescription: Shared\n---\none" }]],
        ["two", [{ name: "shared", description: "Shared", instructions: "---\nname: shared\ndescription: Shared\n---\none", ...patch }]],
      ]),
    })).toThrow("conflicting content");
  });

  it("shares one identical playbook definition across multiple bots", () => {
    const sharedPlaybook = {
      key: "qualify",
      name: "Qualify",
      summary: "Check fit",
      triggers: ["qualify lead"],
      instructions: "Check the lead against the stated criteria.",
    };
    const bot = (id: string, name: string): BotRecord => ({
      id,
      threadId: `thread-${id}`,
      name,
      title: "Researcher",
      description: "Researches leads",
      notifications: true,
      color: "green" as const,
      unread: false,
      modelSelection: { instanceId: "engine", model: "model", effort: "medium" },
      resumeCursors: {},
      playbooks: [sharedPlaybook],
      createdAt: 1,
    });

    const exported = createBotPackageExport({
      name: "Lead Crew",
      bots: [bot("one", "Scout"), bot("two", "Reviewer")],
      groups: [],
      routines: [],
    });

    expect(exported.package.playbooks).toHaveLength(1);
    expect(exported.package.agents.map((agent) => agent.playbooks)).toEqual([
      ["qualify"],
      ["qualify"],
    ]);
  });

});

describe("workspace capabilities in a package", () => {
  const bots = [{ id: "b1", threadId: "t1", name: "Lead", color: "green", createdAt: 1 } as BotRecord];

  it("carries tool servers and catalogs as definitions, never as secrets", () => {
    const exported = createBotPackageExport({
      name: "Tooling team",
      bots,
      groups: [],
      routines: [],
      mcpServers: portableMcpServers({
        notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: { NOTES_TOKEN: "s3cret-value" } },
        docs: { type: "http", url: "https://docs.test/mcp", headers: { Authorization: "Bearer s3cret-value" } },
        off: { command: "node", args: ["server.js"], enabled: false },
      }),
      catalogs: [{ id: "acme", name: "Acme skills", url: "https://acme.test/skills.json" }],
    });

    expect(exported.package.mcpServers).toEqual([
      {
        transport: "stdio",
        name: "notes",
        reason: "Tool server this team uses (notes).",
        command: "npx",
        args: ["-y", "@x/notes-mcp"],
        envKeys: ["NOTES_TOKEN"],
      },
      {
        transport: "http",
        name: "docs",
        reason: "Tool server this team uses (docs).",
        type: "http",
        url: "https://docs.test/mcp",
        headerKeys: ["Authorization"],
      },
      // a server switched off is still a definition the recipient may want
      { transport: "stdio", name: "off", reason: "Tool server this team uses (off).", command: "node", args: ["server.js"] },
    ]);
    expect(exported.package.catalogs).toEqual([{ id: "acme", name: "Acme skills", url: "https://acme.test/skills.json" }]);

    // the round trip through the shareable markdown carries neither value
    const markdown = renderBotPackageMarkdown(exported);
    expect(markdown).not.toContain("s3cret-value");
    expect(markdown).toContain("## Tool servers (MCP)");
    expect(markdown).toContain("NOTES_TOKEN");
    expect(markdown).toContain("## Skill catalogs");
    const reparsed = parseBotPackage(markdown).package;
    expect(reparsed.mcpServers).toEqual(exported.package.mcpServers);
    expect(reparsed.catalogs).toEqual(exported.package.catalogs);
  });

  it("leaves both out when the workspace has neither", () => {
    const exported = createBotPackageExport({ name: "Plain", bots, groups: [], routines: [] });
    expect(exported.package.mcpServers).toBeUndefined();
    expect(exported.package.catalogs).toBeUndefined();
  });

  it("refuses a package that tries to ship a value instead of a name", () => {
    const withSecret = {
      format: "openmaus.package",
      version: 1,
      package: {
        ...createBotPackageExport({ name: "Plain", bots, groups: [], routines: [] }).package,
        mcpServers: [{
          transport: "stdio",
          name: "notes",
          reason: "Notes.",
          command: "npx",
          // an env VALUE dressed as a key name
          envKeys: ["NOTES_TOKEN=s3cret-value"],
        }],
      },
    };
    expect(() => parseBotPackage(withSecret as never)).toThrow(/environment variable name/);

    const httpServer = { transport: "http", name: "docs", reason: "Docs.", type: "http", url: "http://docs.test/mcp" };
    expect(() => parseBotPackage({
      ...withSecret,
      package: { ...withSecret.package, mcpServers: [httpServer] },
    } as never)).toThrow(/https/);
  });
});
