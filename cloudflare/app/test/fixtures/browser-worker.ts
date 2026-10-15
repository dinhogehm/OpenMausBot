// Disposable, loopback-only browser fixture. Never a production entrypoint.
import worker from "../../src/index";
import type { AppEnv } from "../../src/env";
export { Admission, ExecutionRoom, LinuxExecutor, CodingAdmission, CodingRoom, CodingExecutor, CodingDependencyNetwork } from "../../src/index";

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return new Response("Fixture only", { status: 403 });
    if (url.pathname === "/__fixture/otp") {
      const email = url.searchParams.get("email") ?? "";
      if (!email.endsWith("@example.test")) return new Response(null, { status: 400 });
      const result = await env.DB.prepare("SELECT otp FROM fixture_mailbox WHERE email = ?").bind(email).first();
      return Response.json(result ?? {}, { headers: { "cache-control": "no-store" } });
    }
    return worker.fetch(request, { ...env, EMAIL: { async send(message) {
      if (!message.to.endsWith("@example.test")) throw new Error("Fixture recipient required");
      const otp = message.text.match(/\b\d{8}\b/)?.[0];
      if (!otp) throw new Error("Fixture code missing");
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS fixture_mailbox (email TEXT PRIMARY KEY, otp TEXT NOT NULL)").run();
      await env.DB.prepare("INSERT OR REPLACE INTO fixture_mailbox VALUES (?, ?)").bind(message.to, otp).run();
    } } }, ctx);
  },
};
