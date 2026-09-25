-- AVISO: SCRIPT DESTRUTIVO. ESTE FICHEIRO APAGA constitution_fracoes.
-- NÃO O CORRA DUAS VEZES. NÃO O CORRA NUMA BASE QUE JÁ TENHA permilagem_centesimas.
-- A PRIMEIRA INSTRUÇÃO FALHA LOGO SE A COLUNA JÁ EXISTIR.
-- CORRA COM sqlite3 -bail (OU EQUIVALENTE QUE PÁRA NO PRIMEIRO ERRO).
-- SEM -bail, O SQLITE CONTINUA DEPOIS DE UM ALTER FALHADO E PODE APAGAR A TABELA VIVA.
-- PREFIRA applyF1ConstitutionSchema. SE O SCRIPT PARAR DEPOIS DO ALTER, VOLTE A CORRER O APPLIER, NÃO ESTE FICHEIRO.
-- ESTE SCRIPT COPIA permilagem_centesimas. NÃO ESCREVE NULL POR CIMA DE CENTÉSIMAS JÁ GRAVADAS.
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
