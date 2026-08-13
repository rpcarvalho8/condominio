/**
 * Cria a tabela pagador_perfis se ainda não existir (idempotente).
 * Uso: bun --env-file=../../.env run scripts/ensure-pagador-perfis.ts
 */
import { createClient } from "@libsql/client";

const client = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

const DDL = `
CREATE TABLE IF NOT EXISTS pagador_perfis (
  id TEXT PRIMARY KEY NOT NULL,
  iban TEXT,
  nome_normalizado TEXT,
  valor REAL NOT NULL,
  fracao_id TEXT NOT NULL REFERENCES fracoes(id),
  fracao_numero TEXT NOT NULL,
  rubrica TEXT NOT NULL DEFAULT 'condominio',
  confirmacoes INTEGER NOT NULL DEFAULT 1,
  fonte TEXT NOT NULL DEFAULT 'manual',
  ativo INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

async function main() {
  await client.execute(DDL);
  const r = await client.execute(
    "SELECT COUNT(*) as n FROM pagador_perfis",
  );
  const n = Number((r.rows[0] as { n: number }).n ?? 0);
  console.log(`✅ Tabela pagador_perfis pronta (perfis activos/total: ${n})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
