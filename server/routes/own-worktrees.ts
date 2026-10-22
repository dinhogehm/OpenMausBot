// The worktrees the server made for its app sessions (this fork, lote X),
// moved out of server/index.ts's inline routes into the route table
// (server/routes/README.md): GET /api/worktrees/own. The table runs after the
// auth gate; scope rules stay keyed by path in server/request-auth.ts (admin
// scope by default).
import { existsSync } from "node:fs";

import type { CcSessionLedger } from "../cc-sessions.ts";
import { leftOwnWorktrees, type OwnBreakerState, type OwnWorktreeStore } from "../own-worktrees.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface OwnWorktreeRouteDeps {
  ownStore: Pick<OwnWorktreeStore, "allEvents" | "summary">;
  ccLedger: Pick<CcSessionLedger, "all">;
  /** The breaker of the server's worktree path, kept across restarts. */
  ownBreaker: { get(): OwnBreakerState };
  registeredWorktreePaths(repo: string): string[] | null;
}

export function createOwnWorktreeRoutes(deps: OwnWorktreeRouteDeps): RouteHandler {
  const { ownStore, ccLedger, ownBreaker, registeredWorktreePaths } = deps;
  return async ({ res, url, path, method, json }) => {
    // ── the worktrees the server made for its app sessions (lote X): what the
    // clones saved, the seeds, the latest worktrees. Read-only; nothing here
    // (nor anywhere in the server) removes a worktree.
    if (method === "GET" && path === "/api/worktrees/own") {
      const now = Date.now();
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 30) || 30));
      return json(res, 200, {
        period: { from: now - days * 86_400_000, to: now, days },
        summary: ownStore.summary(now - days * 86_400_000, now + 1),
        allTime: ownStore.summary(0, now + 1),
        latest: ownStore.allEvents().slice(-20).reverse(),
        // worktrees of failed sessions (or never used): told with the command, never removed
        left: leftOwnWorktrees(ccLedger.all(), existsSync, registeredWorktreePaths),
        breaker: ownBreaker.get().repos,
      });
    }
    return PASS;
  };
}
