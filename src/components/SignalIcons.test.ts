import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { ccSessionsSummary } from "@/lib/thread-signals";
import { SignalIcons } from "./SignalIcons";

beforeEach(() => setLocale("pt-br"));
afterEach(() => setLocale("en"));

describe("the sessions icon", () => {
  it("marks a headless session in amber, with where it runs in the label", () => {
    const sessions = ccSessionsSummary([{ sessionId: "a", title: "#9315 lote", status: "running", surface: "cli" }]);
    const html = renderToStaticMarkup(createElement(SignalIcons, { watch: null, cc: null, sessions }));
    expect(html).toContain("data-thread-cc-sessions");
    expect(html).toContain('data-cli="true"');
    expect(html).toContain("text-warning");
    expect(html).toContain("#9315 lote — trabalhando · CLI, não aparece no app Claude");
    expect(renderToStaticMarkup(createElement(SignalIcons, { watch: null, cc: null }))).toBe("");
  });
});
