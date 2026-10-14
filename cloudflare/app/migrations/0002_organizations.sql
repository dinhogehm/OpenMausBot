CREATE TABLE organizations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  created_at INTEGER NOT NULL
);
CREATE TABLE memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE (organization_id, id)
);
CREATE TABLE provider_credentials (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('openai', 'anthropic', 'openrouter')),
  id TEXT NOT NULL UNIQUE,
  key_version INTEGER NOT NULL CHECK(key_version > 0),
  status TEXT NOT NULL CHECK(status IN ('configured', 'revoked')),
  iv TEXT,
  ciphertext TEXT,
  mutation_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES "user"(id),
  PRIMARY KEY (organization_id, provider),
  CHECK ((status = 'configured' AND iv IS NOT NULL AND ciphertext IS NOT NULL)
    OR (status = 'revoked' AND iv IS NULL AND ciphertext IS NULL))
);
CREATE TABLE credential_events (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('configured', 'rotated', 'revoked')),
  actor_id TEXT NOT NULL REFERENCES "user"(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX credential_events_org_idx ON credential_events(organization_id, created_at);
CREATE TABLE recipient_limits (
  id TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX recipient_limits_expiry_idx ON recipient_limits(expires_at);
CREATE TABLE credential_write_limits (
  organization_id TEXT PRIMARY KEY NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
