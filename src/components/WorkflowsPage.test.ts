// Presentational pieces of the workflows list, rendered as static markup the
// way the rest of the component suite does. These pin the accessibility
// contract: every diagnostic the page shows must reach a keyboard or screen
// reader, never a mouse-only `title`.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RunPill, ValidationBadge, WorkflowRow, scheduleLabel } from "./WorkflowsPage";
import type { WorkflowListItem } from "@/lib/workflow-state";
import type { WorkflowRun } from "../../shared/workflow";

const workflow = (overrides: Partial<WorkflowListItem> = {}): WorkflowListItem => ({
  id: "wf1",
  name: "Triage pipeline",
  entryNodeId: "triage",
  nodes: [],
  edges: [],
  layout: {},
  createdAt: 0,
  updatedAt: 0,
  issues: [],
  ...overrides,
});

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "run1",
  workflowId: "wf1",
  status: "completed",
  attempt: 0,
  input: "",
  nodeResults: [],
  startedAt: 1_700_000_000_000,
  ...overrides,
});

const row = (overrides: Partial<Parameters<typeof WorkflowRow>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(WorkflowRow, {
      workflow: workflow(),
      latestRun: null,
      selected: false,
      busy: null,
      error: null,
      onSelect: vi.fn(),
      onRename: vi.fn(),
      onRun: vi.fn(),
      onDelete: vi.fn(),
      onDismissError: vi.fn(),
      ...overrides,
    }),
  );

describe("ValidationBadge", () => {
  it("puts every issue message in the DOM, not only in a tooltip", () => {
    const markup = renderToStaticMarkup(
      createElement(ValidationBadge, {
        issues: [
          { severity: "error", code: "bad-entry", message: 'Entry node "" does not exist.' },
          { severity: "warning", code: "unwired-failure", nodeId: "triage", message: 'Node "triage" has no failure edge' },
        ],
      }),
    );

    expect(markup).toContain("1 error");
    expect(markup).toContain("does not exist.");
    expect(markup).toContain("has no failure edge");
  });

  it("reports a clean graph as valid", () => {
    expect(renderToStaticMarkup(createElement(ValidationBadge, { issues: [] }))).toContain("Valid");
  });
});

describe("RunPill", () => {
  it("keeps status, time and failure reason as readable text", () => {
    const markup = renderToStaticMarkup(
      createElement(RunPill, { run: run({ status: "failed", error: "the bot for node \"triage\" no longer exists" }) }),
    );

    // aria-label on a role-less span is dropped by browsers, so the words
    // themselves have to be in the markup, not hidden behind an attribute.
    const text = markup.replace(/<[^>]*>/g, "");
    expect(text).toContain("Failed");
    expect(text).toContain("no longer exists");
    expect(markup).not.toContain("aria-label=");
  });

  it("names a missed scheduled slot as missed rather than failed", () => {
    const markup = renderToStaticMarkup(
      createElement(RunPill, {
        run: run({ status: "failed", trigger: "schedule", error: "missed: this computer was offline" }),
      }),
    );

    expect(markup).toContain("Missed");
  });
});

describe("scheduleLabel", () => {
  it("says a workflow without a schedule is not scheduled", () => {
    expect(scheduleLabel(workflow())).toBe("Not scheduled");
  });

  it("distinguishes an armed slot from one the engine has not computed yet", () => {
    const scheduled = workflow({ triggers: { schedule: { type: "daily", time: "09:00", weekdays: [1] } } });
    expect(scheduleLabel(scheduled)).toBe("Scheduled · next run pending");
    expect(scheduleLabel({ ...scheduled, nextRunAt: 1_700_000_000_000 })).toContain("Next run:");
  });
});

describe("WorkflowRow", () => {
  it("blocks Run on an error and says why in visible text", () => {
    const markup = row({
      workflow: workflow({ issues: [{ severity: "error", code: "bad-entry", message: "Entry node missing" }] }),
    });

    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toMatch(/Fix 1 error/);
  });

  it("blocks Run with a visible reason while a run of this workflow is still active", () => {
    const markup = row({ latestRun: run({ status: "running" }) });

    expect(markup).toContain('aria-disabled="true"');
    expect(markup.replace(/<[^>]*>/g, "")).toContain("A run is already active");
  });

  it("lets Run through again once the latest run is over", () => {
    const markup = row({ latestRun: run({ status: "completed" }) });

    expect(markup).not.toContain('aria-disabled="true"');
  });

  it("leaves Run available when the graph only carries warnings", () => {
    const markup = row({
      workflow: workflow({
        issues: [{ severity: "warning", code: "unwired-failure", nodeId: "a", message: "no failure edge" }],
      }),
    });

    expect(markup).not.toContain('aria-disabled="true"');
  });

  it("explains a busy row in visible text, not only in a tooltip", () => {
    const markup = row({ busy: "delete" });

    expect(markup.replace(/<[^>]*>/g, "")).toContain("Another action is still running");
    expect(markup).toContain("aria-describedby=");
  });

  it("offers a dismissable alert for a row error", () => {
    const markup = row({ error: "workflow still has 1 live run — retry" });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("still has 1 live run");
    expect(markup).toContain('aria-label="Dismiss error"');
  });
});
