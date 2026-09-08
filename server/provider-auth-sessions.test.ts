import { describe, expect, it, vi } from "vitest";
import { ProviderAuthSessions } from "./provider-auth-sessions.ts";
import type { ProviderAuthenticationStart } from "./contracts.ts";

function fixture() {
  const auth: ProviderAuthenticationStart = {
    phase: "waiting", flowId: "random-flow", authorizationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-12345", expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const instance = {
    instanceId: "codex", startAuthentication: vi.fn(async () => auth),
    getAuthentication: vi.fn(async () => auth),
    cancelAuthentication: vi.fn(async () => {}),
    completeAuthentication: vi.fn(async () => {}),
  };
  return { sessions: new ProviderAuthSessions(), instance, auth };
}

describe("provider login ownership", () => {
  it("forgets only the replaced provider's login reservation", async () => {
    const { sessions, instance } = fixture();
    const sibling = { ...instance, instanceId: "other" };
    await sessions.start(instance, "owner");
    await sessions.start(sibling, "owner");
    sessions.clearInstance("codex");
    await expect(sessions.status("codex", "owner", "random-flow")).rejects.toMatchObject({ status: 404 });
    await expect(sessions.status("other", "owner", "random-flow")).resolves.toMatchObject({ phase: "waiting" });
    await expect(sessions.start(instance, "another owner")).resolves.toMatchObject({ phase: "waiting" });
  });
  it("does not disclose, complete, or cancel another admin's device flow", async () => {
    const { sessions, instance } = fixture();
    await sessions.start(instance, "owner");
    await expect(sessions.start(instance, "other")).rejects.toMatchObject({ status: 409 });
    await expect(sessions.status("codex", "other", "random-flow")).rejects.toMatchObject({ status: 404 });
    await expect(sessions.complete("codex", "other", "random-flow", "callback")).rejects.toMatchObject({ status: 404 });
    await expect(sessions.cancel("codex", "other", "random-flow")).rejects.toMatchObject({ status: 404 });
    expect(instance.getAuthentication).not.toHaveBeenCalled();
    expect(instance.cancelAuthentication).not.toHaveBeenCalled();
    expect(instance.completeAuthentication).not.toHaveBeenCalled();
  });

  it("requires an exact flow id even for the initiating admin", async () => {
    const { sessions, instance, auth } = fixture();
    await sessions.start(instance, "owner");
    await expect(sessions.status("codex", "owner", "stale")).rejects.toMatchObject({ status: 404 });
    await expect(sessions.cancel("codex", "owner", "")).rejects.toMatchObject({ status: 404 });
    expect(await sessions.status("codex", "owner", "random-flow")).toEqual(auth);
    await sessions.cancel("codex", "owner", "random-flow");
    expect(instance.cancelAuthentication).toHaveBeenCalledOnce();
  });

  it("reserves ownership before the asynchronous CLI start", async () => {
    const { sessions, instance, auth } = fixture();
    let ready!: (value: ProviderAuthenticationStart) => void;
    instance.startAuthentication.mockImplementation(() => new Promise((resolve) => { ready = resolve; }));
    const first = sessions.start(instance, "owner");
    await expect(sessions.start(instance, "owner")).rejects.toMatchObject({ status: 409 });
    await expect(sessions.start(instance, "other")).rejects.toMatchObject({ status: 409 });
    ready(auth);
    await first;
    expect(instance.startAuthentication).toHaveBeenCalledOnce();
  });

  it("cancels pending startup when its admin is revoked", async () => {
    const { sessions, instance, auth } = fixture();
    let ready!: (value: ProviderAuthenticationStart) => void;
    instance.startAuthentication.mockImplementation(() => new Promise((resolve) => { ready = resolve; }));
    const starting = sessions.start(instance, "owner");
    sessions.revokeOwner("owner");
    ready(auth);
    await expect(starting).rejects.toMatchObject({ status: 409 });
    expect(instance.cancelAuthentication).toHaveBeenCalledOnce();
  });

  it("revokes only the target owner's flow", async () => {
    const { sessions, instance } = fixture();
    await sessions.start(instance, "owner");
    sessions.revokeOwner("other");
    expect(instance.cancelAuthentication).not.toHaveBeenCalled();
    sessions.revokeOwner("owner");
    await expect(sessions.status("codex", "owner", "random-flow")).rejects.toMatchObject({ status: 404 });
    await vi.waitFor(() => expect(instance.cancelAuthentication).toHaveBeenCalledOnce());
  });

  it("preserves the browser-callback provider flow for its owner", async () => {
    const { sessions, instance } = fixture();
    await sessions.start(instance, "owner");
    await sessions.complete("codex", "owner", "random-flow", "callback");
    expect(instance.completeAuthentication).toHaveBeenCalledWith("random-flow", "callback");
    await expect(sessions.status("codex", "owner", "random-flow")).rejects.toMatchObject({ status: 404 });
  });

  it("keeps the original flow recoverable when same-owner resume fails", async () => {
    const { sessions, instance, auth } = fixture();
    await sessions.start(instance, "owner");
    instance.startAuthentication.mockRejectedValueOnce(new Error("temporary failure"));
    await expect(sessions.start(instance, "owner")).rejects.toThrow("temporary failure");
    expect(await sessions.status("codex", "owner", "random-flow")).toEqual(auth);
    await sessions.cancel("codex", "owner", "random-flow");
    expect(instance.cancelAuthentication).toHaveBeenCalledOnce();
  });

  it("releases another admin immediately after confirmed cancellation", async () => {
    const { sessions, instance } = fixture();
    await sessions.start(instance, "owner");
    await sessions.cancel("codex", "owner", "random-flow");
    await expect(sessions.start(instance, "other")).resolves.toMatchObject({ phase: "waiting" });
  });

  it("releases another admin after a terminal status is observed", async () => {
    const { sessions, instance } = fixture();
    await sessions.start(instance, "owner");
    instance.getAuthentication.mockResolvedValue({ phase: "succeeded", flowId: "random-flow", authorizationUrl: null, expiresAt: null });
    await sessions.status("codex", "owner", "random-flow");
    await expect(sessions.start(instance, "other")).resolves.toMatchObject({ phase: "waiting" });
  });

  it("releases failed startup and does not retain already-signed-in flows", async () => {
    const { sessions, instance } = fixture();
    instance.startAuthentication.mockRejectedValueOnce(new Error("missing CLI"));
    await expect(sessions.start(instance, "owner")).rejects.toThrow("missing CLI");
    instance.startAuthentication.mockResolvedValue({ phase: "succeeded", flowId: null, authorizationUrl: null, expiresAt: null });
    await sessions.start(instance, "other");
    await sessions.start(instance, "owner");
  });

  it("rejects stale polling after fleet disposal", async () => {
    const { sessions, instance } = fixture();
    await sessions.start(instance, "owner");
    sessions.clear();
    await expect(sessions.status("codex", "owner", "random-flow")).rejects.toMatchObject({ status: 404 });
  });
});
