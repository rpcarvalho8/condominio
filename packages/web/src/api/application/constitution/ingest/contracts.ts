/**
 * Fachada dos contratos F1.
 * Tipos partilhados: ./shared. Perfil em execução: ./profiles/unit-share.
 * budget_plan não é reexportado daqui — não faz parte do pipeline ligado.
 */
import type { FieldEvidence as SharedFieldEvidence, IngestPipelineSummary } from "./shared";
import type { CanonicalUnit, EvidenceField } from "./profiles/unit-share";

export type {
  CanonicalOrigin,
  CanonicalWarning,
  DocumentObservation,
  IngestPipelineSummary,
  IngestProfileId,
  LlmHypothesis,
  PipelineBlocking,
  ReviewState,
  SystemCheck,
} from "./shared";
export { INGEST_PROFILE_IDS, INGEST_STAGES, REVIEW_STATE } from "./shared";

export type { CanonicalUnit, EvidenceField, UnitShareObservation } from "./profiles/unit-share";
export { UNIT_SHARE_PROFILE_ID } from "./profiles/unit-share";

/** Evidência do perfil unit_share. O genérico partilhado está em ./shared. */
export type FieldEvidence = SharedFieldEvidence<EvidenceField>;

export type IngestPipelineResult = {
  units: CanonicalUnit[];
  summary: IngestPipelineSummary;
};
