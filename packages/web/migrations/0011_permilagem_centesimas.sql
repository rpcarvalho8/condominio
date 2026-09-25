-- Migration 0011: permilagem canónica em centésimas de ‰.
-- Aplicar via applyF1ConstitutionSchema (idempotente).
--
-- SQLite não remove NOT NULL com ALTER. O applier reconstrói a tabela
-- com cópia integral quando `permilagem` ainda é NOT NULL ou quando
-- `permilagem_centesimas` ainda não existe. Se aparecer uma coluna
-- desconhecida, a migração pára e a tabela original fica intacta.
-- Reexecutar o applier numa tabela já migrada é no-op.
-- Não correr este script à mão uma segunda vez: o DROP abaixo só é
-- seguro dentro do guarda do applier.
--
-- Linhas existentes: `permilagem` inteira mantém-se; `permilagem_centesimas`
-- fica NULL. Não se reconstrói o decimal a partir do arredondamento antigo.

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
  id, tenant_id, codigo, tipo, permilagem, NULL,
  source_document_id, source_line_id, source_excerpt, status,
  created_at, confirmed_at, confirmed_by_person_id
FROM constitution_fracoes;

DROP TABLE constitution_fracoes;

ALTER TABLE constitution_fracoes__centesimas_rebuild RENAME TO constitution_fracoes;

CREATE UNIQUE INDEX IF NOT EXISTS constitution_fracoes_tenant_codigo_uq
  ON constitution_fracoes (tenant_id, codigo);
CREATE INDEX IF NOT EXISTS constitution_fracoes_tenant_idx
  ON constitution_fracoes (tenant_id);
