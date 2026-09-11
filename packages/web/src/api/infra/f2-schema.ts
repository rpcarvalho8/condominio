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
  `CREATE TABLE IF NOT EXISTS settlement_policies (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    code TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',
    rules_json TEXT NOT NULL,
    legal_basis_json TEXT,
    effective_from INTEGER NOT NULL,
    superseded_by TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS settlement_policies_tenant_code_version_uq
    ON settlement_policies (tenant_id, code, version)`,
  `CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    fracao_id TEXT,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    received_at INTEGER NOT NULL,
    payer_reference TEXT,
    payment_method TEXT NOT NULL,
    allocation_status TEXT NOT NULL DEFAULT 'nao_alocado_pendente',
    cash_status TEXT,
    verification_method TEXT,
    registered_by_person_id TEXT,
    verified_by_person_id TEXT,
    evidence_upload_id TEXT,
    bank_movement_id TEXT,
    deposited_at INTEGER,
    candidate_source TEXT,
    candidate_confidence REAL,
    external_ref TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS payments_tenant_status_idx
    ON payments (tenant_id, allocation_status)`,
  `CREATE INDEX IF NOT EXISTS payments_tenant_fracao_idx
    ON payments (tenant_id, fracao_id)`,
  `CREATE INDEX IF NOT EXISTS payments_tenant_cash_idx
    ON payments (tenant_id, cash_status)`,
  `CREATE TABLE IF NOT EXISTS allocations (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    payment_id TEXT NOT NULL REFERENCES payments(id),
    obligation_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    policy_id TEXT,
    confidence REAL,
    approved_by_person_id TEXT,
    ledger_entry_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS allocations_payment_idx ON allocations (payment_id)`,
  `CREATE INDEX IF NOT EXISTS allocations_obligation_idx ON allocations (obligation_id)`,
  `CREATE INDEX IF NOT EXISTS allocations_tenant_idx ON allocations (tenant_id)`,
  `CREATE TABLE IF NOT EXISTS ledger_entries (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    entry_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    previous_hash TEXT NOT NULL,
    entry_hash TEXT NOT NULL,
    algorithm_version TEXT NOT NULL DEFAULT 'sha256-v1',
    allocation_id TEXT,
    payment_id TEXT,
    obligation_id TEXT,
    amount_cents INTEGER,
    direction TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_tenant_sequence_uq
    ON ledger_entries (tenant_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS ledger_entries_tenant_created_idx
    ON ledger_entries (tenant_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_hash_uq
    ON ledger_entries (tenant_id, entry_hash)`,
  `CREATE TABLE IF NOT EXISTS accounting_periods (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    closed_at INTEGER,
    closed_by_person_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS accounting_periods_tenant_ym_uq
    ON accounting_periods (tenant_id, year, month)`,
  `CREATE TABLE IF NOT EXISTS financial_documents (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    fracao_id TEXT,
    doc_type TEXT NOT NULL,
    period_label TEXT,
    issued_at INTEGER NOT NULL,
    due_at INTEGER,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'issued',
    document_number TEXT,
    generated_from_json TEXT NOT NULL,
    source_payment_id TEXT,
    pdf_url TEXT,
    sent_at INTEGER,
    delivery_status TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS financial_documents_tenant_type_idx
    ON financial_documents (tenant_id, doc_type)`,
  `CREATE INDEX IF NOT EXISTS financial_documents_fracao_idx
    ON financial_documents (fracao_id)`,
  `CREATE TABLE IF NOT EXISTS condo_bank_connections (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'enable_banking',
    aspsp TEXT,
    account_iban TEXT,
    consent_status TEXT NOT NULL DEFAULT 'pending',
    consent_valid_until INTEGER,
    reauthorization_required INTEGER NOT NULL DEFAULT 0,
    authorized_by_membership_id TEXT,
    last_sync_at INTEGER,
    last_error TEXT,
    last_reauth_notice_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS condo_bank_connections_tenant_idx
    ON condo_bank_connections (tenant_id)`,
  `CREATE TABLE IF NOT EXISTS tenant_ledger_integrity (
    tenant_id TEXT PRIMARY KEY NOT NULL,
    chain_integrity TEXT NOT NULL DEFAULT 'ok',
    last_validated_at INTEGER,
    last_break_sequence INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS f2_bank_movements (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    booked_at INTEGER NOT NULL,
    description TEXT,
    external_ref TEXT,
    counterparty_iban TEXT,
    status TEXT NOT NULL DEFAULT 'reconciled',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS f2_bank_movements_tenant_idx
    ON f2_bank_movements (tenant_id)`,
  `ALTER TABLE financial_documents ADD COLUMN source_payment_id TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS financial_documents_receipt_payment_uq
    ON financial_documents (tenant_id, source_payment_id)
    WHERE doc_type = 'Receipt' AND source_payment_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS payments_tenant_bank_movement_uq
    ON payments (tenant_id, bank_movement_id)
    WHERE bank_movement_id IS NOT NULL`,
  `ALTER TABLE payments ADD COLUMN candidate_source TEXT`,
  `ALTER TABLE payments ADD COLUMN candidate_confidence REAL`,
  `ALTER TABLE payments ADD COLUMN external_ref TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS payments_tenant_external_ref_uq
    ON payments (tenant_id, external_ref)
    WHERE external_ref IS NOT NULL`,
  `ALTER TABLE condo_bank_connections ADD COLUMN aspsp TEXT`,
  `ALTER TABLE condo_bank_connections ADD COLUMN account_iban TEXT`,
  `ALTER TABLE condo_bank_connections ADD COLUMN consent_valid_until INTEGER`,
  `ALTER TABLE condo_bank_connections ADD COLUMN reauthorization_required INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE condo_bank_connections ADD COLUMN authorized_by_membership_id TEXT`,
  `ALTER TABLE condo_bank_connections ADD COLUMN last_reauth_notice_at INTEGER`,
  `ALTER TABLE condo_bank_connections ADD COLUMN revoked_at INTEGER`,
  `ALTER TABLE f2_bank_movements ADD COLUMN counterparty_iban TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS f2_bank_movements_tenant_ext_uq
    ON f2_bank_movements (tenant_id, external_ref)
    WHERE external_ref IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS financial_documents_notice_period_uq
    ON financial_documents (tenant_id, fracao_id, period_label)
    WHERE doc_type = 'PaymentNotice' AND fracao_id IS NOT NULL AND period_label IS NOT NULL`,
];

async function execSafe(client: SqlExecutor, stmt: string): Promise<void> {
  try {
    await client.execute(stmt);
  } catch (e) {
    if (alreadyExists(e)) return;
    throw e;
  }
}

/** F2 — Financeiro / Ledger (após F0+F1). */
export async function applyF2FinanceSchema(client: SqlExecutor): Promise<void> {
  for (const stmt of DDL) {
    await execSafe(client, stmt);
  }
}
