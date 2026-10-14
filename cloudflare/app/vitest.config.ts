import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Synthetic fixture secrets only. No .dev.vars or production credentials needed.
process.env.AUTH_SECRET = "fixture-only-auth-secret-at-least-32-characters";
process.env.CREDENTIAL_MASTER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) },
    miniflare: { bindings: {
      APP_ORIGIN: "https://cloud-app.example.test",
      AUTH_SECRET: "fixture-only-auth-secret-at-least-32-characters",
      CREDENTIAL_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url))),
    } },
  }))],
  test: { include: ["test/**/*.integration.test.ts"], setupFiles: ["./test/setup.ts"] },
});
