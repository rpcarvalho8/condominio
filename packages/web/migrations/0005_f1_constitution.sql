-- Migration 0005: F1 — Ingestão + Constituição
-- Upload ≠ processamento. Nada definitivo sem confirmação linha a linha.
-- Aplicar via applyF1ConstitutionSchema / migrate-all-tenants.

CREATE TABLE IF NOT EXISTS ingest_documents (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_upload_id TEXT,
  filename TEXT NOT NULL,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'uploaded',
  retention_class TEXT NOT NULL DEFAULT 'legal_instrument',
  created_at INTEGER NOT NULL,
  created_by_person_id TEXT,
  processed_at INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS ingest_documents_tenant_status_idx
  ON ingest_documents (tenant_id, status);
CREATE INDEX IF NOT EXISTS ingest_documents_tenant_kind_idx
  ON ingest_documents (tenant_id, kind);

CREATE TABLE IF NOT EXISTS extract_lines (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES ingest_documents(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source_excerpt TEXT NOT NULL,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  edited_payload_json TEXT,
  confirmed_at INTEGER,
  confirmed_by_person_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS extract_lines_doc_line_uq
  ON extract_lines (document_id, line_no);
CREATE INDEX IF NOT EXISTS extract_lines_tenant_status_idx
  ON extract_lines (tenant_id, status);

-- Frações constitucionais confirmadas (não confundir com tabela legado `fracoes`)
CREATE TABLE IF NOT EXISTS constitution_fracoes (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  codigo TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'fracao',
  permilagem INTEGER NOT NULL,
  source_document_id TEXT,
  source_line_id TEXT,
  source_excerpt TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER NOT NULL,
  confirmed_by_person_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS constitution_fracoes_tenant_codigo_uq
  ON constitution_fracoes (tenant_id, codigo);
CREATE INDEX IF NOT EXISTS constitution_fracoes_tenant_idx
  ON constitution_fracoes (tenant_id);

CREATE TABLE IF NOT EXISTS owner_contact_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  document_id TEXT,
  fracao_codigo TEXT NOT NULL,
  person_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  nif TEXT,
  source_excerpt TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review',
  confirmed_at INTEGER,
  confirmed_by_person_id TEXT,
  person_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS owner_contact_drafts_tenant_status_idx
  ON owner_contact_drafts (tenant_id, status);

CREATE TABLE IF NOT EXISTS condo_iban_proofs (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  iban TEXT NOT NULL,
  retention_class TEXT NOT NULL DEFAULT 'personal_document',
  status TEXT NOT NULL DEFAULT 'registered',
  created_at INTEGER NOT NULL,
  created_by_person_id TEXT,
  purged_at INTEGER
);

CREATE INDEX IF NOT EXISTS condo_iban_proofs_tenant_idx
  ON condo_iban_proofs (tenant_id);

CREATE TABLE IF NOT EXISTS annual_budgets (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by_person_id TEXT,
  approved_at INTEGER,
  approved_by_person_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS annual_budgets_tenant_year_uq
  ON annual_budgets (tenant_id, year);

CREATE TABLE IF NOT EXISTS annual_budget_lines (
  id TEXT PRIMARY KEY NOT NULL,
  budget_id TEXT NOT NULL REFERENCES annual_budgets(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS annual_budget_lines_budget_idx
  ON annual_budget_lines (budget_id);

CREATE TABLE IF NOT EXISTS obligations (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  fracao_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  budget_line_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  period_year INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  open_amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  legal_basis TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS obligations_budget_line_fracao_uq
  ON obligations (budget_line_id, fracao_id);
CREATE INDEX IF NOT EXISTS obligations_tenant_fracao_idx
  ON obligations (tenant_id, fracao_id);
CREATE INDEX IF NOT EXISTS obligations_tenant_status_idx
  ON obligations (tenant_id, status);
