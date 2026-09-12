-- F3 Invitation (ADR-001) — convite por fração + contacto; token só como hash.
-- Nunca QR físico. Aplicar via applyDomainKernelSchema / migrate-all-tenants.

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  fracao_id TEXT NOT NULL,
  canal TEXT NOT NULL,
  contacto TEXT NOT NULL,
  person_name TEXT,
  role_code TEXT NOT NULL DEFAULT 'Owner',
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  used_at INTEGER,
  revoked_at INTEGER,
  revoked_by_person_id TEXT,
  lote_id TEXT,
  contact_verified_at INTEGER,
  verification_code_hash TEXT,
  verification_token_hash TEXT,
  verification_expires_at INTEGER,
  verification_attempts INTEGER NOT NULL DEFAULT 0,
  verification_requests INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by_person_id TEXT,
  accepted_person_id TEXT,
  accepted_membership_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_hash_uq ON invitations (token_hash);
CREATE INDEX IF NOT EXISTS invitations_tenant_status_idx ON invitations (tenant_id, status);
CREATE INDEX IF NOT EXISTS invitations_tenant_lote_idx ON invitations (tenant_id, lote_id);
CREATE INDEX IF NOT EXISTS invitations_tenant_contacto_idx ON invitations (tenant_id, contacto);
