import { describe, expect, it } from "vitest";

import { standingPermissionsPrompt } from "./standing-permissions.ts";

describe("standingPermissionsPrompt", () => {
  it("states both permissions on one line, flipping the wording per flag", () => {
    const none = standingPermissionsPrompt({});
    expect(none).toContain(
      "Standing permissions: merging pull requests: not allowed. Deploying to production: not allowed.",
    );
    expect(none.trim().split("\n")).toHaveLength(1);
    // Concatenated straight onto the persona like the other policy lines.
    expect(none.startsWith(" ")).toBe(true);
    expect(standingPermissionsPrompt({ canMerge: true })).toContain(
      "merging pull requests: allowed. Deploying to production: not allowed.",
    );
    expect(standingPermissionsPrompt({ canDeploy: true })).toContain(
      "merging pull requests: not allowed. Deploying to production: allowed.",
    );
    expect(standingPermissionsPrompt({ canMerge: true, canDeploy: true })).toContain(
      "merging pull requests: allowed. Deploying to production: allowed.",
    );
  });

  it("treats anything but true as not allowed, and tells the bot not to try while something is", () => {
    const prompt = standingPermissionsPrompt({ canMerge: false, canDeploy: undefined });
    expect(prompt).toContain("merging pull requests: not allowed. Deploying to production: not allowed.");
    expect(prompt).toMatch(/never attempt/i);
    expect(standingPermissionsPrompt({ canMerge: true, canDeploy: true })).not.toMatch(/never attempt/i);
  });
});
