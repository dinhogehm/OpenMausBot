CREATE TABLE browser_admissions (
  run_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX browser_admissions_capacity ON browser_admissions(expires_at);
CREATE INDEX browser_admissions_company ON browser_admissions(organization_id,created_at);
