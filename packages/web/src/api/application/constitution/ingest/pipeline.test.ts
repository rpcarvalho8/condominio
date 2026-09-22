/**
 * Documentos que o extractor por padrões ‰ não foi desenhado para ler.
 * O pipeline ou chega ao mesmo modelo canónico, ou pede revisão humana.
 * F1_LLM_EXTRACT fica desligado: a confiança não vem do Groq.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DomainError } from "../../../domain/errors";
import { extractFracoesFromPlainText } from "../extractors/from-text";
import {
  AMBIGUOUS_VALOR,
  COVERAGE_GAP,
  DIVERSE_DOCUMENTS,
  MIXED_UNITS,
  SUM_MISMATCH,
} from "./examples";
import { corpusExample } from "./profiles/corpus";
import { runIngestPipeline } from "./pipeline";

const ENV_KEYS = ["F1_LLM_EXTRACT", "GROQ_API_KEY"] as const;
const envBackup = new Map<string, string | undefined>();

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const previous = envBackup.get(key);
    if (previous == null) delete process.env[key];
    else process.env[key] = previous;
  }
}

afterEach(() => {
  restoreEnv();
});

function rememberEnv() {
  for (const key of ENV_KEYS) envBackup.set(key, process.env[key]);
  delete process.env.F1_LLM_EXTRACT;
  delete process.env.GROQ_API_KEY;
}

async function runText(filename: string, text: string) {
  return runIngestPipeline({
    bytes: Buffer.from(text, "utf8"),
    filename,
    documentId: "doc-test",
  });
}

describe("F1 pipeline — dez representações, um modelo", () => {
  test("cada documento normaliza A=600‰ e B=400‰ com evidência do sistema", async () => {
    rememberEnv();
    for (const doc of DIVERSE_DOCUMENTS) {
      const result = await runText(doc.filename, doc.text);
      expect(result.units.map((unit) => unit.codigo)).toEqual(["A", "B"]);
      expect(result.units.map((unit) => unit.permilagem)).toEqual([600, 400]);
      expect(result.units.every((unit) => unit.origem === doc.origem)).toBe(true);
      expect(result.units.every((unit) => unit.review === "pending_review")).toBe(true);
      expect(result.units.every((unit) => unit.warnings.length === 0)).toBe(true);
      expect(result.units.every((unit) => unit.confidence.source === "system_checks")).toBe(true);
      expect(result.units.every((unit) => unit.confidence.score === 1)).toBe(true);
      const perm = result.units[0]!.evidence.find((item) => item.field === "permilagem");
      expect(perm?.originalText).toBe(doc.originalA);
      expect(perm?.transform).toBe(doc.transform);
      expect(perm?.documentName).toBe(doc.filename);
      expect(result.summary.profile).toBe("unit_share");
      expect(result.summary.needsHumanDecision).toBe(0);
      expect(result.summary.readyForConfirmation).toBe(2);
      expect(result.summary.blocking).toEqual([]);
      expect(result.summary.llmUsed).toBe(false);
      expect(result.summary.stages).toEqual([
        "intake",
        "structure_discovery",
        "semantic_extraction",
        "canonicalization",
        "deterministic_validation",
        "human_review",
      ]);
    }
  });

  test("o extractor por padrões ‰ não produz sozinho este modelo", () => {
    for (const doc of DIVERSE_DOCUMENTS) {
      let canonical = false;
      try {
        const legacy = extractFracoesFromPlainText(doc.text);
        const pairs = legacy.lines.map((line) => ({
          codigo: String(line.payload.codigo),
          permilagem: Number(line.payload.permilagem),
        }));
        canonical =
          pairs.length === 2 &&
          pairs[0]?.codigo === "A" &&
          pairs[0]?.permilagem === 600 &&
          pairs[1]?.codigo === "B" &&
          pairs[1]?.permilagem === 400;
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        canonical = false;
      }
      expect(canonical).toBe(false);
    }
  });
});

describe("F1 pipeline — ambiguidade fica visível", () => {
  test("coluna valor não vira permilagem mesmo somando 1000", async () => {
    rememberEnv();
    const result = await runText("valor.csv", AMBIGUOUS_VALOR);
    expect(result.units).toHaveLength(2);
    expect(result.units.every((unit) => unit.permilagem == null)).toBe(true);
    expect(result.units.every((unit) => unit.review === "needs_human_review")).toBe(true);
    expect(result.units.every((unit) => unit.warnings.some((warning) => warning.code === "ambiguous_unit"))).toBe(
      true,
    );
    expect(result.summary.blocking.some((item) => item.code === "coverage_incomplete")).toBe(true);
    expect(result.summary.needsHumanDecision).toBe(2);
    const original = result.units[0]!.evidence.find((item) => item.field === "permilagem");
    expect(original?.originalText).toBe("600");
    expect(original?.transform).toBeNull();
  });

  test("não importa 2 de 3 unidades aparentes", async () => {
    rememberEnv();
    const result = await runText("cobertura.txt", COVERAGE_GAP);
    expect(result.units.map((unit) => unit.codigo)).toEqual(["A", "B", "C"]);
    expect(result.units[2]!.permilagem).toBeNull();
    expect(result.units[2]!.review).toBe("needs_human_review");
    expect(result.units[0]!.review).toBe("pending_review");
    expect(result.summary.readyForConfirmation).toBe(2);
    expect(result.summary.needsHumanDecision).toBe(1);
    expect(result.summary.blocking.some((item) => item.code === "coverage_incomplete")).toBe(true);
  });

  test("mistura de ‰ e % não converte para fechar a soma", async () => {
    rememberEnv();
    const result = await runText("misto.txt", MIXED_UNITS);
    const byCode = Object.fromEntries(result.units.map((unit) => [unit.codigo, unit]));
    expect(byCode.A?.permilagem).toBe(600);
    expect(byCode.B?.permilagem).toBeNull();
    expect(byCode.B?.warnings.some((warning) => warning.code === "mixed_units")).toBe(true);
    expect(byCode.B?.review).toBe("needs_human_review");
  });

  test("soma diferente de 1000 bloqueia o documento sem apagar as linhas", async () => {
    rememberEnv();
    const result = await runText("soma.csv", SUM_MISMATCH);
    expect(result.units.map((unit) => unit.permilagem)).toEqual([600, 300]);
    expect(result.units.every((unit) => unit.review === "pending_review")).toBe(true);
    expect(result.summary.needsHumanDecision).toBe(1);
    expect(result.summary.blocking.some((item) => item.code === "permilagem_sum")).toBe(true);
  });

  test("página da evidência segue o marcador do documento", async () => {
    rememberEnv();
    const result = await runText(
      "pagina.txt",
      "Página 3\nFracção A ........ 600 milésimas\nFracção B ........ 400 milésimas\n",
    );
    const perm = result.units[0]!.evidence.find((item) => item.field === "permilagem");
    expect(perm?.page).toBe(3);
    expect(perm?.originalText).toBe("600");
  });
});

describe("F1 pipeline — mapa de dívidas não é orçamento nem permilagem", () => {
  test("euros em atraso ficam no perfil unit_share sem permilagem", async () => {
    rememberEnv();
    const debt = corpusExample("09-debt-map");
    expect(debt.budgetPlanVerdict).toBe("false_positive");
    const result = await runText("dividas.txt", debt.text);
    expect(result.summary.profile).toBe("unit_share");
    expect(result.units.map((unit) => unit.codigo)).toEqual(["A", "B"]);
    expect(result.units.every((unit) => unit.permilagem == null)).toBe(true);
    expect(result.units.every((unit) => unit.review === "needs_human_review")).toBe(true);
    expect(result.units.every((unit) => unit.warnings.some((warning) => warning.code === "ambiguous_unit"))).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toContain("budget_plan");
    expect(JSON.stringify(result)).not.toContain("obligation");
  });
});

describe("F1 pipeline — LLM não confirma", () => {
  test("F1_LLM_EXTRACT omisso não chama a rede", async () => {
    rememberEnv();
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("rede não devia ser chamada");
    }) as typeof fetch;
    try {
      const result = await runText("unidades.csv", DIVERSE_DOCUMENTS[0]!.text);
      expect(result.summary.llmUsed).toBe(false);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("hipótese Groq não preenche permilagem nem a confiança", async () => {
    rememberEnv();
    process.env.F1_LLM_EXTRACT = "1";
    process.env.GROQ_API_KEY = "test-key";
    const result = await runIngestPipeline({
      bytes: Buffer.from(AMBIGUOUS_VALOR, "utf8"),
      filename: "valor.csv",
      llm: async () => ({
        authoritative: false,
        note: "o modelo diz que valor é permilagem",
        raw: { permilagem: [600, 400], confidence: 0.99 },
      }),
    });
    expect(result.summary.llmUsed).toBe(true);
    expect(result.summary.llmHypothesis?.authoritative).toBe(false);
    expect(result.units.every((unit) => unit.permilagem == null)).toBe(true);
    expect(result.units.every((unit) => unit.confidence.source === "system_checks")).toBe(true);
    expect(result.units.every((unit) => unit.confidence.score < 1)).toBe(true);
    expect(JSON.stringify(result.units)).not.toContain("0.99");
  });
});
