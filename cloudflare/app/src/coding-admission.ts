import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";
import { CODING_LIMITS } from "./coding-types";

interface Lease { key: string; organizationId: string; expiresAt: number }
export async function confirmedCodingStop(env: AppEnv, key: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      env.CODING_EXECUTORS.getByName(key).stop(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("coding_cleanup_pending")), 3000); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
/** Separate capacity from the existing short Linux proof. Never reuses a VM. */
export class CodingAdmission extends DurableObject<AppEnv> {
  async acquire(key: string, organizationId: string, expiresAt: number): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      if (expiresAt <= now || expiresAt > now + CODING_LIMITS.durationMs) return false;
      const leases = await this.ctx.storage.get<Lease[]>("leases") ?? [];
      const retained: Lease[] = [];
      for (const lease of leases) {
        if (lease.expiresAt > now) retained.push(lease);
        else {
          try { await confirmedCodingStop(this.env, lease.key); }
          catch { retained.push(lease); }
        }
      }
      await this.ctx.storage.put("leases", retained);
      const existing = retained.find((lease) => lease.key === key);
      if (existing) return existing.organizationId === organizationId && existing.expiresAt === expiresAt && expiresAt > now;
      const starts = (await this.ctx.storage.get<number[]>("starts") ?? []).filter((at) => at > now - 3_600_000);
      if (retained.length >= 4 || retained.some((lease) => lease.organizationId === organizationId) || starts.length >= 30) return false;
      await this.ctx.storage.put({ leases: [...retained, { key, organizationId, expiresAt }], starts: [...starts, now] });
      return true;
    });
  }
  async release(key: string): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const leases = await this.ctx.storage.get<Lease[]>("leases") ?? [];
      await this.ctx.storage.put("leases", leases.filter((lease) => lease.key !== key));
    });
  }
}
