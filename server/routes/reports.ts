import type { OwnWorktreeStore } from "../own-worktrees.ts";
import type { ProductivityCollector } from "../productivity-collector.ts";
import { createProductivityReportRoutes } from "./productivity-report.ts";
import type { RouteHandler } from "./table.ts";

export interface ReportRouteDeps {
  productivity: Pick<ProductivityCollector, "getGoals" | "report" | "requestSync" | "setGoals">;
  productivityEnabled: boolean;
  ownStore: Pick<OwnWorktreeStore, "summary">;
}

export function createReportRoutes(deps: ReportRouteDeps): RouteHandler {
  return createProductivityReportRoutes({ productivity: deps.productivity, enabled: deps.productivityEnabled, ownStore: deps.ownStore });
}
