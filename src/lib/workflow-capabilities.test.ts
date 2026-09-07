// The validator says WHETHER a node's bot falls short; these helpers say
// WHICH capability, so the panel can name it and the card can paint the one
// tag that is red. They also own the one editing rule the document has here:
// an empty requirement list is an absent key, never `[]` and never `null`.
import { describe, expect, it } from "vitest";

import {
  alwaysAllowText,
  capabilityLookup,
  grantedCapabilities,
  hasCapability,
  missingCapabilities,
  parseAlwaysAllowLines,
  toggleRequirement,
} from "./workflow-capabilities";

describe("capabilityLookup", () => {
  it("hands the validator the two flags of a roster bot, and null for one the roster lost", () => {
    const lookup = capabilityLookup([
      { id: "bot-a", canMerge: true },
      { id: "bot-b", canDeploy: true },
    ]);

    expect(lookup("bot-a")).toEqual({ canMerge: true, canDeploy: undefined });
    expect(lookup("bot-b")).toEqual({ canMerge: undefined, canDeploy: true });
    expect(lookup("ghost")).toBeNull();
  });
});

describe("hasCapability / grantedCapabilities", () => {
  it("treats absent as not allowed — only an explicit true grants", () => {
    expect(hasCapability({ canMerge: true }, "merge")).toBe(true);
    expect(hasCapability({ canMerge: false }, "merge")).toBe(false);
    expect(hasCapability({}, "merge")).toBe(false);
    expect(hasCapability(null, "deploy")).toBe(false);
    expect(hasCapability(undefined, "deploy")).toBe(false);
  });

  it("lists what a bot holds in the shared order, whatever order the flags came in", () => {
    expect(grantedCapabilities({ canDeploy: true, canMerge: true })).toEqual(["merge", "deploy"]);
    expect(grantedCapabilities({ canDeploy: true })).toEqual(["deploy"]);
    expect(grantedCapabilities({})).toEqual([]);
    expect(grantedCapabilities(null)).toEqual([]);
  });
});

describe("missingCapabilities", () => {
  it("names exactly the requirements the bot lacks", () => {
    expect(missingCapabilities(["merge", "deploy"], { canMerge: true })).toEqual(["deploy"]);
    expect(missingCapabilities(["merge"], { canMerge: true })).toEqual([]);
    expect(missingCapabilities(undefined, {})).toEqual([]);
  });

  it("counts every requirement as missing when the bot no longer resolves", () => {
    expect(missingCapabilities(["merge", "deploy"], null)).toEqual(["merge", "deploy"]);
  });
});

describe("toggleRequirement", () => {
  it("adds and removes one capability, keeping the shared order", () => {
    expect(toggleRequirement(undefined, "deploy", true)).toEqual(["deploy"]);
    expect(toggleRequirement(["deploy"], "merge", true)).toEqual(["merge", "deploy"]);
    expect(toggleRequirement(["merge", "deploy"], "merge", false)).toEqual(["deploy"]);
    // ticking what is already ticked is not a duplicate
    expect(toggleRequirement(["merge"], "merge", true)).toEqual(["merge"]);
  });

  it("returns undefined — the key to omit — rather than an empty list", () => {
    expect(toggleRequirement(["merge"], "merge", false)).toBeUndefined();
    expect(toggleRequirement(undefined, "merge", false)).toBeUndefined();
  });
});

describe("parseAlwaysAllowLines / alwaysAllowText", () => {
  it("reads one key per line, dropping blanks and padding and collapsing repeats, in order", () => {
    expect(parseAlwaysAllowLines("Bash:gh\n\n  session_search \r\nBash:gh\nlist_bots")).toEqual([
      "Bash:gh",
      "session_search",
      "list_bots",
    ]);
  });

  it("yields the key to omit when nothing is left, so the document never carries [] or a blank entry", () => {
    expect(parseAlwaysAllowLines("")).toBeUndefined();
    expect(parseAlwaysAllowLines(" \n\n\t")).toBeUndefined();
  });

  it("round-trips every list the parser can produce", () => {
    const keys = ["Bash:gh", "session_search"];
    expect(parseAlwaysAllowLines(alwaysAllowText(keys))).toEqual(keys);
    expect(alwaysAllowText(undefined)).toBe("");
  });
});
