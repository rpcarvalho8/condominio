/**
 * Canonicalization — leva observações ao modelo CondominiumUnit.
 * Normaliza unidade só quando o contexto do documento o justifica.
 */
import type { CanonicalOrigin, CanonicalWarning, FieldEvidence } from "./contracts";
import type { Observation } from "./semantic-extraction";

export type DraftUnit = {
  codigo: string;
  designacaoOriginal: string;
  permilagem: number | null;
  origem: CanonicalOrigin;
  evidence: FieldEvidence[];
  warnings: CanonicalWarning[];
};

const PERCENT_SUM_TOLERANCE = 0.05;

function evidence(input: {
  field: FieldEvidence["field"];
  documentId: string | null;
  documentName: string;
  observation: Observation;
  originalText: string;
  transform: string | null;
  region: string | null;
}): FieldEvidence {
  return {
    field: input.field,
    documentId: input.documentId,
    documentName: input.documentName,
    page: input.observation.page,
    line: input.observation.line,
    cell: input.observation.cell,
    region: input.region,
    originalText: input.originalText,
    transform: input.transform,
  };
}

export function canonicalizeObservations(input: {
  observations: Observation[];
  origem: CanonicalOrigin;
  documentId: string | null;
  documentName: string;
  region: string | null;
}): DraftUnit[] {
  const valued = input.observations.filter((row) => row.valueNumber != null);
  const percentJustified =
    valued.length > 0 &&
    valued.every((row) => row.unitCue === "percent") &&
    valued.every((row) => row.valueNumber! > 0 && row.valueNumber! <= 100) &&
    Math.abs(valued.reduce((sum, row) => sum + row.valueNumber!, 0) - 100) <= PERCENT_SUM_TOLERANCE;
  const cueSet = new Set(valued.map((row) => row.unitCue));

  return input.observations.map((observation) => {
    const warnings: CanonicalWarning[] = [];
    let permilagem: number | null = null;
    let transform: string | null = null;

    if (observation.ambiguousIdentifier) {
      warnings.push({
        code: "ambiguous_identifier",
        message: "Há mais do que um identificador possível nesta linha.",
      });
    }
    if (!observation.codigo) {
      warnings.push({
        code: "missing_codigo",
        message: "Não foi possível identificar o código da unidade.",
      });
    }

    if (observation.valueNumber == null) {
      warnings.push({
        code: "missing_quota",
        message: "Unidade aparente sem valor de quota.",
      });
    } else if (observation.unitCue === "permille") {
      permilagem = Math.round(observation.valueNumber);
      transform = "identity_permille";
    } else if (observation.unitCue === "percent" && percentJustified) {
      permilagem = Math.round(observation.valueNumber * 10);
      transform = "percent_to_permille:*10";
    } else if (observation.unitCue === "percent") {
      warnings.push({
        code: cueSet.size > 1 ? "mixed_units" : "unit_context_inconsistent",
        message:
          cueSet.size > 1
            ? "O documento mistura ‰ e %. A percentagem não é convertida."
            : "A pista é percentagem, mas a soma não justifica converter para ‰.",
      });
    } else {
      warnings.push({
        code: "ambiguous_unit",
        message: "A unidade do valor não está identificada. Não se assume ‰.",
      });
    }

    const fields: FieldEvidence[] = [
      evidence({
        field: "codigo",
        documentId: input.documentId,
        documentName: input.documentName,
        observation,
        originalText: observation.codigo ?? observation.rowText,
        transform: null,
        region: input.region,
      }),
      evidence({
        field: "designacao_original",
        documentId: input.documentId,
        documentName: input.documentName,
        observation,
        originalText: observation.designation,
        transform: null,
        region: input.region,
      }),
      evidence({
        field: "permilagem",
        documentId: input.documentId,
        documentName: input.documentName,
        observation,
        originalText: observation.valueRaw ?? observation.rowText,
        transform,
        region: input.region,
      }),
    ];

    return {
      codigo: observation.codigo ?? "",
      designacaoOriginal: observation.designation,
      permilagem,
      origem: input.origem,
      evidence: fields,
      warnings,
    };
  });
}
