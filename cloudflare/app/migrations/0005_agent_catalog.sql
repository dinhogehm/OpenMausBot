CREATE TABLE agent_catalogs (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  profiles TEXT NOT NULL CHECK(json_valid(profiles)),
  selections TEXT NOT NULL CHECK(json_valid(selections)),
  receipts TEXT NOT NULL CHECK(json_valid(receipts)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES user(id)
);

CREATE TABLE decision_credentials (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  status TEXT NOT NULL CHECK(status IN ('configured','revoked')),
  iv TEXT,
  ciphertext TEXT,
  mutation_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES user(id),
  CHECK((status = 'configured' AND iv IS NOT NULL AND ciphertext IS NOT NULL)
    OR (status = 'revoked' AND iv IS NULL AND ciphertext IS NULL))
);

CREATE TABLE decision_limits (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  lease_id TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL
);
