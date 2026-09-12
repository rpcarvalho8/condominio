-- Migration 0008: F2 Enable Banking PSD2 — sessão ASPSP na conta do condomínio.
-- Aplicar via applyF2FinanceSchema / migrate-all-tenants.
-- Não dual-write Fonte Quota.pago / bank_transactions.

ALTER TABLE condo_bank_connections ADD COLUMN session_id TEXT;
ALTER TABLE condo_bank_connections ADD COLUMN account_uid TEXT;
ALTER TABLE condo_bank_connections ADD COLUMN consent_scopes TEXT;
ALTER TABLE condo_bank_connections ADD COLUMN accounts_json TEXT;
ALTER TABLE condo_bank_connections ADD COLUMN auth_state TEXT;
