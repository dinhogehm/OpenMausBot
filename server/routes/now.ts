// "Agora" (this fork, lot Y), moved out of server/index.ts's inline routes
// into the route table (server/routes/README.md): GET /api/now and POST
// /api/now/seen. The table runs after the auth gate; scope rules stay keyed by
// path in server/request-auth.ts (admin scope by default).
import type { NowStatusService } from "../now-status.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface NowRouteDeps {
  nowStatus: Pick<NowStatusService, "current" | "markSeen" | "refresh" | "seen">;
}

export function createNowRoutes(deps: NowRouteDeps): RouteHandler {
  const { nowStatus } = deps;
  return async ({ req, res, url, path, method, json, readBody }) => {
    // ── "Agora" (lot Y): the delivery line now, and what the owner last saw ──
    // Admin scope by default. GET answers from the last minute's status
    // (`refresh=1` recomputes first); POST /seen records each line's
    // fingerprint when the owner closes the panel, for "novo" next time.
    if (method === "GET" && path === "/api/now") {
      const status = url.searchParams.get("refresh") === "1" ? await nowStatus.refresh() : await nowStatus.current();
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { status, seen: nowStatus.seen() });
    }
    if (method === "POST" && path === "/api/now/seen") {
      const body = await readBody(req, 8192);
      if (!body || typeof body !== "object" || typeof body.keys !== "object" || body.keys === null || Array.isArray(body.keys)) return json(res, 400, { error: "send { keys: { line: fingerprint } }" });
      return json(res, 200, { seen: nowStatus.markSeen(body.keys) });
    }
    return PASS;
  };
}
