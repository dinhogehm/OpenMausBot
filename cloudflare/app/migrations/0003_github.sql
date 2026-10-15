CREATE TABLE github_oauth (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,
  verifier TEXT NOT NULL,
  token TEXT,
  github_user_id INTEGER,
  consumed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX github_oauth_session_idx ON github_oauth(organization_id,user_id,session_hash,expires_at);
CREATE TABLE github_installations (
  installation_id INTEGER PRIMARY KEY NOT NULL,
  app_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL,
  account_login TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  created_at INTEGER NOT NULL
);
CREATE TABLE github_repositories (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL REFERENCES github_installations(installation_id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  connected_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(installation_id,repository_id)
);
CREATE INDEX github_repositories_org_idx ON github_repositories(organization_id,status);
CREATE TABLE github_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE github_publications (
  run_id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES github_repositories(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  branch TEXT NOT NULL,
  tree_sha TEXT,
  commit_sha TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  created_at INTEGER NOT NULL
);
