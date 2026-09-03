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

  it("lets the step go to a teammate who holds the permission, and refuses the laundering shapes", () => {
    // A team keeps one merger and one deployer on purpose. A coordinator told
    // never to delegate reads its own missing flag as a wall and stops the
    // pipeline, which is what happened on a real run.
    const prompt = standingPermissionsPrompt({});
    expect(prompt).toMatch(/hand that step to a teammate who carries the permission/i);
    expect(prompt).toMatch(/never to one who lacks it/i);
    expect(prompt).toMatch(/never by asking anyone to bypass/i);
    // and when nobody can, the answer is still an honest stop
    expect(prompt).toMatch(/if nobody carries it, stop there and say which permission is missing/i);
    // the bot that holds both is told none of this
    expect(standingPermissionsPrompt({ canMerge: true, canDeploy: true })).not.toMatch(/teammate/i);
  });
});
