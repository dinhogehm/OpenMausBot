import { describe, expect, it } from "vitest";
import { shouldMountLocalComputer } from "./local-routing.ts";

describe("local computer routing", () => {
  it("never lets Linux Auto fall back to the user's desktop", () => {
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "linux",
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });

  it("requires an explicit local selection and an approval-capable provider on Linux", () => {
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "linux",
        providerSupportsLocal: true,
      }),
    ).toBe(true);
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "linux",
        providerSupportsLocal: false,
      }),
    ).toBe(false);
  });

  it("preserves the established macOS Auto fallback", () => {
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "darwin",
        providerSupportsLocal: true,
      }),
    ).toBe(true);
  });

  it("does not hand the desktop to a turn nobody started", () => {
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "darwin",
        providerSupportsLocal: true,
        unattended: true,
      }),
    ).toBe(false);
    // the same bot, the same Mac, a person at the keyboard: Auto still mounts
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "darwin",
        providerSupportsLocal: true,
        unattended: false,
      }),
    ).toBe(true);
  });

  it("keeps an explicit local choice: unattended narrows the fallback, not the decision", () => {
    // the person mounted this bot on their Mac on purpose; the approval rules
    // still card every host request, so the mount grants nothing on its own
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "darwin",
        providerSupportsLocal: true,
        unattended: true,
      }),
    ).toBe(true);
  });

  it("never mounts the local desktop for explicit cloud/off or on an unsupported host", () => {
    for (const requested of ["cloud", "off"] as const) {
      expect(
        shouldMountLocalComputer({
          requested,
          hostPlatform: "darwin",
          providerSupportsLocal: true,
        }),
      ).toBe(false);
    }
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "win32",
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });
});
