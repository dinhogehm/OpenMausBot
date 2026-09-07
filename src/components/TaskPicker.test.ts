import { describe, expect, it } from "vitest";

import { t } from "@/lib/i18n";
import {
  TASK_PICKER_DISMISS_MS,
  filterTasks,
  taskPickerPointerIntent,
} from "./TaskPicker";

describe("taskPickerPointerIntent", () => {
  it("treats a single click as switch, not rename", () => {
    expect(taskPickerPointerIntent("click", 1)).toBe("select");
    expect(taskPickerPointerIntent("click")).toBe("select");
  });

  it("does not let the click that accompanies a double-click close the row", () => {
    // HTML fires click (detail=1), click (detail=2), then dblclick. Closing
    // on the first of those unmounts the menu before rename can start.
    expect(taskPickerPointerIntent("click", 2)).toBe("ignore");
    expect(taskPickerPointerIntent("dblclick", 2)).toBe("rename");
  });

  it("starts a rename from right-click", () => {
    expect(taskPickerPointerIntent("contextmenu")).toBe("rename");
  });

  it("ignores unrelated events", () => {
    expect(taskPickerPointerIntent("mousedown")).toBe("ignore");
  });
});

describe("task picker copy", () => {
  it("advertises both gestures the row actually handles", () => {
    // the hint moved into the catalog with the rest of the picker's copy
    expect(t("task.renameHint")).toContain("double-click");
    expect(t("task.renameHint")).toContain("right-click");
    expect(TASK_PICKER_DISMISS_MS).toBeGreaterThanOrEqual(500);
  });
});

describe("filterTasks", () => {
  const tasks = [
    { title: "Clean up" },
    { title: "OpenMausBot Update" },
    { title: "Investment report" },
    { title: "Report drafts" },
  ];

  it("returns the original order when the query is empty", () => {
    expect(filterTasks(tasks, "").map((task) => task.title)).toEqual(tasks.map((task) => task.title));
    expect(filterTasks(tasks, "   ").map((task) => task.title)).toEqual(tasks.map((task) => task.title));
  });

  it("matches titles case-insensitively", () => {
    expect(filterTasks(tasks, "openmaus").map((task) => task.title)).toEqual(["OpenMausBot Update"]);
  });

  it("ranks prefix hits ahead of substring hits, keeping input order in each tier", () => {
    expect(filterTasks(tasks, "report").map((task) => task.title)).toEqual([
      "Report drafts",
      "Investment report",
    ]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterTasks(tasks, "zzzz")).toEqual([]);
  });
});
