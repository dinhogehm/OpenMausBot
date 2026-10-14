import assert from "node:assert/strict";
import test from "node:test";
import { decryptCredential, encryptCredential } from "../src/credentials.ts";
import type { CredentialEnvelope, CredentialProvider, CredentialScope } from "../src/credentials.ts";

const masterKey = Buffer.alloc(32, 17).toString("base64");
const plaintext = "sk-fixture-not-a-real-key";
const scope: CredentialScope = {
  organizationId: "org_A",
  provider: "openai",
  credentialId: "credential_1",
  keyVersion: 1,
};
const encryptionError = { name: "Error", message: "Credential encryption failed" };
const decryptionError = { name: "Error", message: "Credential decryption failed" };

function changeByte(value: string): string {
  const bytes = Buffer.from(value, "base64");
  bytes[0] = bytes[0]! ^ 1;
  return bytes.toString("base64");
}

test("credentials round trip for each supported provider", async () => {
  for (const provider of ["openai", "anthropic", "openrouter"] as const) {
    const providerScope = { ...scope, provider };
    const envelope = await encryptCredential(masterKey, providerScope, plaintext);
    assert.equal(await decryptCredential(masterKey, providerScope, envelope), plaintext);
  }
});

test("the envelope contains only version, a 12-byte IV and authenticated ciphertext", async () => {
  const envelope = await encryptCredential(masterKey, scope, plaintext);
  assert.deepEqual(Object.keys(envelope).sort(), ["ciphertext", "iv", "v"]);
  assert.equal(envelope.v, 1);
  assert.equal(Buffer.from(envelope.iv, "base64").length, 12);
  assert.equal(Buffer.from(envelope.ciphertext, "base64").length, Buffer.byteLength(plaintext) + 16);
  assert.equal(JSON.stringify(envelope).includes(plaintext), false);
  assert.equal(JSON.stringify(envelope).includes(masterKey), false);
});

