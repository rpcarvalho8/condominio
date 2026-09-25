/**
 * Regressão: PDF textual real (Anexo Regulamento) → unit_share → Σ centésimas
 * = 100000 sem ajuste. Sem OCR, sem parser da Fonte.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractEmbeddedTextFromBytes,
  extractIngestTextFromBytes,
} from "../extractors/from-ocr";
import { centesimasFromQuotaToken, legacyIntegerPermilagem } from "../../../domain/permilagem-centesimas";
import { runIngestPipeline } from "./pipeline";

const FIXTURE = join(
  import.meta.dir,
  "../extractors/fixtures/anexo-regulamento-fonte.pdf",
);

/** Valores explícitos da página 15 (Documento nº 1), fonte → decimal. */
const FONTE_PAGE15: Record<string, number> = {
  J: 38.8,
  L: 41.76,
  M: 39.5,
  N: 38.82,
  O: 41.76,
  P: 43.3,
  AA: 35.06,
  Q: 37.14,
  R: 56.75,
  S: 32.34,
  T: 38.5,
  U: 57.21,
  V: 34.05,
  X: 39.12,
  Z: 55.15,
  AB: 35.0,
  AE: 37.0,
  AF: 35.21,
  AG: 35.41,
  AH: 40.96,
  AI: 35.85,
  AJ: 34.57,
  AC: 18.1,
  AD: 18.68,
  G: 22.96,
  H: 16.96,
  I: 22.0,
  A: 2.89,
  B: 2.86,
  C: 2.89,
  D: 3.15,
  E: 3.0,
  F: 3.25,
};

describe("F1 PDF textual — Anexo Regulamento Fonte", () => {
  test("extractEmbeddedTextFromBytes não recupera a camada FlateDecode", () => {
    const bytes = readFileSync(FIXTURE);
    const embedded = extractEmbeddedTextFromBytes(bytes);
    expect(/permilagem/i.test(embedded)).toBe(false);
    expect(embedded.includes("‰")).toBe(false);
  });

  test("unpdf recupera texto com Permilagem ‰ e Total Prédio", async () => {
    const bytes = readFileSync(FIXTURE);
    const text = await extractIngestTextFromBytes(bytes, "anexo-regulamento-fonte.pdf");
    expect(/permilagem/i.test(text)).toBe(true);
    expect(text).toContain("‰");
    expect(/Total\s+Pr[eé]dio/i.test(text)).toBe(true);
    expect(text).toContain("J Hab");
    expect(text).toContain("38,80");
  });

  test("pipeline unit_share: 33 candidatos = valores da fonte; Σ centésimas = 100000", async () => {
    const bytes = readFileSync(FIXTURE);
    const result = await runIngestPipeline({
      bytes,
      filename: "anexo-regulamento-fonte.pdf",
      documentId: "fixture-fonte",
    });

    expect(result.units).toHaveLength(33);
    expect(result.summary.profile).toBe("unit_share");
    expect(result.summary.representation).toBe("prose");
    expect(result.summary.readyForConfirmation).toBe(33);
    expect(result.summary.needsHumanDecision).toBe(0);
    expect(result.units.every((unit) => unit.review === "pending_review")).toBe(true);
    expect(result.units.every((unit) => unit.warnings.length === 0)).toBe(true);

    for (const unit of result.units) {
      const expected = FONTE_PAGE15[unit.codigo];
      expect(expected).toBeDefined();
      const original = unit.evidence.find((item) => item.field === "permilagem")?.originalText;
      expect(Number(String(original).replace(",", "."))).toBeCloseTo(expected!, 5);
      const parsed = centesimasFromQuotaToken(String(original), "permille");
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(unit.permilagemCentesimas).toBe(parsed.centesimas);
      expect(unit.permilagem).toBe(legacyIntegerPermilagem(parsed.centesimas));
      expect(unit.evidence.find((item) => item.field === "permilagem")?.transform).toBe(
        "identity_permille",
      );
    }

    const sum = result.units.reduce((acc, unit) => acc + (unit.permilagemCentesimas ?? 0), 0);
    expect(sum).toBe(100000);
    expect(result.units.find((unit) => unit.codigo === "M")?.permilagemCentesimas).toBe(3950);
    expect(result.units.find((unit) => unit.codigo === "M")?.permilagem).toBeNull();
    expect(result.summary.blocking.some((item) => item.code === "permilagem_sum")).toBe(false);
    expect(result.summary.checks.find((check) => check.id === "permilagem_sum_1000")?.passed).toBe(
      true,
    );
  });
});
