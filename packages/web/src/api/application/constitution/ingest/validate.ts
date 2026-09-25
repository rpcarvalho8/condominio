/**
 * Validação determinística. A confiança sai destes checks, nunca de um score de LLM.
 * Não confirma linhas.
 */
import { PERMILAGEM_CENTESIMAS_TOTAL } from "../../../domain/permilagem-centesimas";
import {
  INGEST_STAGES,
  REVIEW_STATE,
  UNIT_SHARE_PROFILE_ID,
  type CanonicalUnit,
  type IngestPipelineSummary,
  type LlmHypothesis,
  type SystemCheck,
} from "./contracts";
import type { DraftUnit } from "./canonicalize";

function scoreOf(checks: SystemCheck[]): number {
  if (checks.length === 0) return 0;
  const passed = checks.filter((check) => check.passed).length;
  return Math.round((passed / checks.length) * 100) / 100;
}

export function validateDrafts(input: {
  drafts: DraftUnit[];
  representation: IngestPipelineSummary["representation"];
  informationPresent: string[];
  llmHypothesis: LlmHypothesis | null;
}): { units: CanonicalUnit[]; summary: IngestPipelineSummary } {
  const counts = new Map<string, number>();
  for (const draft of input.drafts) {
    const key = draft.codigo.trim().toUpperCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const units: CanonicalUnit[] = input.drafts.map((draft) => {
    const key = draft.codigo.trim().toUpperCase();
    const duplicate = Boolean(key) && (counts.get(key) ?? 0) > 1;
    const warnings = [...draft.warnings];
    if (duplicate) {
      warnings.push({
        code: "duplicate_codigo",
        message: "Código repetido no documento.",
      });
    }
    const quotaIdentified = draft.permilagemCentesimas != null;
    const checks: SystemCheck[] = [
      {
        id: "codigo_present",
        passed: draft.codigo.trim().length > 0,
        detail: draft.codigo ? `código ${draft.codigo}` : "sem código",
      },
      {
        id: "semantic_quota_identified",
        passed: quotaIdentified,
        detail: quotaIdentified ? "quota identificada com pista de unidade" : "quota sem identificação semântica",
      },
      {
        id: "unit_context_justifies",
        passed: quotaIdentified,
        detail: quotaIdentified
          ? `transform ${draft.evidence.find((item) => item.field === "permilagem")?.transform ?? "none"}`
          : "normalização não justificada",
      },
      {
        id: "codigo_unique",
        passed: !duplicate && draft.codigo.trim().length > 0,
        detail: duplicate ? "código repetido" : "código único",
      },
    ];
    const needsHuman = warnings.length > 0 || !quotaIdentified || duplicate || !draft.codigo.trim();
    return {
      ...draft,
      warnings,
      review: needsHuman ? REVIEW_STATE.needsHumanReview : REVIEW_STATE.pendingReview,
      confidence: {
        score: scoreOf(checks),
        source: "system_checks",
        checks,
      },
    };
  });

  const withValue = units.filter((unit) => unit.permilagemCentesimas != null);
  const blocking: IngestPipelineSummary["blocking"] = [];
  const humanLines = units.filter((unit) => unit.review === REVIEW_STATE.needsHumanReview).length;
  if (humanLines > 0) {
    blocking.push({
      code: "needs_human_review",
      message: `${humanLines} linha(s) precisam de decisão humana.`,
    });
  }
  const documentChecks: SystemCheck[] = [];
  if (units.length === 0) {
    documentChecks.push({
      id: "coverage_complete",
      passed: false,
      detail: "nenhuma unidade encontrada",
    });
  } else if (withValue.length !== units.length) {
    documentChecks.push({
      id: "coverage_complete",
      passed: false,
      detail: `${withValue.length} de ${units.length} unidades aparentes têm permilagem`,
    });
    blocking.push({
      code: "coverage_incomplete",
      message: `${withValue.length} de ${units.length} unidades aparentes têm permilagem. As restantes não são importadas em silêncio.`,
    });
  } else {
    documentChecks.push({
      id: "coverage_complete",
      passed: true,
      detail: `${units.length} de ${units.length} unidades com permilagem`,
    });
    const sum = withValue.reduce((acc, unit) => acc + (unit.permilagemCentesimas ?? 0), 0);
    const sumOk = sum === PERMILAGEM_CENTESIMAS_TOTAL;
    documentChecks.push({
      id: "permilagem_sum_1000",
      passed: sumOk,
      detail: `Σ = ${sum} centésimas (1000,00‰ = ${PERMILAGEM_CENTESIMAS_TOTAL})`,
    });
    if (!sumOk) {
      blocking.push({
        code: "permilagem_sum",
        message: `Σ permilagem_centesimas = ${sum}; exige ${PERMILAGEM_CENTESIMAS_TOTAL}. O valor de cada unidade mantém-se.`,
      });
    }
  }

  const sumOnly =
    blocking.some((item) => item.code === "permilagem_sum") && humanLines === 0;

  return {
    units,
    summary: {
      profile: UNIT_SHARE_PROFILE_ID,
      representation: input.representation,
      informationPresent: input.informationPresent,
      readyForConfirmation: units.filter((unit) => unit.review === REVIEW_STATE.pendingReview).length,
      needsHumanDecision: humanLines + (sumOnly ? 1 : 0),
      blocking,
      checks: documentChecks,
      llmUsed: input.llmHypothesis != null,
      llmHypothesis: input.llmHypothesis,
      stages: INGEST_STAGES,
    },
  };
}