test("encryption uses a fresh nonce for repeated plaintext and scope", async () => {
  const first = await encryptCredential(masterKey, scope, plaintext);
  const second = await encryptCredential(masterKey, scope, plaintext);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("decryption is bound to organization, provider, credential and key version", async () => {
  const envelope = await encryptCredential(masterKey, scope, plaintext);
  for (const changed of [
    { ...scope, organizationId: "org_B" },
    { ...scope, provider: "anthropic" as CredentialProvider },
    { ...scope, credentialId: "credential_2" },
    { ...scope, keyVersion: 2 },
  ]) {
    await assert.rejects(decryptCredential(masterKey, changed, envelope), decryptionError);
  }
});

test("native WebCrypto confirms the full AAD format including schema version", async () => {
  const envelope = await encryptCredential(masterKey, scope, plaintext);
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(Buffer.from(masterKey, "base64")),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const aad = {
    organizationId: scope.organizationId,
    provider: scope.provider,
    credentialId: scope.credentialId,
    keyVersion: scope.keyVersion,
    schemaVersion: 1,
  };
  const algorithm = {
    name: "AES-GCM",
    iv: new Uint8Array(Buffer.from(envelope.iv, "base64")),
    additionalData: new TextEncoder().encode(JSON.stringify(aad)),
    tagLength: 128,
  };
  const ciphertext = new Uint8Array(Buffer.from(envelope.ciphertext, "base64"));
  const cleartext = await crypto.subtle.decrypt(algorithm, key, ciphertext);
  assert.equal(new TextDecoder().decode(cleartext), plaintext);
  await assert.rejects(crypto.subtle.decrypt({
    ...algorithm,
    additionalData: new TextEncoder().encode(JSON.stringify({ ...aad, schemaVersion: 2 })),
  }, key, ciphertext));
});

test("a different valid master key cannot decrypt the credential", async () => {
  const envelope = await encryptCredential(masterKey, scope, plaintext);
  const otherMaster = Buffer.alloc(32, 18).toString("base64");
  await assert.rejects(decryptCredential(otherMaster, scope, envelope), decryptionError);
});

test("tampering with ciphertext or nonce fails closed", async () => {
  const envelope = await encryptCredential(masterKey, scope, plaintext);
  await assert.rejects(
    decryptCredential(masterKey, scope, { ...envelope, ciphertext: changeByte(envelope.ciphertext) }),
    decryptionError,
  );
  await assert.rejects(
    decryptCredential(masterKey, scope, { ...envelope, iv: changeByte(envelope.iv) }),
    decryptionError,
  );
});

test("unsupported schema versions and malformed envelopes are rejected generically", async () => {
  const envelope = await encryptCredential(masterKey, scope, plaintext);
  const malformed: unknown[] = [
    null,
    {},
    { ...envelope, v: 2 },
    { ...envelope, v: "1" },
    { ...envelope, iv: null },
    { ...envelope, iv: Buffer.alloc(11).toString("base64") },
    { ...envelope, iv: Buffer.alloc(13).toString("base64") },
    { ...envelope, iv: `${envelope.iv}\n` },
    { ...envelope, ciphertext: null },
    { ...envelope, ciphertext: "" },
    { ...envelope, ciphertext: Buffer.alloc(23).toString("base64") },
    { ...envelope, ciphertext: Buffer.alloc(4113).toString("base64") },
    { ...envelope, ciphertext: `${envelope.ciphertext} ` },
  ];
  for (const invalid of malformed) {
    await assert.rejects(decryptCredential(masterKey, scope, invalid as CredentialEnvelope), decryptionError);
  }
});

test("master keys must be canonical base64 encoding exactly 256 bits", async () => {
  const envelope = await encryptCredential(masterKey, scope, plaintext);
  const invalidMasterKeys: unknown[] = [
    null,
    "",
    "fixture-master-key",
    Buffer.alloc(31).toString("base64"),
    Buffer.alloc(33).toString("base64"),
    masterKey.slice(0, -1),
    `${masterKey}\n`,
    masterKey.replace(/.$/, "!"),
    `${"A".repeat(42)}B=`,
    "A".repeat(100_000),
  ];
  for (const invalid of invalidMasterKeys) {
    await assert.rejects(encryptCredential(invalid as string, scope, plaintext), encryptionError);
    await assert.rejects(decryptCredential(invalid as string, scope, envelope), decryptionError);
  }
});

test("plaintext boundaries are measured in UTF-8 bytes", async () => {
  for (const valid of ["a".repeat(8), "a".repeat(4096), "é".repeat(2048)]) {
    const envelope = await encryptCredential(masterKey, scope, valid);
    assert.equal(await decryptCredential(masterKey, scope, envelope), valid);
  }
  for (const invalid of ["a".repeat(7), "a".repeat(4097), "é".repeat(2049), null, 123]) {
    await assert.rejects(encryptCredential(masterKey, scope, invalid as string), encryptionError);
  }
});

test("plaintext rejects whitespace, control characters and malformed Unicode", async () => {
  for (const invalid of [
    "sk test-key",
    "sk\ttest-key",
    "sk\ntest-key",
    "sk\rtest-key",
    "sk\u0000test-key",
    "sk\u007ftest-key",
    "sk\u0085test-key",
    "sk\u00a0test-key",
    "sk\u2028test-key",
    "sk\u200btest-key",
    "sk\ud800test-key",
  ]) {
    await assert.rejects(encryptCredential(masterKey, scope, invalid), encryptionError);
  }
});

test("organization and credential IDs are bounded ASCII identifiers", async () => {
  const envelope = await encryptCredential(masterKey, scope, plaintext);
  for (const field of ["organizationId", "credentialId"] as const) {
    for (const invalid of ["", "a".repeat(81), "../org", "org A", "é", "org\n", null, 1]) {
      const invalidScope = { ...scope, [field]: invalid } as CredentialScope;
      await assert.rejects(encryptCredential(masterKey, invalidScope, plaintext), encryptionError);
      await assert.rejects(decryptCredential(masterKey, invalidScope, envelope), decryptionError);
    }
    const validScope = { ...scope, [field]: "A_1-".repeat(20) };
    const validEnvelope = await encryptCredential(masterKey, validScope, plaintext);
    assert.equal(await decryptCredential(masterKey, validScope, validEnvelope), plaintext);
  }
});

test("only named providers and positive safe integer key versions are accepted", async () => {
  const envelope = await encryptCredential(masterKey, scope, plaintext);
  for (const provider of ["", "OpenAI", "other", null, 1]) {
    const invalidScope = { ...scope, provider } as CredentialScope;
    await assert.rejects(encryptCredential(masterKey, invalidScope, plaintext), encryptionError);
    await assert.rejects(decryptCredential(masterKey, invalidScope, envelope), decryptionError);
  }
  for (const keyVersion of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
    const invalidScope = { ...scope, keyVersion } as CredentialScope;
    await assert.rejects(encryptCredential(masterKey, invalidScope, plaintext), encryptionError);
    await assert.rejects(decryptCredential(masterKey, invalidScope, envelope), decryptionError);
  }
  await assert.rejects(encryptCredential(masterKey, null as unknown as CredentialScope, plaintext), encryptionError);
  await assert.rejects(decryptCredential(masterKey, null as unknown as CredentialScope, envelope), decryptionError);
});

test("scope and envelope inputs are never mutated", async () => {
  const frozenScope = Object.freeze({ ...scope });
  const envelope = Object.freeze(await encryptCredential(masterKey, frozenScope, plaintext));
  const before = JSON.stringify(envelope);
  assert.equal(await decryptCredential(masterKey, frozenScope, envelope), plaintext);
  assert.deepEqual(frozenScope, scope);
  assert.equal(JSON.stringify(envelope), before);
});

test("serialized envelopes can be decrypted independently of property order", async () => {
  const envelope = await encryptCredential(masterKey, scope, plaintext);
  const reorderedScope: CredentialScope = {
    keyVersion: scope.keyVersion,
    credentialId: scope.credentialId,
    provider: scope.provider,
    organizationId: scope.organizationId,
  };
  assert.equal(await decryptCredential(masterKey, reorderedScope, JSON.parse(JSON.stringify(envelope))), plaintext);
});

test("failures expose only generic messages without secret values or causes", async () => {
  const secret = "sk-fixture-secret-value";
  await assert.rejects(encryptCredential(secret, scope, secret), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, encryptionError.message);
    assert.equal(error.cause, undefined);
    assert.equal(String(error).includes(secret), false);
    return true;
  });
  const envelope = await encryptCredential(masterKey, scope, secret);
  await assert.rejects(decryptCredential(secret, scope, envelope), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, decryptionError.message);
    assert.equal(error.cause, undefined);
    assert.equal(String(error).includes(secret), false);
    return true;
  });
});
