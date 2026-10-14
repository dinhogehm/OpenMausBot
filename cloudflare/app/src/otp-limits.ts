import type { AppEnv } from "./env";
import { HttpError } from "./http";
import { z } from "zod";

const emailSchema = z.email();

export async function limitOTPDelivery(request: Request, env: AppEnv, body: Record<string, unknown>) {
  if (body.type !== "sign-in" || typeof body.email !== "string" || body.email.length > 254
    || !emailSchema.safeParse(body.email.trim()).success) {
    throw new HttpError(400, "invalid_body");
  }
  body.email = body.email.trim().toLowerCase();
  const encoder = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey("raw", encoder.encode(env.AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  async function opaqueId(scope: string, value: string) {
    const digest = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(`${scope}:${value}`));
    return `${scope}:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  // Cloudflare supplies this header. Never trust X-Forwarded-For from clients.
  // Missing IPs share a conservative bucket (including local development).
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  await admit(env.DB, await opaqueId("ip", ip), 60_000);
  // A blocked IP cannot create new recipient rows, even with rotating addresses.
  await admit(env.DB, await opaqueId("recipient", body.email as string), 600_000);
}

async function admit(db: D1Database, id: string, duration: number) {
  const now = Date.now();
  const result = await db.batch([
    db.prepare(`DELETE FROM recipient_limits WHERE id IN
      (SELECT id FROM recipient_limits WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)`).bind(now),
    db.prepare(`INSERT INTO recipient_limits (id, count, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
        expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
      WHERE expires_at <= ? OR count < 5 RETURNING count`).bind(id, now + duration, now, now, now),
  ]);
  if (result[1].results.length !== 1) throw new HttpError(429, "otp_rate_limited");
}
