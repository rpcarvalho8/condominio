-- Migration 0001: RecordingSegment hardening
-- tenant_id, ordinal unique, audit_events, client timestamps
-- Aplicar via: bun run scripts/migrate-reuniao-recording-segments.ts

ALTER TABLE reunioes ADD COLUMN tenant_id TEXT;
ALTER TABLE reunioes ADD COLUMN processing_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reunioes ADD COLUMN processing_started_at INTEGER;
ALTER TABLE reunioes ADD COLUMN processing_completed_at INTEGER;

UPDATE reunioes SET tenant_id = '__TENANT_ID__' WHERE tenant_id IS NULL OR tenant_id = '';

CREATE TABLE IF NOT EXISTS recording_segments (
  id TEXT PRIMARY KEY NOT NULL,
  reuniao_id TEXT NOT NULL REFERENCES reunioes(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  client_started_at INTEGER,
  client_ended_at INTEGER,
  reason_ended TEXT,
  storage_path TEXT,
  byte_size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'closed',
  created_at INTEGER NOT NULL
);

ALTER TABLE recording_segments ADD COLUMN client_started_at INTEGER;
ALTER TABLE recording_segments ADD COLUMN client_ended_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS recording_segments_reuniao_ordinal_uq
  ON recording_segments (reuniao_id, ordinal);
CREATE INDEX IF NOT EXISTS recording_segments_reuniao_idx
  ON recording_segments (reuniao_id);

CREATE INDEX IF NOT EXISTS reunioes_tenant_idx ON reunioes (tenant_id);
CREATE INDEX IF NOT EXISTS reunioes_tenant_status_idx ON reunioes (tenant_id, status);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_user_id TEXT,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_tenant_created_idx
  ON audit_events (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx
  ON audit_events (entity_type, entity_id);
