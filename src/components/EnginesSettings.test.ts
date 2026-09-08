import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { EnginesSettings } from "./EnginesSettings";

const fixture = vi.hoisted(() => ({ instances: [] as InstanceInfo[] }));
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
