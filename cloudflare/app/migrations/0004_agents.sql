CREATE TABLE agent_teams (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  profiles TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES user(id)
);
