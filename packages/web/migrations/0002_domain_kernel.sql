-- Migration 0002: Domain Kernel v0.1 (Person, Membership, Role seed, AuditEvent fields)
-- Aplicar via: bun run scripts/migrate-domain-kernel.ts
-- Não apaga dados. ALTER COLUMN ignora se a coluna já existir.

CREATE TABLE IF NOT EXISTS roles (
  code TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO roles (code, name, description, created_at) VALUES
  ('Owner', 'Owner', 'Proprietário da fração', 0),
  ('CoOwner', 'CoOwner', 'Co-proprietário da fração', 0),
  ('Proxy', 'Proxy', 'Representante / procurador', 0),
  ('Admin', 'Admin', 'Administrador do condomínio', 0),
  ('PlatformAdmin', 'PlatformAdmin', 'Administrador da plataforma', 0),
  ('Fiscalizacao', 'Fiscalizacao', 'Capacidade de controlo: confirma ações sensíveis, não as cria', 0);

CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  name TEXT NOT NULL,
  nif TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS persons_user_id_uq ON persons (user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS persons_email_uq ON persons (email);
CREATE UNIQUE INDEX IF NOT EXISTS persons_nif_uq ON persons (nif) WHERE nif IS NOT NULL;

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY NOT NULL,
  person_id TEXT NOT NULL REFERENCES persons(id),
  tenant_id TEXT NOT NULL,
  fracao_id TEXT,
  role_code TEXT NOT NULL REFERENCES roles(code),
  scope TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  created_by_person_id TEXT,
  revoked_at INTEGER,
  revoked_by_person_id TEXT
);

CREATE INDEX IF NOT EXISTS memberships_person_tenant_status_idx
  ON memberships (person_id, tenant_id, status);
CREATE INDEX IF NOT EXISTS memberships_tenant_status_idx
  ON memberships (tenant_id, status);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_user_id TEXT,
  actor_person_id TEXT,
  payload_json TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  source TEXT,
  request_id TEXT,
  created_at INTEGER NOT NULL
);

ALTER TABLE audit_events ADD COLUMN actor_person_id TEXT;
ALTER TABLE audit_events ADD COLUMN before_json TEXT;
ALTER TABLE audit_events ADD COLUMN after_json TEXT;
ALTER TABLE audit_events ADD COLUMN reason TEXT;
ALTER TABLE audit_events ADD COLUMN source TEXT;
ALTER TABLE audit_events ADD COLUMN request_id TEXT;

CREATE INDEX IF NOT EXISTS audit_events_tenant_created_idx ON audit_events (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_events_request_id_idx ON audit_events (request_id);
