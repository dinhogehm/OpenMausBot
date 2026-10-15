import { CLAUDE_CLI_VERSION, CLAUDE_LIMITS, type ClaudeInferenceInput } from "./claude-types";
import { CLAUDE_ENV, CLAUDE_PREFIX, claudeInferenceCommand, claudeLoginCode, claudeLoginPrompt, parseClaudeAuth, parseClaudeResult } from "./claude-program";

const encoder = new TextEncoder();
function active(signal: AbortSignal) { if (signal.aborted) throw new Error("claude_operation_canceled"); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); void promise.catch(() => {}); return { promise, resolve, reject }; }
async function read(stream: ReadableStream<Uint8Array> | null, limit: number, receive?: (output: string) => void): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true }); let output = ""; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > limit) throw new Error("claude_output_limit"); output += decoder.decode(part.value, { stream: true }); receive?.(output); } output += decoder.decode(); return output; }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
async function processResult(process: ExecProcess, signal: AbortSignal, limit: number, receive?: (output: string) => void) {
  const canceled = deferred<never>();
  const onAbort = () => { try { process.kill(9); } catch { /* Room teardown is the final stop boundary. */ } canceled.reject(new Error("claude_operation_canceled")); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    const work = Promise.all([read(process.stdout, limit, receive), read(process.stderr, CLAUDE_LIMITS.authOutputBytes), process.exitCode]);
    const [output, , exitCode] = await Promise.race([work, canceled.promise]); active(signal); return { output, exitCode };
  } finally { signal.removeEventListener("abort", onAbort); }
}
export interface ClaudeNativeLogin {
  url: Promise<string>; done: Promise<number>; submit(code: string): Promise<void>;
}

/** Only the original CLI runs here. No checkout, shell, credential parsing or HTTP token broker. */
export class ClaudeNativeRuntime {
  constructor(private readonly container: Container) {}
  async start(snapshot: ContainerSnapshot | undefined, signal: AbortSignal): Promise<void> {
    active(signal);
    if (!this.container.running) this.container.start({ ...(snapshot ? { containerSnapshot: snapshot } : { image: this.container.images.claude }), enableInternet: true, instance: "lite" });
    await this.container.setInactivityTimeout(CLAUDE_LIMITS.loginMs + 60_000); active(signal);
    const version = await this.execute([...CLAUDE_PREFIX, "--version"], undefined, signal, 1024);
    if (version.exitCode !== 0 || !version.output.startsWith(`${CLAUDE_CLI_VERSION} `)) throw new Error("claude_version_mismatch");
  }
  private async execute(argv: string[], stdin: ReadableStream<Uint8Array> | undefined, signal: AbortSignal, limit: number) {
    active(signal);
    const process = await this.container.exec(argv, { cwd: "/opt/veltram/request", env: { ...CLAUDE_ENV }, stdin, stdout: "pipe", stderr: "pipe", signal });
    return processResult(process, signal, limit);
  }
  async authStatus(signal: AbortSignal) {
    const result = await this.execute([...CLAUDE_PREFIX, "auth", "status"], undefined, signal, CLAUDE_LIMITS.authOutputBytes);
    return parseClaudeAuth(result.output, result.exitCode);
  }
  async login(signal: AbortSignal): Promise<ClaudeNativeLogin> {
    active(signal);
    const process = await this.container.exec([...CLAUDE_PREFIX, "auth", "login"], { cwd: "/opt/veltram/request", env: { ...CLAUDE_ENV }, stdin: "pipe", stdout: "pipe", stderr: "combined", signal });
    const link = deferred<string>(); let submitted = false;
    const done = processResult(process, signal, CLAUDE_LIMITS.authOutputBytes, output => { const url = claudeLoginPrompt(output); if (url) link.resolve(url); })
      .then(result => { link.reject(new Error("claude_login_link_unavailable")); return result.exitCode; }, () => { link.reject(new Error("claude_login_failed")); throw new Error("claude_login_failed"); });
    void done.catch(() => {});
    return { url: link.promise, done, async submit(value) {
      active(signal); if (submitted) throw new Error("claude_code_already_sent");
      const code = claudeLoginCode(value); submitted = true;
      if (!process.stdin) throw new Error("claude_login_failed");
      const writer = process.stdin.getWriter();
      try { await writer.write(encoder.encode(`${code}\n`)); await writer.close(); } finally { writer.releaseLock(); }
    } };
  }
  async infer(input: ClaudeInferenceInput, signal: AbortSignal) {
    const stdin = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(input.prompt)); c.close(); } });
    const result = await this.execute(claudeInferenceCommand(input), stdin, signal, CLAUDE_LIMITS.outputBytes);
    return parseClaudeResult(result.output, result.exitCode);
  }
  async logout(signal: AbortSignal): Promise<void> {
    const result = await this.execute([...CLAUDE_PREFIX, "auth", "logout"], undefined, signal, CLAUDE_LIMITS.authOutputBytes);
    if (result.exitCode !== 0) throw new Error("claude_logout_failed");
  }
  async snapshot(signal: AbortSignal): Promise<ContainerSnapshot> {
    active(signal); const snapshot = await this.container.snapshotContainer({ name: "claude-private-checkpoint" }); active(signal);
    if (!snapshot.id || !Number.isSafeInteger(snapshot.size) || snapshot.size < 0) throw new Error("claude_snapshot_failed");
    return snapshot;
  }
}
