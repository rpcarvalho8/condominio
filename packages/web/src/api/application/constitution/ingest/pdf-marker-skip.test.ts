/**
 * Micro-check: skip mínimo de marcadores PDF em skipProseLine.
 * Apenas ^%PDF- e ^%%EOF — sem BT ( / endobj (falso negativo).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runIngestPipeline } from "./pipeline";

function fakePdf(text: string): Buffer {
  return Buffer.from(`%PDF-1.4\nBT (${text}) Tj ET\n${text}\n%%EOF\n`, "utf8");
}

async function runText(filename: string, text: string) {
  return runIngestPipeline({
    bytes: Buffer.from(text, "utf8"),
    filename,
    documentId: "pdf-marker-check",
  });
}

describe("F1 skipProseLine — marcadores PDF (mínimo %PDF-/%%EOF)", () => {
  test("A. fake PDF: candidato espúrio PDF eliminado sem depender de BT (", async () => {
    const bytes = fakePdf("Fração A — 600‰\nFração B — 400‰");
    const result = await runIngestPipeline({
      bytes,
      filename: "regulamento.pdf",
      documentId: "fake-pdf-check",
    });
    expect(result.units.map((unit) => unit.codigo).sort()).toEqual(["A", "B"]);
    expect(result.units.every((unit) => unit.codigo !== "PDF")).toBe(true);
    expect(result.units.map((unit) => unit.permilagem).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      400, 600,
    ]);
  });

  test("B. BT (British Telecom)…: linha NÃO descartada; residual selectCodigo=BT (não A)", async () => {
    const result = await runText(
      "bt-telecom.txt",
      ["BT (British Telecom) A — 600‰", "Fração B — 400‰", ""].join("\n"),
    );
    // Skip BT ( removido → a linha entra no pipeline (já não é FN por skipProseLine).
    expect(result.units.some((unit) => unit.permilagem === 600)).toBe(true);
    expect(result.units.find((unit) => unit.codigo === "B")?.permilagem).toBe(400);
    // Residual FORA desta micro-fase: selectCodigo escolhe o primeiro código curto "BT", não "A".
    // Critério A+B como códigos: FAIL — documentado; sem alteração a selectCodigo ("Nada mais").
    expect(result.units.map((unit) => unit.codigo).sort()).toEqual(["B", "BT"]);
    expect(result.units.some((unit) => unit.codigo === "A")).toBe(false);
  });

  test("%PDF- / %%EOF no início da linha não viram candidatos", async () => {
    const result = await runText(
      "markers.txt",
      ["%PDF-1.4", "Permilagem ‰", "A 600,00", "B 400,00", "%%EOF", ""].join("\n"),
    );
    expect(result.units.map((unit) => unit.codigo).sort()).toEqual(["A", "B"]);
    expect(result.units.every((unit) => unit.codigo !== "PDF")).toBe(true);
  });

  test("menção legítima a %PDF- a meio da frase não impede extracção", async () => {
    const result = await runText(
      "mention.txt",
      [
        "Nota: o ficheiro %PDF-1.7 foi arquivado.",
        "Fracção A ........ 600 milésimas",
        "Fracção B ........ 400 milésimas",
        "",
      ].join("\n"),
    );
    expect(result.units.map((unit) => unit.codigo)).toEqual(["A", "B"]);
    expect(result.units.map((unit) => unit.permilagem)).toEqual([600, 400]);
  });

  test("fixture Fonte mantém 33 candidatos; Σ round = 1001‰", async () => {
    const bytes = readFileSync(
      join(import.meta.dir, "../extractors/fixtures/anexo-regulamento-fonte.pdf"),
    );
    const result = await runIngestPipeline({
      bytes,
      filename: "anexo-regulamento-fonte.pdf",
      documentId: "fonte-marker-check",
    });
    expect(result.units).toHaveLength(33);
    expect(result.units.map((unit) => unit.codigo).sort()).toEqual(
      [
        "A",
        "AA",
        "AB",
        "AC",
        "AD",
        "AE",
        "AF",
        "AG",
        "AH",
        "AI",
        "AJ",
        "B",
        "C",
        "D",
        "E",
        "F",
        "G",
        "H",
        "I",
        "J",
        "L",
        "M",
        "N",
        "O",
        "P",
        "Q",
        "R",
        "S",
        "T",
        "U",
        "V",
        "X",
        "Z",
      ].sort(),
    );
    const sum = result.units.reduce((acc, unit) => acc + (unit.permilagem ?? 0), 0);
    expect(sum).toBe(1001);
  });
});
