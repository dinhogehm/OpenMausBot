import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";

interface Lease { key: string; organizationId: string; expiresAt: number }
interface AdmissionState { leases: Lease[]; starts: number[] }

/** Global, durable ceilings. A cancellation retains its lease until stopped/expired. */
export class Admission extends DurableObject<AppEnv> {
  async acquire(key: string, organizationId: string, expiresAt: number): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      if (expiresAt <= now || expiresAt > now + 60_000) return false;
      const stored = await this.ctx.storage.get<AdmissionState>("state") ?? { leases: [], starts: [] };
      const leases: Lease[] = [];
      for (const lease of stored.leases) {
        if (lease.expiresAt > now) { leases.push(lease); continue; }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.env.LINUX_EXECUTORS.getByName(lease.key).stop(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("stop_unconfirmed")), 3000); }),
          ]);
        } catch { leases.push(lease); }
        finally { if (timer !== undefined) clearTimeout(timer); }
      }
      const state = {
        // Time alone cannot prove that the container was terminated.
        leases,
        starts: stored.starts.filter((time) => time > now - 3_600_000),
      };
      await this.ctx.storage.put("state", state);
      if (state.leases.some((lease) => lease.key === key && lease.organizationId === organizationId && lease.expiresAt > now)) return true;
      if (state.leases.length >= 4 || state.starts.length >= 30 || state.leases.some((lease) => lease.organizationId === organizationId)) return false;
      state.leases.push({ key, organizationId, expiresAt });
      state.starts.push(now);
      await this.ctx.storage.put("state", state);
      return true;
    });
  }

  async release(key: string): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get<AdmissionState>("state");
      if (state) await this.ctx.storage.put("state", { ...state, leases: state.leases.filter((lease) => lease.key !== key) });
    });
  }
}
