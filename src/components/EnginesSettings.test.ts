import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { EnginesSettings } from "./EnginesSettings";
import { ClaudeAccountForm } from "./ClaudeAccountSettings";

const fixture = vi.hoisted(() => ({ instances: [] as InstanceInfo[], bots: [] as Bot[] }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture, refreshInstances: async () => {}, refreshModels: async () => {} }),
}));
afterEach(() => vi.unstubAllGlobals());

function render(authenticated: boolean): string {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { userAgent: "Linux" });
  fixture.instances = [{
    instanceId: "codex",
    driverKind: "codexAgent",
    displayName: "Codex",
    cliDefault: "codex",
    snapshot: { state: "available", authenticated },
    models: { default: "model", options: [] },
    authentication: { method: "device-code" },
    install: { signInCommand: "codex login" },
  }];
  return renderToStaticMarkup(createElement(EnginesSettings));
}

describe("Settings → Engines → Codex", () => {
  it("makes browser sign-in discoverable in Settings, not only the model picker", () => {
    expect(render(false)).toContain("Connect ChatGPT");
  });

  it("shows a connected account without offering to replace it", () => {
    const html = render(true);
    expect(html).toContain("ChatGPT connected on this server");
    expect(html).not.toContain("Connect ChatGPT");
  });
});

describe("Settings → Engines → Claude accounts", () => {
  function claude(authenticated?: boolean, isDefault = false): InstanceInfo {
    return {
      instanceId: isDefault ? "claude" : "claude-work",
      driverKind: "claudeAgent",
      displayName: "Work",
      cliDefault: "claude",
      snapshot: { state: "available", authenticated, account: { email: "work@example.test", organization: "Studio" } },
      models: { default: "sonnet", options: [] },
      claudeAccount: { configDir: "/profiles/work", signInCommand: "CLAUDE_CONFIG_DIR=/profiles/work claude auth login", signInShell: "sh", isDefault },
    };
  }

  function renderClaude(instance: InstanceInfo, assigned = false) {
    fixture.instances = [instance];
    fixture.bots = assigned ? [{ modelSelection: { instanceId: instance.instanceId } } as Bot] : [];
    return renderToStaticMarkup(createElement(EnginesSettings));
  }

  it("offers an account name and an optional directory without implying sign-in", () => {
    const markup = renderToStaticMarkup(createElement(ClaudeAccountForm, { onSaved: () => {} }));
    expect(markup).toContain("Personal or Work");
    expect(markup).toContain("Automatic private directory");
    expect(markup).toContain("not a signed-in session");
    expect(markup).toContain("T3");
    expect(markup).not.toContain("Claude connected");
    expect(renderClaude(claude())).toContain("Add Claude account");
  });

  it("uses the exact server command and directs remote users to the server", () => {
    const markup = renderClaude(claude(false));
    expect(markup).toContain("CLAUDE_CONFIG_DIR=/profiles/work claude auth login");
    expect(markup).toContain("run it on the server, not this device");
    expect(markup).toContain("Check account");
    expect(markup).toContain("Sign-in required");
    expect(markup).not.toContain("Claude connected");
    expect(markup).not.toContain("work@example.test");
  });

  it("only announces a connected account from its authenticated snapshot", () => {
    expect(renderClaude(claude())).toContain("Account status unknown");
    const connected = renderClaude(claude(true));
    expect(connected).toContain("Claude connected");
    expect(connected).toContain("work@example.test · Studio");
  });

  it("labels the server's Windows command and keeps the default directory implicit", () => {
    const instance = claude(true, true);
    instance.claudeAccount = { ...instance.claudeAccount!, configDir: "", signInShell: "powershell" };
    const markup = renderClaude(instance);
    expect(markup).toContain("Use PowerShell for this command.");
    expect(markup).toContain("Normal Claude configuration");
    expect(markup).toMatch(/placeholder="Normal Claude configuration"[^>]*value=""/);
  });

  it("protects the default and assigned accounts and explains credential preservation", () => {
    const defaultMarkup = renderClaude(claude(true, true));
    expect(defaultMarkup).toContain("Default account");
    expect(defaultMarkup).not.toContain(">Remove account</button>");
    const assignedMarkup = renderClaude(claude(true), true);
    expect(assignedMarkup).toMatch(/<button[^>]*disabled=""[^>]*>Remove account<\/button>/);
    expect(assignedMarkup).toContain("Choose a different engine for every bot");
    expect(renderClaude(claude(true))).toContain("credentials and files stay on disk");
  });
});
