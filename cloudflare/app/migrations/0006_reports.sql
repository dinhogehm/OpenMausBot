CREATE TABLE report_tracking (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  goals_version INTEGER NOT NULL DEFAULT 0,
  goals TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (organization_id, workspace_id)
);
CREATE TABLE report_runs (
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (organization_id, workspace_id, run_id),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES report_tracking(organization_id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX report_runs_created ON report_runs(organization_id, workspace_id, created_at);
CREATE TABLE report_facts (
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  fact TEXT NOT NULL,
  PRIMARY KEY (organization_id, workspace_id, run_id, fact_id),
  FOREIGN KEY (organization_id, workspace_id, run_id) REFERENCES report_runs(organization_id, workspace_id, run_id) ON DELETE CASCADE
);
CREATE INDEX report_facts_time ON report_facts(organization_id, workspace_id, at);
