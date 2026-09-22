/**
 * Perfil unit_share — frações e permilagem (ADR-043, ADR-044).
 * É o único perfil que o pipeline executa. A forma dos objectos canónicos não muda.
 */
import type { UnitCue } from "../roles";
import type {
  CanonicalOrigin,
  CanonicalWarning,
  DocumentObservation,
  FieldEvidence,
  ReviewState,
  SystemCheck,
} from "../shared";
import { INGEST_PROFILE_IDS } from "../shared";

export const UNIT_SHARE_PROFILE_ID = INGEST_PROFILE_IDS.unitShare;

export type EvidenceField = "codigo" | "designacao_original" | "permilagem";

/** Observação do perfil. Ainda não é permilagem canónica nem Fracao. */
export type UnitShareObservation = {
  codigo: string | null;
  ambiguousIdentifier: boolean;
  designation: string;
  valueRaw: string | null;
  valueNumber: number | null;
  unitCue: UnitCue;
  page: number | null;
  line: number;
  cell: string | null;
  rowText: string;
};

export function toDocumentObservation(
  observation: UnitShareObservation,
  region: string | null,
  originalText: string,
): DocumentObservation {
  return {
    page: observation.page,
    line: observation.line,
    cell: observation.cell,
    region,
    originalText,
  };
}

export function fieldEvidenceFromObservation(input: {
  field: EvidenceField;
  documentId: string | null;
  documentName: string;
  observation: DocumentObservation;
  transform: string | null;
}): FieldEvidence<EvidenceField> {
  return {
    field: input.field,
    documentId: input.documentId,
    documentName: input.documentName,
    page: input.observation.page,
    line: input.observation.line,
    cell: input.observation.cell,
    region: input.observation.region,
    originalText: input.observation.originalText,
    transform: input.transform,
  };
}

export type CanonicalUnit = {
  codigo: string;
  designacaoOriginal: string;
  permilagem: number | null;
  origem: CanonicalOrigin;
  evidence: Array<FieldEvidence<EvidenceField>>;
  confidence: {
    score: number;
    source: "system_checks";
    checks: SystemCheck[];
  };
  warnings: CanonicalWarning[];
  review: ReviewState;
};
