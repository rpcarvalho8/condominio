/**
 * Contratos partilhados do pipeline F1 (ADR-043, ADR-044).
 * Não são entidades de domínio. Não escrevem Fracao, AnnualBudget nem Obligation.
 * O perfil (unit_share hoje; budget_plan só em contrato) decide o que a observação significa.
 */

export const INGEST_PROFILE_IDS = {
  unitShare: "unit_share",
  budgetPlan: "budget_plan",
} as const;

export type IngestProfileId = (typeof INGEST_PROFILE_IDS)[keyof typeof INGEST_PROFILE_IDS];

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

/**
 * Localização no documento e texto tal como foi lido.
 * Interpretação e valor canónico vêm depois, no perfil — não neste registo.
 */
export type DocumentObservation = {
  page: number | null;
  line: number | null;
  cell: string | null;
  region: string | null;
  originalText: string;
};

export type FieldEvidence<TField extends string = string> = {
  field: TField;
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

/** Representação descoberta. Não é o nome de um perfil nem de um regex. */
export type CanonicalOrigin = "table" | "key_value" | "prose";

export type PipelineBlocking = {
  code: string;
  message: string;
};

/** Hipótese de LLM. Nunca é autoridade sobre valores críticos nem sobre confiança. */
export type LlmHypothesis = {
  authoritative: false;
  note: string;
  raw: unknown;
};

export type IngestPipelineSummary = {
  profile: IngestProfileId;
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
