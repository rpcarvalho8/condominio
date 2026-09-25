import type { SqlExecutor } from "./kernel-schema";

function alreadyExists(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return (
    msg.includes("duplicate column") ||
    msg.includes("already exists") ||
    msg.includes("duplicate column name")
  );
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS ingest_documents (
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
    error TEXT,
    pipeline_json TEXT
  )`,
  `ALTER TABLE ingest_documents ADD COLUMN pipeline_json TEXT`,
  `CREATE INDEX IF NOT EXISTS ingest_documents_tenant_status_idx
    ON ingest_documents (tenant_id, status)`,
  `CREATE INDEX IF NOT EXISTS ingest_documents_tenant_kind_idx
    ON ingest_documents (tenant_id, kind)`,
  `CREATE TABLE IF NOT EXISTS extract_lines (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS extract_lines_doc_line_uq
    ON extract_lines (document_id, line_no)`,
  `CREATE INDEX IF NOT EXISTS extract_lines_tenant_status_idx
    ON extract_lines (tenant_id, status)`,
  `CREATE TABLE IF NOT EXISTS constitution_fracoes (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS constitution_fracoes_tenant_codigo_uq
    ON constitution_fracoes (tenant_id, codigo)`,
  `CREATE INDEX IF NOT EXISTS constitution_fracoes_tenant_idx
    ON constitution_fracoes (tenant_id)`,
  `CREATE TABLE IF NOT EXISTS owner_contact_drafts (
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
  )`,
  `CREATE INDEX IF NOT EXISTS owner_contact_drafts_tenant_status_idx
    ON owner_contact_drafts (tenant_id, status)`,
  `CREATE TABLE IF NOT EXISTS condo_iban_proofs (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    iban TEXT NOT NULL,
    retention_class TEXT NOT NULL DEFAULT 'personal_document',
    status TEXT NOT NULL DEFAULT 'registered',
    created_at INTEGER NOT NULL,
    created_by_person_id TEXT,
    purged_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS condo_iban_proofs_tenant_idx
    ON condo_iban_proofs (tenant_id)`,
  `CREATE TABLE IF NOT EXISTS annual_budgets (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    year INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by_person_id TEXT,
    approved_at INTEGER,
    approved_by_person_id TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS annual_budgets_tenant_year_uq
    ON annual_budgets (tenant_id, year)`,
  `CREATE TABLE IF NOT EXISTS annual_budget_lines (
    id TEXT PRIMARY KEY NOT NULL,
    budget_id TEXT NOT NULL REFERENCES annual_budgets(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS annual_budget_lines_budget_idx
    ON annual_budget_lines (budget_id)`,
  `CREATE TABLE IF NOT EXISTS obligations (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS obligations_budget_line_fracao_uq
    ON obligations (budget_line_id, fracao_id)`,
  `CREATE INDEX IF NOT EXISTS obligations_tenant_fracao_idx
    ON obligations (tenant_id, fracao_id)`,
  `CREATE INDEX IF NOT EXISTS obligations_tenant_status_idx
    ON obligations (tenant_id, status)`,
];

async function execSafe(client: SqlExecutor, stmt: string): Promise<void> {
  try {
    await client.execute(stmt);
  } catch (e) {
    if (alreadyExists(e)) return;
    throw e;
  }
}

const REBUILD_TABLE = "constitution_fracoes__centesimas_rebuild";
const GUARD_TABLE = "constitution_fracoes__centesimas_guard";

const INDEX_SQL = [
  `CREATE UNIQUE INDEX IF NOT EXISTS constitution_fracoes_tenant_codigo_uq
      ON constitution_fracoes (tenant_id, codigo)`,
  `CREATE INDEX IF NOT EXISTS constitution_fracoes_tenant_idx
      ON constitution_fracoes (tenant_id)`,
];

const REBUILD_DDL = `CREATE TABLE ${REBUILD_TABLE} (
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
  )`;

const CONSTITUTION_COLUMNS = [
  "id",
  "tenant_id",
  "codigo",
  "tipo",
  "permilagem",
  "permilagem_centesimas",
  "source_document_id",
  "source_line_id",
  "source_excerpt",
  "status",
  "created_at",
  "confirmed_at",
  "confirmed_by_person_id",
] as const;

const PRE_0011_COLUMNS = new Set<string>(
  CONSTITUTION_COLUMNS.filter((name) => name !== "permilagem_centesimas"),
);

type TableColumn = { name: string; notnull: number };

type QueryRow = Record<string, unknown>;

async function queryRows(client: SqlExecutor, sql: string): Promise<QueryRow[]> {
  const result = (await client.execute(sql)) as { rows?: unknown[] };
  return (result.rows ?? []).map((row) => {
    if (row != null && typeof row === "object" && !Array.isArray(row)) {
      return row as QueryRow;
    }
    throw new Error("Migração 0011: resultado SQL inesperado.");
  });
}

function cell(row: QueryRow, key: string): unknown {
  if (key in row) return row[key];
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(row)) {
    if (name.toLowerCase() === lower) return value;
  }
  return undefined;
}

async function tableExists(client: SqlExecutor, name: string): Promise<boolean> {
  const rows = await queryRows(
    client,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${name}'`,
  );
  return rows.length > 0;
}

async function constitutionColumns(client: SqlExecutor): Promise<TableColumn[]> {
  const rows = await queryRows(client, "PRAGMA table_info(constitution_fracoes)");
  return rows.map((row) => ({
    name: String(cell(row, "name") ?? ""),
    notnull: Number(cell(row, "notnull") ?? 0),
  }));
}

async function scalarCount(client: SqlExecutor, table: string): Promise<number> {
  const rows = await queryRows(client, `SELECT COUNT(*) AS n FROM ${table}`);
  return Number(cell(rows[0] ?? {}, "n") ?? 0);
}

function canBatch(
  client: SqlExecutor,
): client is SqlExecutor & { batch: NonNullable<SqlExecutor["batch"]> } {
  return typeof client.batch === "function";
}

async function runWrite(client: SqlExecutor, stmts: string[]): Promise<void> {
  if (canBatch(client)) {
    await client.batch(stmts, "write");
    return;
  }
  for (const stmt of stmts) await client.execute(stmt);
}

async function recreateConstitutionIndexes(client: SqlExecutor): Promise<void> {
  await runWrite(client, INDEX_SQL);
}

function isTargetShape(columns: TableColumn[]): boolean {
  const perm = columns.find((column) => column.name === "permilagem");
  const cent = columns.find((column) => column.name === "permilagem_centesimas");
  return Boolean(perm && perm.notnull === 0 && cent);
}

function copyOkSelect(hasCentesimas: boolean): string {
  const centesimas = hasCentesimas
    ? "AND a.permilagem_centesimas IS b.permilagem_centesimas"
    : "AND b.permilagem_centesimas IS NULL";
  return `SELECT CASE
    WHEN (SELECT COUNT(*) FROM ${REBUILD_TABLE}) = (SELECT COUNT(*) FROM constitution_fracoes)
     AND (SELECT COUNT(*) FROM (
       SELECT a.id
       FROM constitution_fracoes AS a
       INNER JOIN ${REBUILD_TABLE} AS b ON a.id = b.id
       WHERE a.codigo = b.codigo
         AND a.tenant_id = b.tenant_id
         AND a.tipo = b.tipo
         AND a.permilagem IS b.permilagem
         AND a.status = b.status
         AND a.created_at = b.created_at
         AND a.confirmed_at = b.confirmed_at
         AND a.source_document_id IS b.source_document_id
         AND a.source_line_id IS b.source_line_id
         AND a.source_excerpt IS b.source_excerpt
         AND a.confirmed_by_person_id IS b.confirmed_by_person_id
         ${centesimas}
     )) = (SELECT COUNT(*) FROM constitution_fracoes)
    THEN 1 ELSE 0 END`;
}

function rebuildStatements(hasCentesimas: boolean): string[] {
  const centesimasSelect = hasCentesimas ? "permilagem_centesimas" : "NULL";
  return [
    `DROP TABLE IF EXISTS ${GUARD_TABLE}`,
    `DROP TABLE IF EXISTS ${REBUILD_TABLE}`,
    REBUILD_DDL,
    `INSERT INTO ${REBUILD_TABLE} (
      id, tenant_id, codigo, tipo, permilagem, permilagem_centesimas,
      source_document_id, source_line_id, source_excerpt, status,
      created_at, confirmed_at, confirmed_by_person_id
    )
    SELECT
      id, tenant_id, codigo, tipo, permilagem, ${centesimasSelect},
      source_document_id, source_line_id, source_excerpt, status,
      created_at, confirmed_at, confirmed_by_person_id
    FROM constitution_fracoes`,
    `CREATE TABLE ${GUARD_TABLE} (ok INTEGER NOT NULL CHECK (ok = 1))`,
    `INSERT INTO ${GUARD_TABLE} (ok) ${copyOkSelect(hasCentesimas)}`,
    `DROP TABLE ${GUARD_TABLE}`,
    "DROP TABLE constitution_fracoes",
    `ALTER TABLE ${REBUILD_TABLE} RENAME TO constitution_fracoes`,
    ...INDEX_SQL,
  ];
}

function isGuardFailure(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return msg.includes("check constraint") || msg.includes(GUARD_TABLE);
}

function copyMismatchError(cause: unknown): Error {
  return new Error(
    "Migração 0011 interrompida: cópia não confere. Tabela original intacta.",
    { cause },
  );
}

/** O rebuild com linhas é a única cópia: nunca o apagar. Renomeia-o para o lugar. */
async function promoteRebuild(client: SqlExecutor, dropEmptyLive: boolean): Promise<void> {
  const stmts = [
    ...(dropEmptyLive ? ["DROP TABLE constitution_fracoes"] : []),
    `ALTER TABLE ${REBUILD_TABLE} RENAME TO constitution_fracoes`,
    ...INDEX_SQL,
  ];
  await runWrite(client, stmts);
}

/**
 * Sem batch, cada execute é a sua transacção. Se a cópia falha antes do DROP
 * da tabela viva, apaga-se só o rebuild incompleto. Se a tabela viva já não
 * existe, o rebuild fica — é a cópia.
 */
async function dropIncompleteRebuild(client: SqlExecutor): Promise<void> {
  if (!(await tableExists(client, "constitution_fracoes"))) return;
  if (await tableExists(client, REBUILD_TABLE)) {
    await client.execute(`DROP TABLE ${REBUILD_TABLE}`);
  }
  if (await tableExists(client, GUARD_TABLE)) {
    await client.execute(`DROP TABLE ${GUARD_TABLE}`);
  }
}

async function rebuildFromLive(client: SqlExecutor, hasCentesimas: boolean): Promise<void> {
  const stmts = rebuildStatements(hasCentesimas);
  if (canBatch(client)) {
    try {
      await client.batch(stmts, "write");
    } catch (err) {
      if (isGuardFailure(err)) throw copyMismatchError(err);
      throw err;
    }
    return;
  }

  const swapAt = stmts.findIndex((stmt) => stmt === "DROP TABLE constitution_fracoes");
  try {
    for (const stmt of stmts.slice(0, swapAt)) await client.execute(stmt);
  } catch (err) {
    await dropIncompleteRebuild(client);
    if (isGuardFailure(err)) throw copyMismatchError(err);
    throw err;
  }
  for (const stmt of stmts.slice(swapAt)) await client.execute(stmt);
}

/**
 * Migration 0011, idempotente.
 * Reconstrói constitution_fracoes para permilagem NULL e permilagem_centesimas.
 * Copia todas as linhas numa única escrita (batch/transaction). Não preenche
 * centésimas a partir do inteiro antigo. Coluna desconhecida → erro, tabela
 * original intacta. Um rebuild com linhas e tabela viva vazia ou ausente
 * é promovido; nunca é apagado.
 */
export async function migrateConstitutionFracoesPermilagem(client: SqlExecutor): Promise<void> {
  const hasLive = await tableExists(client, "constitution_fracoes");
  const hasRebuild = await tableExists(client, REBUILD_TABLE);
  const rebuildRows = hasRebuild ? await scalarCount(client, REBUILD_TABLE) : 0;
  const liveRows = hasLive ? await scalarCount(client, "constitution_fracoes") : 0;

  if (hasRebuild && rebuildRows > 0 && liveRows === 0) {
    await promoteRebuild(client, hasLive);
    return;
  }
  if (!hasLive) return;

  const columns = await constitutionColumns(client);
  if (isTargetShape(columns)) {
    if (hasRebuild) await client.execute(`DROP TABLE ${REBUILD_TABLE}`);
    await recreateConstitutionIndexes(client);
    return;
  }

  const unknown = columns
    .map((column) => column.name)
    .filter((name) => name !== "permilagem_centesimas" && !PRE_0011_COLUMNS.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Migração 0011 interrompida: constitution_fracoes tem colunas não previstas (${unknown.join(", ")}). Nada foi apagado.`,
    );
  }

  await rebuildFromLive(
    client,
    columns.some((column) => column.name === "permilagem_centesimas"),
  );
}

/** F1 — Ingestão + Constituição (após Domain Kernel F0). */
export async function applyF1ConstitutionSchema(client: SqlExecutor): Promise<void> {
  const constitutionStart = DDL.findIndex((stmt) =>
    stmt.includes("CREATE TABLE IF NOT EXISTS constitution_fracoes"),
  );
  for (const stmt of DDL.slice(0, constitutionStart)) {
    await execSafe(client, stmt);
  }
  await migrateConstitutionFracoesPermilagem(client);
  for (const stmt of DDL.slice(constitutionStart)) {
    await execSafe(client, stmt);
  }
}
