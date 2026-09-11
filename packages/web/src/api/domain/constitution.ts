/**
 * F1 — Ingestão + Constituição (docs/lumen/06-FATIAS.md).
 *
 * Regras:
 * - Upload ≠ processamento definitivo
 * - Extração LLM/OCR é consultiva
 * - Nada definitivo sem confirmação linha a linha com excerto de origem
 * - Σ permilagens = 1000‰
 * - Obligations só a partir de orçamento aprovado (nunca algoritmo solto)
 */

export const INGEST_DOCUMENT_KINDS = {
  regulamento: "regulamento",
  contactos: "contactos",
  ibanProof: "iban_proof",
  orcamento: "orcamento",
} as const;

export type IngestDocumentKind =
  (typeof INGEST_DOCUMENT_KINDS)[keyof typeof INGEST_DOCUMENT_KINDS];

export const INGEST_DOCUMENT_STATUS = {
  uploaded: "uploaded",
  extracting: "extracting",
  pendingReview: "pending_review",
  partiallyConfirmed: "partially_confirmed",
  confirmed: "confirmed",
  failed: "failed",
} as const;

export const EXTRACT_LINE_STATUS = {
  pendingReview: "pending_review",
  confirmed: "confirmed",
  rejected: "rejected",
} as const;

export const EXTRACT_LINE_KINDS = {
  fracao: "fracao",
  contacto: "contacto",
  iban: "iban",
  budgetLine: "budget_line",
} as const;

export const BUDGET_LINE_KINDS = {
  quotaCorrente: "quota_corrente",
  fcr: "fcr",
  extraordinaria: "extraordinaria",
} as const;

export const OBLIGATION_STATUS = {
  open: "open",
  partial: "partial",
  paid: "paid",
  cancelled: "cancelled",
} as const;

export const RETENTION_CLASS = {
  legalInstrument: "legal_instrument",
  personalDocument: "personal_document",
} as const;

export const PERMILAGEM_TOTAL = 1000;

export type FracaoExtractPayload = {
  codigo: string;
  tipo?: string;
  permilagem: number;
};

export type ContactExtractPayload = {
  fracaoCodigo: string;
  personName: string;
  email?: string | null;
  phone?: string | null;
  nif?: string | null;
};

export type StructuredExtraction = {
  lines: Array<{
    kind: string;
    payload: Record<string, unknown>;
    sourceExcerpt: string;
    confidence?: number;
  }>;
};
