-- F3 portal — tickets + foto (content-addressed) + contactar admin.
-- Multi-tenant; AuthZ pela Membership da fração. Sem LLM / sem CRM.
-- Aplicar via applyDomainKernelSchema / migrate-all-tenants.

CREATE TABLE IF NOT EXISTS portal_tickets (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  fracao_id TEXT NOT NULL,
  created_by_person_id TEXT NOT NULL,
  created_by_user_id TEXT,
  titulo TEXT NOT NULL,
  descricao TEXT NOT NULL,
  categoria TEXT NOT NULL DEFAULT 'outro',
  urgencia TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'aberto',
  origem TEXT NOT NULL DEFAULT 'portal',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS portal_tickets_tenant_fracao_idx
  ON portal_tickets (tenant_id, fracao_id);
CREATE INDEX IF NOT EXISTS portal_tickets_tenant_created_idx
  ON portal_tickets (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS portal_ticket_photos (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL REFERENCES portal_tickets(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by_person_id TEXT
);

CREATE INDEX IF NOT EXISTS portal_ticket_photos_ticket_idx
  ON portal_ticket_photos (ticket_id);
CREATE INDEX IF NOT EXISTS portal_ticket_photos_tenant_hash_idx
  ON portal_ticket_photos (tenant_id, content_hash);

CREATE TABLE IF NOT EXISTS portal_admin_contacts (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  fracao_id TEXT NOT NULL,
  created_by_person_id TEXT NOT NULL,
  created_by_user_id TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS portal_admin_contacts_tenant_person_idx
  ON portal_admin_contacts (tenant_id, created_by_person_id);
CREATE INDEX IF NOT EXISTS portal_admin_contacts_tenant_created_idx
  ON portal_admin_contacts (tenant_id, created_at);
