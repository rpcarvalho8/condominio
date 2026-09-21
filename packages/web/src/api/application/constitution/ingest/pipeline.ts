/**
 * Orquestra o pipeline F1. Para antes da confirmação humana.
 */
import { EXTRACT_LINE_KINDS, type StructuredExtraction } from "../../../domain/constitution";
import { canonicalizeObservations } from "./canonicalize";
import type { IngestPipelineResult, LlmHypothesis } from "./contracts";
import { discoverDocument } from "./intake";
import { isLlmExtractEnabled, readLlmHypothesis } from "./llm-hypothesis";
import { extractObservations } from "./semantic-extraction";
import { validateDrafts } from "./validate";

function informationPresent(observations: ReturnType<typeof extractObservations>): string[] {
  const present: string[] = [];
  if (observations.some((row) => row.codigo)) present.push("unit_identifiers");
  if (observations.some((row) => row.valueNumber != null)) present.push("quota_values");
  if (observations.some((row) => row.unitCue === "permille" || row.unitCue === "percent")) {
    present.push("unit_cues");
  }
  return present;
}

export function evidenceExcerpt(unit: IngestPipelineResult["units"][number]): string {
  const perm = unit.evidence.find((item) => item.field === "permilagem");
  const where = [
    perm?.page != null ? `página ${perm.page}` : null,
    perm?.line != null ? `linha ${perm.line}` : null,
    perm?.cell ? `coluna=${perm.cell}` : null,
    perm?.region ? `região ${perm.region}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const original = perm?.originalText ?? unit.designacaoOriginal;
  if (unit.permilagem == null) {
    const why = unit.warnings.map((warning) => warning.message).join(" ");
    return `${unit.codigo || "?"} sem permilagem confirmável (${where}). ${why} Original: «${original}». ${unit.designacaoOriginal}`;
  }
  if (perm?.transform === "percent_to_permille:*10") {
    return `${unit.codigo} → ${unit.permilagem}‰ porque «${original}» está em percentagem e a soma das percentagens do documento é 100 (${where}); transform=percent_to_permille:*10. Original: «${unit.designacaoOriginal}»`;
  }
  return `${unit.codigo} → ${unit.permilagem}‰ porque coluna=${perm?.cell ?? "—"}, valor=${original}, unidade=‰ (${where}); transform=${perm?.transform ?? "identity_permille"}. Original: «${unit.designacaoOriginal}»`;
}

export function pipelineToStructuredExtraction(result: IngestPipelineResult): StructuredExtraction {
  return {
    pipeline: result.summary,
    lines: result.units.map((unit) => ({
      kind: EXTRACT_LINE_KINDS.fracao,
      payload: {
        codigo: unit.codigo,
        tipo: "fracao",
        permilagem: unit.permilagem,
        designacao_original: unit.designacaoOriginal,
        origem: unit.origem,
        evidence: unit.evidence,
        warnings: unit.warnings,
        confidenceChecks: unit.confidence.checks,
        confidenceSource: unit.confidence.source,
        review: unit.review,
      },
      sourceExcerpt: evidenceExcerpt(unit),
      confidence: unit.confidence.score,
      status: unit.review,
    })),
  };
}

export async function runIngestPipeline(input: {
  bytes: Buffer;
  filename: string;
  documentId?: string | null;
  llm?: (text: string) => Promise<LlmHypothesis | null>;
}): Promise<IngestPipelineResult> {
  const structure = discoverDocument({ bytes: input.bytes, filename: input.filename });
  const observations = extractObservations(structure);
  const origem = structure.representation === "unknown" ? "prose" : structure.representation;
  const drafts = canonicalizeObservations({
    observations,
    origem,
    documentId: input.documentId ?? null,
    documentName: input.filename,
    region: structure.sheet ? `sheet:${structure.sheet}` : null,
  });
  let llmHypothesis: LlmHypothesis | null = null;
  if (isLlmExtractEnabled()) {
    llmHypothesis = input.llm
      ? await input.llm(structure.text)
      : await readLlmHypothesis({ text: structure.text });
  }
  return validateDrafts({
    drafts,
    representation: structure.representation,
    informationPresent: informationPresent(observations),
    llmHypothesis,
  });
}
