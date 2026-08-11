/**
 * Setup BD local SQLite para desenvolvimento
 * Cria tabelas + seed de dados reais + utilizador admin de teste
 * 
 * Uso: bun run scripts/setup-local-db.ts
 */

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { scrypt, randomBytes } from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(scrypt);

const DB_PATH = process.env.DATABASE_URL ?? "file:./local.db";

const client = createClient({ url: DB_PATH });
const db = drizzle(client);

// ── Criar tabelas ──────────────────────────────────────────────────────────────
async function createTables() {
  console.log("📦 A criar tabelas...");

  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS "user" (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      role TEXT NOT NULL DEFAULT 'condómino',
      fracao_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "session" (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS "account" (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT,
      access_token_expires_at INTEGER,
      refresh_token_expires_at INTEGER,
      scope TEXT,
      password TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "verification" (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS "fracoes" (
      id TEXT PRIMARY KEY,
      numero TEXT NOT NULL,
      andar INTEGER,
      proprietario_nome TEXT,
      proprietario_email TEXT,
      proprietario_nif TEXT,
      proprietario_morada TEXT,
      proprietario_telefone TEXT,
      telegram_id TEXT,
      tipo TEXT NOT NULL DEFAULT 'apartamento',
      quota_mensal REAL NOT NULL DEFAULT 0,
      permilagem REAL,
      ativo INTEGER DEFAULT 1,
      notas TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "fornecedores" (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      categoria TEXT,
      nif TEXT,
      email TEXT,
      telefone TEXT,
      website TEXT,
      avaliacao REAL,
      ativo INTEGER DEFAULT 1,
      notas TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "despesas" (
      id TEXT PRIMARY KEY,
      descricao TEXT NOT NULL,
      categoria TEXT NOT NULL,
      subcategoria TEXT,
      valor REAL NOT NULL,
      data INTEGER NOT NULL,
      fornecedor_id TEXT REFERENCES fornecedores(id),
      fatura_url TEXT,
      recorrente INTEGER DEFAULT 0,
      notas TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "quotas" (
      id TEXT PRIMARY KEY,
      fracao_id TEXT NOT NULL REFERENCES fracoes(id),
      quota_tipo_id TEXT,
      tipo TEXT NOT NULL DEFAULT 'condominio',
      mes INTEGER NOT NULL,
      ano INTEGER NOT NULL,
      valor REAL NOT NULL,
      fundo_reserva REAL,
      pago INTEGER DEFAULT 0,
      data_pagamento INTEGER,
      metodo_pagamento TEXT,
      observacoes TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "recibos" (
      id TEXT PRIMARY KEY,
      numero TEXT NOT NULL UNIQUE,
      fracao_id TEXT NOT NULL REFERENCES fracoes(id),
      valor REAL NOT NULL,
      data INTEGER NOT NULL,
      descricao TEXT,
      pdf_url TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "documentos" (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      tipo TEXT,
      url TEXT NOT NULL,
      tamanho INTEGER,
      descricao TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "avisos" (
      id TEXT PRIMARY KEY,
      titulo TEXT NOT NULL,
      conteudo TEXT NOT NULL,
      tipo TEXT DEFAULT 'geral',
      destinatarios TEXT DEFAULT 'todos',
      enviado INTEGER DEFAULT 0,
      data_envio INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "quota_tipos" (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      descricao TEXT,
      valor_base REAL,
      ativo INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "bank_connections" (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'enable_banking',
      session_id TEXT,
      access_valid_for_days INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      status TEXT DEFAULT 'pending',
      iban TEXT,
      account_id TEXT,
      last_sync_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS "bank_transactions" (
      id TEXT PRIMARY KEY,
      connection_id TEXT REFERENCES bank_connections(id),
      transaction_id TEXT UNIQUE,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'EUR',
      date INTEGER NOT NULL,
      description TEXT,
      creditor_name TEXT,
      debtor_name TEXT,
      type TEXT,
      status TEXT DEFAULT 'pending',
      imported INTEGER DEFAULT 0,
      import_type TEXT,
      import_ref_id TEXT,
      raw_data TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  console.log("✅ Tabelas criadas");
}

// ── Seed dados ─────────────────────────────────────────────────────────────────
const FRACOES_SEED = [
  { numero: "J",  tipo: "apartamento", proprietarioNome: "Maria Santos",        permilagem: 38.80, quotaMensal: 39.68 },
  { numero: "L",  tipo: "apartamento", proprietarioNome: "João Silva",      permilagem: 41.76, quotaMensal: 42.71 },
  { numero: "M",  tipo: "apartamento", proprietarioNome: "Ana Costa",           permilagem: 39.50, quotaMensal: 40.40 },
  { numero: "N",  tipo: "apartamento", proprietarioNome: "Pedro Oliveira",          permilagem: 38.82, quotaMensal: 39.70 },
  { numero: "O",  tipo: "apartamento", proprietarioNome: "Carlos Ferreira",             permilagem: 41.76, quotaMensal: 42.71 },
  { numero: "P",  tipo: "apartamento", proprietarioNome: "Sofia Rodrigues",         permilagem: 43.30, quotaMensal: 44.28 },
  { numero: "Q",  tipo: "apartamento", proprietarioNome: "Miguel Almeida",           permilagem: 37.14, quotaMensal: 37.98 },
  { numero: "R",  tipo: "apartamento", proprietarioNome: "Beatriz Pereira",      permilagem: 56.75, quotaMensal: 58.04 },
  { numero: "S",  tipo: "apartamento", proprietarioNome: "Inês Carvalho",                  permilagem: 32.34, quotaMensal: 33.07 },
  { numero: "T",  tipo: "apartamento", proprietarioNome: "Tiago Martins",   permilagem: 38.50, quotaMensal: 39.37 },
  { numero: "U",  tipo: "apartamento", proprietarioNome: "Catarina Lopes",    permilagem: 57.21, quotaMensal: 58.51 },
  { numero: "V",  tipo: "apartamento", proprietarioNome: "Admin Demo",      permilagem: 34.05, quotaMensal: 34.82 },
  { numero: "X",  tipo: "apartamento", proprietarioNome: "Ricardo Nunes",            permilagem: 39.12, quotaMensal: 40.01 },
  { numero: "Z",  tipo: "apartamento", proprietarioNome: "Helena Dias",             permilagem: 55.15, quotaMensal: 56.40 },
  { numero: "AA", tipo: "apartamento", proprietarioNome: "Olivia Mendes",      permilagem: 35.06, quotaMensal: 35.86 },
  { numero: "AB", tipo: "apartamento", proprietarioNome: "António Rocha",     permilagem: 35.00, quotaMensal: 35.79 },
  { numero: "AE", tipo: "apartamento", proprietarioNome: "Germano A M Machado",               permilagem: 37.00, quotaMensal: 37.84 },
  { numero: "AF", tipo: "apartamento", proprietarioNome: "Luís Barbosa",        permilagem: 35.21, quotaMensal: 36.01 },
  { numero: "AG", tipo: "apartamento", proprietarioNome: "Rui Fernandes",            permilagem: 35.41, quotaMensal: 36.21 },
  { numero: "AH", tipo: "apartamento", proprietarioNome: "João Dias",       permilagem: 40.96, quotaMensal: 41.89 },
  { numero: "AI", tipo: "apartamento", proprietarioNome: "Madalena Ramos",                      permilagem: 35.85, quotaMensal: 36.66 },
  { numero: "AJ", tipo: "apartamento", proprietarioNome: "André Sousa",             permilagem: 34.57, quotaMensal: 35.35 },
  { numero: "G",  tipo: "loja",        proprietarioNome: "Mariana Reis",    permilagem: 22.96, quotaMensal: 23.49 },
  { numero: "H",  tipo: "loja",        proprietarioNome: "Loja Demo Lda",        permilagem: 16.96, quotaMensal: 9.08 },
  { numero: "I",  tipo: "loja",        proprietarioNome: "Loja Demo Lda",        permilagem: 22.00, quotaMensal: 11.51 },
  { numero: "AC", tipo: "loja",        proprietarioNome: "Paula Mendes",  permilagem: 18.10, quotaMensal: 9.47 },
  { numero: "AD", tipo: "loja",        proprietarioNome: "Fátima Gomes",     permilagem: 18.68, quotaMensal: 9.78 },
  { numero: "A",  tipo: "garagem",     proprietarioNome: "Universe Sustainable-SA",           permilagem: 2.89,  quotaMensal: 1.51 },
  { numero: "B",  tipo: "garagem",     proprietarioNome: "Germano A M Machado",               permilagem: 2.86,  quotaMensal: 1.50 },
  { numero: "C",  tipo: "garagem",     proprietarioNome: "Universe Sustainable-SA",           permilagem: 2.89,  quotaMensal: 1.51 },
  { numero: "D",  tipo: "garagem",     proprietarioNome: "Tiago Martins",  permilagem: 3.15,  quotaMensal: 1.65 },
  { numero: "E",  tipo: "garagem",     proprietarioNome: "Comércio Demo Lda",            permilagem: 3.00,  quotaMensal: 1.57 },
  { numero: "F",  tipo: "garagem",     proprietarioNome: "Comércio Demo Lda",            permilagem: 3.25,  quotaMensal: 1.70 },
];

async function seedFracoes() {
  const existing = await client.execute("SELECT COUNT(*) as count FROM fracoes");
  if ((existing.rows[0] as any).count > 0) {
    console.log("⏭️  Frações já existem, a saltar...");
    return;
  }
  console.log("🏠 A inserir frações...");
  const now = Date.now();
  for (const f of FRACOES_SEED) {
    await client.execute({
      sql: `INSERT INTO fracoes (id, numero, tipo, proprietario_nome, permilagem, quota_mensal, ativo, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      args: [crypto.randomUUID(), f.numero, f.tipo, f.proprietarioNome, f.permilagem, f.quotaMensal, now],
    });
  }
  console.log(`✅ ${FRACOES_SEED.length} frações inseridas`);
}

async function seedFornecedores() {
  const existing = await client.execute("SELECT COUNT(*) as count FROM fornecedores");
  if ((existing.rows[0] as any).count > 0) {
    console.log("⏭️  Fornecedores já existem, a saltar...");
    return;
  }
  console.log("🏢 A inserir fornecedores...");
  const FORNECEDORES = [
    { nome: "Indaqua Santo Tirso",        categoria: "agua",          avaliacao: 3.5 },
    { nome: "SU Eletricidade",            categoria: "eletricidade",  avaliacao: 3.8 },
    { nome: "Iberdrola",                  categoria: "eletricidade",  avaliacao: 3.7 },
    { nome: "Limpeza Urbaniz. Fonte",     categoria: "limpeza",       avaliacao: 4.0 },
    { nome: "Jardinagem",                 categoria: "jardim",        avaliacao: 4.0 },
    { nome: "Manutenção Elevadores",      categoria: "elevadores",    avaliacao: 3.8 },
    { nome: "Sergio Miguel Monteiro",     categoria: "administracao", avaliacao: 4.5 },
    { nome: "Madalena Ramos",               categoria: "administracao", avaliacao: 4.5 },
    { nome: "Catarina Reis Azevedo",      categoria: "administracao", avaliacao: 4.5 },
  ];
  const now = Date.now();
  for (const f of FORNECEDORES) {
    await client.execute({
      sql: `INSERT INTO fornecedores (id, nome, categoria, avaliacao, ativo, created_at) VALUES (?, ?, ?, ?, 1, ?)`,
      args: [crypto.randomUUID(), f.nome, f.categoria, f.avaliacao, now],
    });
  }
  console.log(`✅ ${FORNECEDORES.length} fornecedores inseridos`);
}

// ── Hash de password compatível com better-auth ────────────────────────────────
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

async function createAdminUser() {
  const existing = await client.execute("SELECT COUNT(*) as count FROM \"user\" WHERE email = 'admin@condominio.local'");
  if ((existing.rows[0] as any).count > 0) {
    console.log("⏭️  Utilizador admin já existe, a saltar...");
    return;
  }
  console.log("👤 A criar utilizador admin...");

  const now = Date.now();
  const userId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const hashedPw = await hashPassword("admin123");

  await client.execute({
    sql: `INSERT INTO "user" (id, name, email, email_verified, role, fracao_id, created_at, updated_at)
          VALUES (?, ?, ?, 1, 'admin', NULL, ?, ?)`,
    args: [userId, "Administrador", "admin@condominio.local", now, now],
  });

  await client.execute({
    sql: `INSERT INTO "account" (id, account_id, provider_id, user_id, password, created_at, updated_at)
          VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
    args: [accountId, userId, userId, hashedPw, now, now],
  });

  console.log("✅ Admin criado:");
  console.log("   Email:    admin@condominio.local");
  console.log("   Password: admin123");
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔧 Setup BD local: ${DB_PATH}\n`);
  await createTables();
  await seedFracoes();
  await seedFornecedores();
  await createAdminUser();
  console.log("\n🎉 BD pronta!\n");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
