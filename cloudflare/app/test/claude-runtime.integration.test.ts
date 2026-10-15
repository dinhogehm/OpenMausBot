import { describe, expect, it } from "vitest";
import { ClaudeNativeRuntime } from "../src/claude-runtime";
import { CLAUDE_ENV } from "../src/claude-program";

const bytes = (value: string) => new TextEncoder().encode(value);
const stream = (value: string) => new ReadableStream({ start(c) { c.enqueue(bytes(value)); c.close(); } });
describe("trusted native Claude process boundary", () => {
  it("streams only official login links and sends code to the original process once", async () => {
    let sent = ""; let closed!: () => void;
    const container = { running: true, async exec(argv: string[], options: ContainerExecOptions) {
      expect(argv.slice(-2)).toEqual(["auth", "login"]); expect(options.env).toEqual(CLAUDE_ENV);
      const output = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes("https://claude.ai/oauth/authorize?state=fixture\n")); closed = () => c.close(); } });
      return { stdout: output, stdin: new WritableStream({ write(chunk) { sent += new TextDecoder().decode(chunk); }, close() { closed(); } }), exitCode: Promise.resolve(0), kill() {} };
    } } as unknown as Container;
    const login = await new ClaudeNativeRuntime(container).login(new AbortController().signal);
    expect(await login.url).toBe("https://claude.ai/oauth/authorize?state=fixture");
    await login.submit("fixture-code"); expect(await login.done).toBe(0); expect(sent).toBe("fixture-code\n");
    await expect(login.submit("fixture-code")).rejects.toThrow("claude_code_already_sent");
  });
  it("aborts a hanging native process and never returns its raw stderr", async () => {
    let kills = 0;
    const container = { running: true, async exec() { return { stdout: new ReadableStream(), stderr: stream("Bearer never-print"), exitCode: new Promise(() => {}), kill() { kills++; } }; } } as unknown as Container;
    const abort = new AbortController();
    const pending = new ClaudeNativeRuntime(container).authStatus(abort.signal);
    const assertion = expect(pending).rejects.toThrow("claude_operation_canceled");
    await Promise.resolve(); abort.abort(); await assertion; expect(kills).toBeGreaterThan(0);
  });
  it("restores only an opaque native snapshot and never reads credential files", async () => {
    const starts: ContainerStartupOptions[] = [];
    let running = false;
    const container = { get running() { return running; }, images: { claude: "pinned" }, start(options: ContainerStartupOptions) { starts.push(options); running = true; }, async setInactivityTimeout() {}, async exec(argv: string[]) { expect(argv.at(-1)).toBe("--version"); return { stdout: stream("2.1.300 (Claude Code)"), stderr: stream(""), exitCode: Promise.resolve(0), kill() {} }; } } as unknown as Container;
    await new ClaudeNativeRuntime(container).start({ id: "opaque-id", size: 1 }, new AbortController().signal);
    expect(starts).toEqual([{ containerSnapshot: { id: "opaque-id", size: 1 }, enableInternet: true, instance: "lite" }]);
  });
});
