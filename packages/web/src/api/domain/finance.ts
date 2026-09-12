/**
 * F2 — Financeiro / Ledger (docs/lumen/06-FATIAS.md, ADR-003, ADR-028, ADR-029).
 *
 * Obligation ≠ Payment ≠ Allocation ≠ Ledger.
 * Hash-chain = deteção de adulteração (não blockchain).
 */

export const PAYMENT_METHODS = {
  bankTransfer: "bank_transfer",
  directDebit: "direct_debit",
  cheque: "cheque",
  cash: "cash",
  other: "other",
} as const;

export const ALLOCATION_STATUS = {
  identificado: "identificado",
  parcialmenteAlocado: "parcialmente_alocado",
  totalmenteAlocado: "totalmente_alocado",
  naoAlocadoPendente: "nao_alocado_pendente",
} as const;

export const CASH_STATUS = {
  registered: "registered",
  verified: "verified",
  deposited: "deposited",
} as const;

export const VERIFICATION_METHOD = {
  secondPerson: "second_person",
  bankDeposit: "bank_deposit",
} as const;

/** Movimento bancário do kernel F2 (tenant-scoped) — não substitui Fonte bank_transactions. */
export const BANK_MOVEMENT_STATUS = {
  booked: "booked",
  reconciled: "reconciled",
} as const;

export const LEDGER_ENTRY_TYPES = {
  genesis: "genesis",
  allocation: "allocation",
  adjustment: "adjustment",
} as const;

export const LEDGER_ALGORITHM_VERSION = "sha256-v1";
export const LEDGER_GENESIS_PREVIOUS_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

export const CHAIN_INTEGRITY = {
  ok: "ok",
  broken: "broken",
} as const;

export const FINANCIAL_DOC_TYPES = {
  paymentNotice: "PaymentNotice",
  receipt: "Receipt",
  accountStatement: "AccountStatement",
} as const;

/** Ciclo de vida BankConnection (ADR-014) — conta do condomínio, não do admin. */
export const BANK_CONSENT_STATUS = {
  pending: "pending",
  authorized: "authorized",
  expired: "expired",
  revoked: "revoked",
  reauthorizationRequired: "reauthorization_required",
} as const;

/** Aviso proactivo: consentimento a expirar dentro deste prazo. Coexiste com reauth PSD2 real. */
export const BANK_REAUTH_LEAD_DAYS = 14;

/** Duração pedida ao ASPSP no consentimento (Enable Banking / PSD2). */
export const BANK_CONSENT_DAYS = 90;

/** Janela máxima por pedido e lookback típicos Enable Banking (Santander PT). */
export const BANK_SYNC_MAX_LOOKBACK_DAYS = 89;
export const BANK_SYNC_CHUNK_DAYS = 30;

/** Scopes de consentimento persistidos em BankConnection (não o JWT técnico). */
export const BANK_PSD2_SCOPES = {
  accounts: "accounts",
  balances: "balances",
  transactions: "transactions",
} as const;

export const DEFAULT_BANK_PSD2_SCOPES = [
  BANK_PSD2_SCOPES.accounts,
  BANK_PSD2_SCOPES.transactions,
] as const;

export const CANDIDATE_SOURCES = {
  csv: "csv",
  reconciliation: "reconciliation",
  identityMatrix: "identity_matrix",
  manual: "manual",
  enableBanking: "enable_banking",
} as const;

export type BankConsentStatus = (typeof BANK_CONSENT_STATUS)[keyof typeof BANK_CONSENT_STATUS];
export type CandidateSource = (typeof CANDIDATE_SOURCES)[keyof typeof CANDIDATE_SOURCES];

/** Ordem default de imputação (SettlementPolicy seed). */
export const DEFAULT_SETTLEMENT_ORDER = [
  "divida_antiga",
  "fcr",
  "quota_corrente",
  "extraordinaria",
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[keyof typeof PAYMENT_METHODS];
export type AllocationStatus = (typeof ALLOCATION_STATUS)[keyof typeof ALLOCATION_STATUS];
export type CashStatus = (typeof CASH_STATUS)[keyof typeof CASH_STATUS];
