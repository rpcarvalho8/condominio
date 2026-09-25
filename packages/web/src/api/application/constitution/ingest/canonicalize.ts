/**
 * Canonicalization — leva observações ao modelo CondominiumUnit.
 * Normaliza unidade só quando o contexto do documento o justifica.
 */
import {
  centesimasFromQuotaToken,
  legacyIntegerPermilagem,
} from "../../../domain/permilagem-centesimas";
import type { CanonicalOrigin, CanonicalWarning, FieldEvidence } from "./contracts";
import { fieldEvidenceFromObservation, toDocumentObservation } from "./profiles/unit-share";
import type { Observation } from "./semantic-extraction";

export type DraftUnit = {
  codigo: string;
  designacaoOriginal: string;
  /** ‰ inteiro exacto, ou null quando há centésimos. Não é o valor canónico. */
  permilagem: number | null;
  /** Centésimas de ‰. Null quando o token tem mais de 2 casas no ‰ ou não é legível. */
  permilagemCentesimas: number | null;
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
  return fieldEvidenceFromObservation({
    field: input.field,
    documentId: input.documentId,
    documentName: input.documentName,
    observation: toDocumentObservation(input.observation, input.region, input.originalText),
    transform: input.transform,
  });
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
    let permilagemCentesimas: number | null = null;
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

    const token = observation.valueRaw ?? "";
    if (observation.valueNumber == null || !token.trim()) {
      warnings.push({
        code: "missing_quota",
        message: "Unidade aparente sem valor de quota.",
      });
    } else if (observation.unitCue === "permille" || (observation.unitCue === "percent" && percentJustified)) {
      const unit = observation.unitCue === "percent" ? "percent" : "permille";
      const parsed = centesimasFromQuotaToken(token, unit);
      if (!parsed.ok && parsed.reason === "too_many_decimals") {
        warnings.push({
          code: "excess_decimal_places",
          message:
            "O valor em ‰ tem mais de 2 casas decimais. A linha não é confirmável e a centésima fica vazia.",
        });
      } else if (!parsed.ok || parsed.centesimas <= 0) {
        warnings.push({
          code: "missing_quota",
          message: "O valor de quota não é um número exacto utilizável.",
        });
      } else {
        permilagemCentesimas = parsed.centesimas;
        permilagem = legacyIntegerPermilagem(parsed.centesimas);
        transform = unit === "percent" ? "percent_to_permille:*10" : "identity_permille";
      }
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
      permilagemCentesimas,
      origem: input.origem,
      evidence: fields,
      warnings,
    };
  });
}
