export const MAX_PROOF_BYTES = 16 * 1024;
export const PROOF_TIMEOUT_MS = 45_000;

export interface LinuxProofInput {
  runId: string;
  organizationId: string;
  workspaceId: string;
  generation: number;
  message: string;
  delayMs: number;
  deadlineAt: number;
}

export interface LinuxProofResult {
  stdout: string;
  artifact: string;
  exitCode: number;
}

export function validateProofInput(value: unknown): asserts value is LinuxProofInput {
  const input = value as LinuxProofInput | null | undefined;
  const validId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
  if (!input || !validId(input.runId) || !validId(input.organizationId) || !validId(input.workspaceId)
    || !Number.isSafeInteger(input.generation) || input.generation < 1
    || !Number.isSafeInteger(input.delayMs) || input.delayMs < 0 || input.delayMs > 30_000
    || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= 0
    || typeof input.message !== "string" || !input.message.isWellFormed()
    || new TextEncoder().encode(input.message).byteLength > MAX_PROOF_BYTES) {
    throw new Error("invalid_proof_input");
  }
}

// Only this fixed program runs. The message is raw stdin; the bounded numeric
// delay is an argv value. Neither becomes JavaScript source or shell syntax.
const PROOF_PROGRAM = `
const fs = require("node:fs");
const chunks = [];
let size = 0;
process.stdin.on("data", (chunk) => {
  size += chunk.length;
  if (size > 16384) process.exit(2);
  chunks.push(chunk);
});
process.stdin.on("end", () => {
  fs.mkdirSync("/workspace", { recursive: true });
  fs.writeFileSync("/workspace/result.txt", Buffer.concat(chunks), { mode: 0o600 });
  setTimeout(() => process.stdout.write(fs.readFileSync("/workspace/result.txt")), Number(process.argv[1]));
});
`;

export function buildProofCommand(input: LinuxProofInput): { argv: string[]; stdin: Uint8Array } {
  validateProofInput(input);
  return {
    argv: ["node", "--input-type=commonjs", "-e", PROOF_PROGRAM, String(input.delayMs)],
    stdin: new TextEncoder().encode(input.message),
  };
}

export async function readProofOutput(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) throw new Error("proof_output_missing");
  const reader = stream.getReader();
  const bytes = new Uint8Array(MAX_PROOF_BYTES);
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PROOF_BYTES) {
        await reader.cancel();
        throw new Error("proof_output_limit");
      }
      bytes.set(next.value, size - next.value.byteLength);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } finally {
    reader.releaseLock();
  }
}
