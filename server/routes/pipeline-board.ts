// "Esteira" (this fork, lot Z), moved out of server/index.ts's inline routes
// into the route table (server/routes/README.md): GET /api/pipeline-board and
// GET/PUT /api/pipeline-board/limits. The table runs after the auth gate;
// scope rules stay keyed by path in server/request-auth.ts (admin scope by
// default).
import { boardEtag, type PipelineBoardService } from "../pipeline-board-live.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface PipelineBoardRouteDeps {
  pipelineBoard: Pick<PipelineBoardService, "board" | "getLimits" | "setLimits">;
}

export function createPipelineBoardRoutes(deps: PipelineBoardRouteDeps): RouteHandler {
  const { pipelineBoard } = deps;
  return async ({ req, res, path, method, json, readBody }) => {
    // ── "Esteira" (lot Z): where each piece of work stands, stage by stage ──
    // Read-only, never waits on GitHub; a poll that finds nothing new gets a 304.
    // the owner's limits per stage: the defaults until set; a value out of range keeps its default
    if (path === "/api/pipeline-board/limits" && (method === "GET" || method === "PUT")) {
      if (method === "GET") return json(res, 200, { limits: pipelineBoard.getLimits() });
      const body = await readBody(req, 4096);
      if (!body || typeof body !== "object") return json(res, 400, { error: "send the limits as a JSON object" });
      return json(res, 200, { limits: pipelineBoard.setLimits(body.limits ?? body) });
    }
    if (method === "GET" && path === "/api/pipeline-board") {
      const board = pipelineBoard.board();
      const etag = boardEtag(board);
      res.setHeader("cache-control", "no-cache");
      res.setHeader("etag", etag);
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      return json(res, 200, board);
    }
    return PASS;
  };
}
