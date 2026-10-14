import { env } from "cloudflare:workers";
import { applyD1Migrations, runInDurableObject, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll } from "vitest";
import type { AppEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv { TEST_MIGRATIONS: D1Migration[] }
  }
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(async () => {
  await runInDurableObject(env.ADMISSION.getByName("global"), async (_instance, state) => { await state.storage.deleteAll(); });
  await env.DB.batch(
    ["credential_events", "provider_credentials", "workspaces", "memberships", "organizations",
      "recipient_limits", "session", "account", "verification", "rateLimit", "user"]
      .map((table) => env.DB.prepare(`DELETE FROM "${table}"`)),
  );
});
