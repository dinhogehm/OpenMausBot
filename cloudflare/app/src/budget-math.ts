import { BUDGET_TIMEZONE } from "./budget-types";

export function safeInteger(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("budget_amount_invalid");
  return Number(value);
}
/** Exact decimal conversion, including provider scientific notation; round up. */
export function decimalUnits(value: unknown, places: number): number {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("budget_amount_invalid");
  const text = String(value); const match = /^(\d{1,20})(?:\.(\d{1,30}))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text);
  if (!match || !Number.isSafeInteger(places) || places < 0 || places > 12) throw new Error("budget_amount_invalid");
  const exponent = Number(match[3] ?? 0); if (Math.abs(exponent) > 30) throw new Error("budget_amount_invalid");
  const digits = BigInt(match[1] + (match[2] ?? "")); const shift = places + exponent - (match[2]?.length ?? 0);
  if (shift >= 0) return safeInteger(digits * 10n ** BigInt(shift));
  const divisor = 10n ** BigInt(-shift); return safeInteger((digits + divisor - 1n) / divisor);
}
export const addMoney = (...values: number[]) => safeInteger(values.reduce((sum, value) => sum + BigInt(value), 0n));
export function brlMicros(usdNanos: number, brlPerUsdMicros: number): number {
  return safeInteger((BigInt(usdNanos) * BigInt(brlPerUsdMicros) + 999_999_999n) / 1_000_000_000n);
}
export function budgetDay(now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUDGET_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export async function hashSource(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}
export async function publicJson(url: string, requestFetch: typeof fetch, maxBytes = 1048576): Promise<{ data: unknown; sha256: string }> {
  const response = await requestFetch(url, { redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw new Error("budget_source_unavailable"); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > maxBytes) throw new Error("budget_source_invalid"); chunks.push(part.value); }
    const buffer = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { data: JSON.parse(text), sha256: await hashSource(text) };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("budget_source_invalid");
  return value as Record<string, unknown>;
}
export function count(value: unknown, max = 100_000_000): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new Error("budget_count_invalid");
  return Number(value);
}
