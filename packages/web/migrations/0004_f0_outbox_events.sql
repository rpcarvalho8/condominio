-- Migration 0004: F0 complete — DomainEvent, Outbox, Policy skeleton, uploads, notifications
-- Aplicar via applyDomainKernelSchema / migrate-domain-kernel / migrate-all-tenants
-- Corre em cada BD de tenant.

CREATE TABLE IF NOT EXISTS domain_events (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT,
  occurred_at INTEGER NOT NULL,
  correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS outbox_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  processed_at INTEGER,
  correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  code TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  body_json TEXT,
  effective_from INTEGER NOT NULL,
  superseded_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS content_uploads (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  filename TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  destination TEXT NOT NULL,
  template TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  idempotency_key TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);
