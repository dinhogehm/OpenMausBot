// The pre-flight editor's contract: every check is editable in place with
// its kind visible, the shared validator's messages are painted beside the
// fields, the test button's verdict is readable line by line — green or
// red, with the output the check printed — and the security note is
// visible text, not a tooltip.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { preflightResultLine, WorkflowPreflightPanel } from "./WorkflowPreflightPanel";
import type { Workflow, WorkflowPreflightResult } from "../../shared/workflow";

const workflow = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: "wf-1",
  name: "Release",
  entryNodeId: "plan",
  nodes: [{ kind: "agent", id: "plan", botId: "bot-a", instructions: "plan", outcomes: ["done"] }],
  edges: [],
  layout: {},
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

const bots = [
  { id: "bot-a", name: "Scout" },
  { id: "bot-b", name: "Rook" },
];

const panel = (doc: Workflow, lastResult: WorkflowPreflightResult | null = null) =>
  renderToStaticMarkup(
    createElement(WorkflowPreflightPanel, {
      workflow: doc,
      bots,
      onChange: vi.fn(),
      onTest: vi.fn(async () => lastResult ?? { at: 0, ok: true, checks: [] }),
      lastResult,
      onClose: vi.fn(),
      anchorRef: { current: null },
    }),
  );

const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("WorkflowPreflightPanel", () => {
  it("says there are no checks, offers every kind, and shows the security note as visible text", () => {
    const markup = panel(workflow());
    const flat = text(markup);
    expect(flat).toContain("No checks yet");
    expect(flat).toContain("Command");
    expect(flat).toContain("Bots ready");
    expect(flat).toContain("Engine health");
    expect(flat).toContain("Only the workflow&#x27;s owner should edit them");
    expect(flat).toContain("A run&#x27;s input is never inserted into a command");
    expect(markup).toContain('value="60"'); // the default timeout, shown
  });

  it("renders each check with its kind and fields filled in from the document", () => {
    const markup = panel(
      workflow({
        preflight: {
          timeoutSeconds: 45,
          checks: [
            { kind: "command", name: "gh auth", command: "gh auth status", cwd: "/repo", expectExitCode: 2, expectStdoutMatch: "^$" },
            { kind: "bots-ready", name: "bots", botIds: ["bot-b"] },
            { kind: "engine-health", name: "engine", botId: "bot-a" },
          ],
        },
      }),
    );
    expect(markup).toContain('value="gh auth status"');
    expect(markup).toContain('value="/repo"');
    expect(markup).toContain('value="2"');
    expect(markup).toContain('value="^$"');
    expect(markup).toContain('value="45"');
    const flat = text(markup);
    expect(flat).toContain("Only the bots ticked below");
    expect(flat).toContain("Costs no tokens");
    // Rook is ticked, Scout is not, on the bots-ready row.
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Rook</);
    expect(markup).toMatch(/aria-pressed="false"[^>]*>Scout</);
    // The engine-health select has Scout chosen.
    expect(markup).toMatch(/<option[^>]*selected[^>]*value="bot-a"|<option[^>]*value="bot-a"[^>]*selected/);
  });

  it("paints the shared validator's bad-preflight messages beside the fields", () => {
    const flat = text(
      panel(workflow({ preflight: { checks: [{ kind: "command", name: "", command: "", expectStdoutMatch: "(" }] } })),
    );
    expect(flat).toContain("Pre-flight check 1 needs a name.");
    expect(flat).toContain("has no command to run.");
    expect(flat).toContain("is not a valid regular expression.");
  });

  it("names a missing engine-health bot rather than silently picking another", () => {
    const flat = text(panel(workflow({ preflight: { checks: [{ kind: "engine-health", name: "e", botId: "gone" }] } })));
    expect(flat).toContain("Missing bot gone");
  });

  it("lists the last verdict green and red with the detail, the duration and the output", () => {
    const result: WorkflowPreflightResult = {
      at: 1,
      ok: false,
      checks: [
        { name: "gh auth", kind: "command", ok: false, durationMs: 412, detail: "exited with code 1 (expected 0)", stderr: "You are not logged in" },
        { name: "clean tree", kind: "command", ok: true, durationMs: 30, detail: "exited with code 0" },
        { name: "bots", kind: "bots-ready", ok: true, durationMs: 0, detail: "1 bot ready" },
      ],
    };
    const markup = panel(workflow({ preflight: { checks: [] } }), result);
    const flat = text(markup);
    expect(flat).toContain("1 failed");
    expect(flat).toContain("Failed · exited with code 1 (expected 0) · 412 ms");
    expect(flat).toContain("You are not logged in");
    expect(flat).toContain("Passed · exited with code 0 · 30 ms");
    expect(flat).toContain("Passed · 1 bot ready · 0 ms");
    expect(markup).toContain("text-danger");
    expect(markup).toContain("text-success");
  });

  it("says all checks passed for a green verdict, and that an empty one passes by definition", () => {
    expect(text(panel(workflow(), { at: 1, ok: true, checks: [] }))).toContain("passes by definition");
    expect(
      text(
        panel(workflow(), {
          at: 1,
          ok: true,
          checks: [{ name: "bots", kind: "bots-ready", ok: true, durationMs: 0, detail: "1 bot ready" }],
        }),
      ),
    ).toContain("All checks passed");
  });

  it("preflightResultLine reads verdict, detail and duration", () => {
    expect(preflightResultLine({ name: "x", kind: "command", ok: true, durationMs: 5, detail: "exited with code 0" })).toBe(
      "Passed · exited with code 0 · 5 ms",
    );
  });
});
