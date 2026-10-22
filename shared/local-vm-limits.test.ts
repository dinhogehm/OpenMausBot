import { describe, expect, it } from "vitest";

import { LOCAL_VM_MAX_INSTANCE_CHOICES, MAX_LOCAL_VM_MAX_INSTANCES, MIN_LOCAL_VM_MAX_INSTANCES } from "./local-vm-limits.ts";

describe("Local VM instance limits", () => {
  it("allows a dedicated desktop for more than eight bots", () => {
    expect(MIN_LOCAL_VM_MAX_INSTANCES).toBe(1);
    expect(MAX_LOCAL_VM_MAX_INSTANCES).toBe(16);
  });

  it("offers every count from the minimum through the maximum, in order", () => {
    expect(LOCAL_VM_MAX_INSTANCE_CHOICES).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
    expect(LOCAL_VM_MAX_INSTANCE_CHOICES).toContain(11);
  });
});
