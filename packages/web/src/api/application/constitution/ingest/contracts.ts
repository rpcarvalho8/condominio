/**
 * Contratos do pipeline F1 (ADR-043).
 * Extracção, interpretação, validação e confirmação são etapas distintas.
 * Nenhum destes tipos escreve Fracao nem Obligation.
 */

export const REVIEW_STATE = {
  pendingReview: "pending_review",
  needsHumanReview: "needs_human_review",
} as const;

export type ReviewState = (typeof REVIEW_STATE)[keyof typeof REVIEW_STATE];

export const INGEST_STAGES = [
  "intake",
  "structure_discovery",
  "semantic_extraction",
  "canonicalization",
  "deterministic_validation",
  "human_review",
] as const;

export type EvidenceField = "codigo" | "designacao_original" | "permilagem";

export type FieldEvidence = {
  field: EvidenceField;
  documentId: string | null;
  documentName: string;
  page: number | null;
  line: number | null;
  cell: string | null;
  region: string | null;
  originalText: string;
  transform: string | null;
};

export type SystemCheck = {
  id: string;
  passed: boolean;
  detail: string;
};

export type CanonicalWarning = {
  code: string;
  message: string;
};

export type CanonicalOrigin = "table" | "key_value" | "prose";

export type CanonicalUnit = {
  codigo: string;
  designacaoOriginal: string;
  permilagem: number | null;
  origem: CanonicalOrigin;
  evidence: FieldEvidence[];
  confidence: {
    score: number;
    source: "system_checks";
    checks: SystemCheck[];
  };
  warnings: CanonicalWarning[];
  review: ReviewState;
};

export type PipelineBlocking = {
  code: string;
  message: string;
};

/** Hipótese de LLM. Nunca é autoridade sobre permilagem nem sobre confiança. */
export type LlmHypothesis = {
  authoritative: false;
  note: string;
  raw: unknown;
};

export type IngestPipelineSummary = {
  representation: CanonicalOrigin | "unknown";
  informationPresent: string[];
  readyForConfirmation: number;
  needsHumanDecision: number;
  blocking: PipelineBlocking[];
  checks: SystemCheck[];
  llmUsed: boolean;
  llmHypothesis: LlmHypothesis | null;
  stages: readonly string[];
};

export type IngestPipelineResult = {
  units: CanonicalUnit[];
  summary: IngestPipelineSummary;
};
