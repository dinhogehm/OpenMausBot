export type CredentialProvider = "openai" | "anthropic" | "openrouter";

export interface CredentialScope {
  organizationId: string;
  provider: CredentialProvider;
  credentialId: string;
  keyVersion: number;
}

export interface CredentialEnvelope {
  v: 1;
  iv: string;
  ciphertext: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Scope must come from authenticated server-side membership, never client IDs alone. */
export async function encryptCredential(
  masterKey: string,
  scope: CredentialScope,
  plaintext: string,
): Promise<CredentialEnvelope> {
  try {
    const additionalData = authenticatedScope(scope);
    const data = validatePlaintext(plaintext);
    const key = await importMasterKey(masterKey, "encrypt");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData, tagLength: 128 },
      key,
      data,
    );
    return { v: 1, iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)) };
  } catch {
    throw new Error("Credential encryption failed");
  }
}

export async function decryptCredential(
  masterKey: string,
  scope: CredentialScope,
  envelope: CredentialEnvelope,
): Promise<string> {
  try {
    const additionalData = authenticatedScope(scope);
    if (!envelope || envelope.v !== 1) throw new Error("Invalid envelope");
    const iv = decodeBase64(envelope.iv, 12);
    const ciphertext = decodeBase64(envelope.ciphertext, 4112);
    if (iv.length !== 12 || ciphertext.length < 24) throw new Error("Invalid envelope");
    const key = await importMasterKey(masterKey, "decrypt");
    const data = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData, tagLength: 128 },
      key,
      ciphertext,
    );
    const plaintext = decoder.decode(data);
    validatePlaintext(plaintext);
    return plaintext;
  } catch {
    throw new Error("Credential decryption failed");
  }
}

function authenticatedScope(scope: CredentialScope): Uint8Array<ArrayBuffer> {
  if (!scope
    || !validId(scope.organizationId)
    || !validId(scope.credentialId)
    || !["openai", "anthropic", "openrouter"].includes(scope.provider)
    || !Number.isSafeInteger(scope.keyVersion)
    || scope.keyVersion < 1) {
    throw new Error("Invalid scope");
  }
  // Fixed field ordering and schema version are part of the encryption format.
  return encoder.encode(JSON.stringify({
    organizationId: scope.organizationId,
    provider: scope.provider,
    credentialId: scope.credentialId,
    keyVersion: scope.keyVersion,
    schemaVersion: 1,
  }));
}

function validId(value: string): boolean {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 80
    && !/[^A-Za-z0-9_-]/.test(value);
}

function validatePlaintext(plaintext: string): Uint8Array<ArrayBuffer> {
  if (typeof plaintext !== "string" || plaintext.length > 4096 || /[\s\p{Cc}\p{Cf}]/u.test(plaintext)) {
    throw new Error("Invalid plaintext");
  }
  const data = encoder.encode(plaintext);
  if (data.length < 8 || data.length > 4096 || decoder.decode(data) !== plaintext) {
    throw new Error("Invalid plaintext");
  }
  return data;
}

async function importMasterKey(masterKey: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const bytes = decodeBase64(masterKey, 32);
  if (bytes.length !== 32) throw new Error("Invalid master key");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [usage]);
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBase64(value: string, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string"
    || !value.length
    || value.length > Math.ceil(maxBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid encoding");
  }
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (bytes.length > maxBytes || encodeBase64(bytes) !== value) throw new Error("Invalid encoding");
  return bytes;
}
