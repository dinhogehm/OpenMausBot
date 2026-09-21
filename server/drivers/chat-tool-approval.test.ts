import { afterEach, describe, expect, it, vi } from "vitest";

import { createChatToolApproval } from "./chat-tool-approval.ts";

afterEach(() => vi.useRealTimers());

describe("chat tool approval lifecycle", () => {
  it("denies an unanswered request when its deadline expires and rejects late approval", async () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const resolved = vi.fn();
    const gate = createChatToolApproval({ signal: new AbortController().signal, open, resolved, timeoutMs: 100 });
    const answer = gate.ask("audit_write", "Write the fixture receipt");
    const request = open.mock.calls[0][0];

    await vi.advanceTimersByTimeAsync(100);

    await expect(answer).resolves.toBe(false);
    expect(resolved).toHaveBeenCalledExactlyOnceWith(request, false, "timeout");
    expect(gate.answer(request.id, "allow")).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says WHO settled each ask, so an unanswered card is never reported as a refusal", async () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const gate = createChatToolApproval({ signal: new AbortController().signal, open, resolved: vi.fn(), timeoutMs: 100 });

    const unanswered = gate.decide("composio_composio_remote_workbench", "Query the deploys");
    await vi.advanceTimersByTimeAsync(100);
    await expect(unanswered).resolves.toEqual({ allowed: false, source: "timeout" });

    const refused = gate.decide("composio_composio_multi_execute_tool", "Post a comment");
    gate.answer(open.mock.calls[1][0].id, "deny");
    await expect(refused).resolves.toEqual({ allowed: false, source: "user" });

    const approved = gate.decide("composio_composio_search_tools", "Find a tool");
    gate.answer(open.mock.calls[2][0].id, "allow");
    await expect(approved).resolves.toEqual({ allowed: true, source: "user" });
  });

  it("denies a cancelled ask and never opens another one for the cancelled turn", async () => {
    const abort = new AbortController();
    const open = vi.fn();
    const resolved = vi.fn();
    const gate = createChatToolApproval({ signal: abort.signal, open, resolved });
    const answer = gate.ask("audit_write", "Write the fixture receipt");
    const request = open.mock.calls[0][0];

    abort.abort();

    await expect(answer).resolves.toBe(false);
    expect(resolved).toHaveBeenCalledExactlyOnceWith(request, false, "system");
    expect(gate.answer(request.id, "allow")).toBe("unavailable");
    await expect(gate.ask("audit_write", "A later request")).resolves.toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("closes every outstanding ask and permanently refuses future requests", async () => {
    const open = vi.fn();
    const resolved = vi.fn();
    const gate = createChatToolApproval({ signal: new AbortController().signal, open, resolved });
    const first = gate.ask("audit_write", "First fixture receipt");
    const second = gate.ask("audit_write", "Second fixture receipt");
    const requests = open.mock.calls.map(([request]) => request);

    gate.close();
    gate.close();

    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(resolved).toHaveBeenCalledTimes(2);
    for (const request of requests) {
      expect(resolved).toHaveBeenCalledWith(request, false, "system");
      expect(gate.answer(request.id, "allow")).toBe("unavailable");
    }
    await expect(gate.ask("audit_write", "Request after close")).resolves.toBe(false);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("registers the request before publishing it so a synchronous harness approval works", async () => {
    const resolved = vi.fn();
    const answered = vi.fn();
    const gate = createChatToolApproval({
      signal: new AbortController().signal,
      open: (request) => answered(gate.answer(request.id, "allow")),
      resolved,
    });

    await expect(gate.ask("audit_write", "Write the fixture receipt")).resolves.toBe(true);

    expect(answered).toHaveBeenCalledExactlyOnceWith("allowed-once");
    expect(resolved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tool: "audit_write" }), true, "user");
    const request = resolved.mock.calls[0][0];
    expect(gate.answer(request.id, "allow")).toBe("unavailable");
  });
});
