import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PROOF_BYTES, buildProofCommand, readProofOutput, validateProofInput } from "../src/linux-proof.ts";

const input = { runId: "run_1", organizationId: "org_1", workspaceId: "workspace_1", generation: 1, message: "Olá, Veltram", delayMs: 0, deadlineAt: Date.now() + 60_000 };

test("proof command keeps shell metacharacters and Unicode entirely in standard input", () => {
  const message = "$(touch /tmp/injected); `id` ' \" \\ \n🚀\u0000";
  const command = buildProofCommand({ ...input, message, delayMs: 30_000 });
  assert.equal(command.argv[0], "node");
  assert.equal(command.argv.at(-1), "30000");
  assert.ok(command.argv.every((arg) => !arg.includes(message)));
  assert.equal(new TextDecoder().decode(command.stdin), message);
});

test("proof input is limited in UTF-8 bytes, including multi-byte characters", () => {
  assert.doesNotThrow(() => validateProofInput({ ...input, message: "a".repeat(MAX_PROOF_BYTES) }));
  assert.throws(() => validateProofInput({ ...input, message: "a".repeat(MAX_PROOF_BYTES + 1) }), /invalid_proof_input/);
  assert.throws(() => validateProofInput({ ...input, message: "🚀".repeat(MAX_PROOF_BYTES / 4 + 1) }), /invalid_proof_input/);
  assert.throws(() => validateProofInput({ ...input, message: "\ud800" }), /invalid_proof_input/);
});

test("proof input rejects invalid scope, generation and out-of-range delays", () => {
  for (const patch of [
    { runId: "../another" }, { organizationId: "" }, { workspaceId: "a".repeat(81) },
    { generation: 0 }, { generation: 1.5 }, { generation: Number.MAX_SAFE_INTEGER + 1 },
    { delayMs: -1 }, { delayMs: 30_001 }, { delayMs: 0.5 }, { delayMs: NaN },
    { deadlineAt: 0 }, { deadlineAt: Infinity }, { deadlineAt: 1.5 },
    { message: 123 },
  ]) assert.throws(() => validateProofInput({ ...input, ...patch }), /invalid_proof_input/);
});

test("bounded output joins split UTF-8 sequences without corrupting the artifact", async () => {
  const bytes = new TextEncoder().encode("Olá 🚀");
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes.slice(0, bytes.length - 2));
    controller.enqueue(bytes.slice(bytes.length - 2));
    controller.close();
  } });
  assert.equal(await readProofOutput(stream), "Olá 🚀");
});

test("bounded output cancels a stream that exceeds the byte limit", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(MAX_PROOF_BYTES + 1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readProofOutput(stream), /proof_output_limit/);
  assert.equal(cancelled, true);
});
