// The productivity report and its targets: read-only, built from the collector's cache (never waits on GitHub).
import type { ProductivityCollector } from "../productivity-collector.ts";
import { executiveSummary, exportFileName, reportMarkdown, reportPdf } from "../productivity-export.ts";
import { exportReadiness, GRANULARITIES, resolveReportPeriod, type Granularity } from "../../shared/productivity.ts";
import { PASS, type RouteHandler } from "./table.ts";

const REPORT_PATHS = new Set(["/api/reports/productivity", "/api/reports/productivity.md", "/api/reports/productivity.pdf"]);

export function createProductivityReportRoutes(deps: { productivity: ProductivityCollector; enabled: boolean }): RouteHandler {
  const { productivity } = deps;
  return async ({ req, res, url, path, method, json, readBody }) => {
    // the report's targets: empty by default; a target lights its KPI
    if (path === "/api/reports/productivity/goals" && (method === "GET" || method === "PUT")) {
      if (method === "GET") return json(res, 200, { goals: productivity.getGoals() });
      const body = await readBody(req, 4096);
      if (!body || typeof body !== "object") return json(res, 400, { error: "send the goals as a JSON object" });
      return json(res, 200, { goals: productivity.setGoals(body.goals ?? body) });
    }
    if (method !== "GET" || !REPORT_PATHS.has(path)) return PASS;
    // `refresh=1` asks for a sync in the background. Admin scope by default.
    const granularity = (url.searchParams.get("granularity") ?? "day") as Granularity;
    if (!GRANULARITIES.includes(granularity)) return json(res, 400, { error: "granularity must be hour, day or month" });
    const rawCount = url.searchParams.get("count");
    const count = rawCount === null ? null : Number(rawCount);
    if (count !== null && (!Number.isInteger(count) || count <= 0)) return json(res, 400, { error: "count must be a positive whole number" });
    const resolved = resolveReportPeriod({ granularity, from: url.searchParams.get("from"), to: url.searchParams.get("to"), count, now: Date.now() });
    if ("error" in resolved) return json(res, 400, { error: resolved.error });
    if (url.searchParams.get("refresh") === "1" && deps.enabled) productivity.requestSync();
    const report = { ...productivity.report(granularity, resolved.period), enabled: deps.enabled };
    report.summary = { "pt-BR": executiveSummary(report, "pt-BR"), en: executiveSummary(report, "en") };
    if (path.endsWith(".md") || path.endsWith(".pdf")) {
      const pdf = path.endsWith(".pdf");
      // the board never gets a stale or unverified report by accident: the
      // screen syncs first ("Atualizar e exportar") or the owner insists
      // (force=1), and then the export carries the warning on its first page
      const readiness = exportReadiness(report, report.generatedAt);
      if (!readiness.ready && url.searchParams.get("force") !== "1") {
        res.setHeader("cache-control", "no-store");
        return json(res, 409, { error: "export-blocked", blockers: readiness.blockers, ageMs: readiness.ageMs });
      }
      res.writeHead(200, {
        "content-type": pdf ? "application/pdf" : "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${exportFileName(report, pdf ? "pdf" : "md")}"`,
        "cache-control": "no-store",
      });
      res.end(pdf ? reportPdf(report) : reportMarkdown(report));
      return;
    }
    res.setHeader("cache-control", "no-store");
    return json(res, 200, report);
  };
}
