/**
 * Migration 0011: rebuild de constitution_fracoes sem perder linhas.
 * O inteiro antigo mantém-se; centésimas ficam NULL (não se reconstrói o decimal).
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import {
  applyF1ConstitutionSchema,
  migrateConstitutionFracoesPermilagem,
} from "./f1-schema";

const OLD_TABLE = `CREATE TABLE constitution_fracoes (
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
)`;

async function rows(client: ReturnType<typeof createClient>) {
  const result = await client.execute(
    "SELECT id, codigo, permilagem, permilagem_centesimas FROM constitution_fracoes ORDER BY id",
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    codigo: String(row.codigo),
    permilagem: row.permilagem == null ? null : Number(row.permilagem),
    permilagem_centesimas:
      row.permilagem_centesimas == null ? null : Number(row.permilagem_centesimas),
  }));
}

describe("migration 0011 permilagem_centesimas", () => {
  test("rebuild copia as linhas e é idempotente", async () => {
    const client = createClient({ url: ":memory:" });
    await client.execute(OLD_TABLE);
    await client.execute(
      `INSERT INTO constitution_fracoes
        (id, tenant_id, codigo, tipo, permilagem, source_excerpt, status, created_at, confirmed_at)
       VALUES
        ('id-m', 'tenant', 'M', 'fracao', 40, '39,50', 'confirmed', 10, 10),
        ('id-e', 'tenant', 'E', 'fracao', 3, '3,00', 'confirmed', 11, 11)`,
    );

    await applyF1ConstitutionSchema(client);
    const after = await rows(client);
    expect(after).toEqual([
      { id: "id-e", codigo: "E", permilagem: 3, permilagem_centesimas: null },
      { id: "id-m", codigo: "M", permilagem: 40, permilagem_centesimas: null },
    ]);

    await applyF1ConstitutionSchema(client);
    expect(await rows(client)).toEqual(after);

    const info = await client.execute("PRAGMA table_info(constitution_fracoes)");
    const perm = info.rows.find((row) => row.name === "permilagem");
    const cent = info.rows.find((row) => row.name === "permilagem_centesimas");
    expect(Number(perm?.notnull)).toBe(0);
    expect(cent).toBeTruthy();
    const leftover = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'constitution_fracoes__centesimas_rebuild'",
    );
    expect(leftover.rows).toHaveLength(0);
    client.close();
  });

  test("coluna desconhecida interrompe sem apagar dados", async () => {
    const client = createClient({ url: ":memory:" });
    await client.execute(OLD_TABLE);
    await client.execute("ALTER TABLE constitution_fracoes ADD COLUMN nota_extra TEXT");
    await client.execute(
      `INSERT INTO constitution_fracoes
        (id, tenant_id, codigo, permilagem, created_at, confirmed_at, nota_extra)
       VALUES ('id-1', 'tenant', 'A', 600, 1, 1, 'manter')`,
    );

    await expect(migrateConstitutionFracoesPermilagem(client)).rejects.toThrow(/nota_extra/);
    const left = await client.execute("SELECT id, permilagem, nota_extra FROM constitution_fracoes");
    expect(left.rows).toHaveLength(1);
    expect(Number(left.rows[0]?.permilagem)).toBe(600);
    expect(String(left.rows[0]?.nota_extra)).toBe("manter");
    client.close();
  });

  const REBUILD = `CREATE TABLE constitution_fracoes__centesimas_rebuild (
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

  test("crash entre DROP e RENAME: reaplicar preserva as linhas", async () => {
    const client = createClient({ url: ":memory:" });
    await client.execute(REBUILD);
    await client.execute(
      `INSERT INTO constitution_fracoes__centesimas_rebuild
        (id, tenant_id, codigo, tipo, permilagem, permilagem_centesimas, source_excerpt, status, created_at, confirmed_at)
       VALUES
        ('id-m', 'tenant', 'M', 'fracao', 40, NULL, '39,50', 'confirmed', 10, 10),
        ('id-e', 'tenant', 'E', 'fracao', 3, NULL, '3,00', 'confirmed', 11, 11)`,
    );

    await applyF1ConstitutionSchema(client);
    const after = await rows(client);
    expect(after).toEqual([
      { id: "id-e", codigo: "E", permilagem: 3, permilagem_centesimas: null },
      { id: "id-m", codigo: "M", permilagem: 40, permilagem_centesimas: null },
    ]);
    const leftover = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'constitution_fracoes__centesimas_rebuild'",
    );
    expect(leftover.rows).toHaveLength(0);

    await applyF1ConstitutionSchema(client);
    expect(await rows(client)).toEqual(after);
    client.close();
  });

  test("tabela viva vazia não apaga o rebuild que ainda tem as linhas", async () => {
    const client = createClient({ url: ":memory:" });
    await client.execute(`CREATE TABLE constitution_fracoes (
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
    )`);
    await client.execute(REBUILD);
    await client.execute(
      `INSERT INTO constitution_fracoes__centesimas_rebuild
        (id, tenant_id, codigo, tipo, permilagem, source_excerpt, status, created_at, confirmed_at)
       VALUES ('id-1', 'tenant', 'A', 'fracao', 600, '600', 'confirmed', 1, 1)`,
    );

    await applyF1ConstitutionSchema(client);
    expect(await rows(client)).toEqual([
      { id: "id-1", codigo: "A", permilagem: 600, permilagem_centesimas: null },
    ]);
    client.close();
  });

  test("falha durante INSERT deixa a tabela original intacta", async () => {
    const client = createClient({ url: ":memory:" });
    await client.execute(OLD_TABLE);
    await client.execute(
      `INSERT INTO constitution_fracoes
        (id, tenant_id, codigo, permilagem, created_at, confirmed_at)
       VALUES ('id-1', 'tenant', 'A', 600, 1, 1)`,
    );

    const flaky = {
      execute: (sql: string) => client.execute(sql),
      batch: (stmts: string[], mode?: "write" | "read" | "deferred") => {
        const broken = stmts.map((stmt) =>
          stmt.includes("INSERT INTO constitution_fracoes__centesimas_rebuild")
            ? stmt.replace("FROM constitution_fracoes", "FROM constitution_fracoes__missing")
            : stmt,
        );
        return client.batch(broken, mode);
      },
    };

    await expect(migrateConstitutionFracoesPermilagem(flaky)).rejects.toThrow();
    const left = await client.execute("SELECT id, permilagem FROM constitution_fracoes");
    expect(left.rows).toHaveLength(1);
    expect(Number(left.rows[0]?.permilagem)).toBe(600);
    const rebuild = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'constitution_fracoes__centesimas_rebuild'",
    );
    expect(rebuild.rows).toHaveLength(0);
    client.close();
  });
});
