-- Migration 0007: F2 critério — BankConnection reauth, candidates, jobs.
-- Aplicar via applyF2FinanceSchema / migrate-all-tenants.
-- Não substitui Fonte Quota.pago nem Enable Banking PSD2.

ALTER TABLE payments ADD COLUMN candidate_source TEXT;
ALTER TABLE payments ADD COLUMN candidate_confidence REAL;
ALTER TABLE payments ADD COLUMN external_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS payments_tenant_external_ref_uq
  ON payments (tenant_id, external_ref)
  WHERE external_ref IS NOT NULL;

ALTER TABLE condo_bank_connections ADD COLUMN aspsp TEXT;
ALTER TABLE condo_bank_connections ADD COLUMN account_iban TEXT;
ALTER TABLE condo_bank_connections ADD COLUMN consent_valid_until INTEGER;
ALTER TABLE condo_bank_connections ADD COLUMN reauthorization_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE condo_bank_connections ADD COLUMN authorized_by_membership_id TEXT;
ALTER TABLE condo_bank_connections ADD COLUMN last_reauth_notice_at INTEGER;
ALTER TABLE condo_bank_connections ADD COLUMN revoked_at INTEGER;

ALTER TABLE f2_bank_movements ADD COLUMN counterparty_iban TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS f2_bank_movements_tenant_ext_uq
  ON f2_bank_movements (tenant_id, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS financial_documents_notice_period_uq
  ON financial_documents (tenant_id, fracao_id, period_label)
  WHERE doc_type = 'PaymentNotice' AND fracao_id IS NOT NULL AND period_label IS NOT NULL;
