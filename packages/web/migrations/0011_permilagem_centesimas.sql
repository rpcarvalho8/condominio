-- WARNING: DESTRUCTIVE SCRIPT. THIS DROPS constitution_fracoes.
-- DO NOT RUN IT TWICE. DO NOT RUN IT ON A DATABASE THAT ALREADY HAS permilagem_centesimas.
-- THE FIRST STATEMENT FAILS FAST WHEN THE COLUMN ALREADY EXISTS.
-- RUN WITH sqlite3 -bail (OR AN EQUIVALENT THAT STOPS ON THE FIRST ERROR).
-- WITHOUT -bail, SQLITE KEEPS GOING AFTER A FAILED ALTER AND CAN DROP THE LIVE TABLE.
-- PREFER applyF1ConstitutionSchema. IF THIS SCRIPT STOPS AFTER THE ALTER, RE-RUN THE APPLIER, NOT THIS FILE.
-- THIS SCRIPT COPIES permilagem_centesimas. IT DOES NOT WRITE NULL OVER EXISTING CENTESIMAS.
--
-- SQLite não remove NOT NULL com ALTER. O resto da migração reconstrói a tabela.
-- Linhas que já existiam ficam com centésimas NULL porque a coluna acaba de ser criada;
-- um valor já gravado em permilagem_centesimas é copiado, não substituído por NULL.

ALTER TABLE constitution_fracoes ADD COLUMN permilagem_centesimas INTEGER;

BEGIN;

CREATE TABLE constitution_fracoes__centesimas_rebuild (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  codigo TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'fracao',
  permilagem INTEGER,
  permilagem_centesimas INTEGER,
  source_document_id TEXT,
  source_line_id TEXT,
  source_excerpt TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER NOT NULL,
  confirmed_by_person_id TEXT
);

INSERT INTO constitution_fracoes__centesimas_rebuild (
  id, tenant_id, codigo, tipo, permilagem, permilagem_centesimas,
  source_document_id, source_line_id, source_excerpt, status,
  created_at, confirmed_at, confirmed_by_person_id
)
SELECT
  id, tenant_id, codigo, tipo, permilagem, permilagem_centesimas,
  source_document_id, source_line_id, source_excerpt, status,
  created_at, confirmed_at, confirmed_by_person_id
FROM constitution_fracoes;

DROP TABLE constitution_fracoes;

ALTER TABLE constitution_fracoes__centesimas_rebuild RENAME TO constitution_fracoes;

CREATE UNIQUE INDEX IF NOT EXISTS constitution_fracoes_tenant_codigo_uq
  ON constitution_fracoes (tenant_id, codigo);
CREATE INDEX IF NOT EXISTS constitution_fracoes_tenant_idx
  ON constitution_fracoes (tenant_id);

COMMIT;
