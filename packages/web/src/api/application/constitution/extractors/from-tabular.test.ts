import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { extractStructuredFromTabular, looksLikeDelimitedTable } from "./from-tabular";

function xlsxOf(rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "folha");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
}

describe("extractStructuredFromTabular", () => {
  test("CSV ponto-e-vírgula PT", () => {
    const csv = "código;permilagem\nA;600\nB;400\n";
    expect(looksLikeDelimitedTable(csv)).toBe(true);
    const extraction = extractStructuredFromTabular({
      bytes: Buffer.from(csv, "utf8"),
      filename: "mapa.csv",
      kindHint: "fracao",
    });
    expect(extraction.lines.map((l) => l.payload.permilagem)).toEqual([600, 400]);
  });

  test("TSV .txt com cabeçalho Unidade/Coeficiente (0,6 → 600)", () => {
    const tsv = "Unidade\tCoeficiente\nA\t0,6\nB\t0,4\n";
    const extraction = extractStructuredFromTabular({
      bytes: Buffer.from(tsv, "utf8"),
      filename: "Regulamento_fracao.txt",
      kindHint: "fracao",
    });
    expect(extraction.lines).toHaveLength(2);
    expect(extraction.lines.map((l) => l.payload.permilagem).sort()).toEqual([400, 600]);
  });

  test("tabela pipe sem cabeçalho reconhecido", () => {
    const text = "| A | 550 |\n| B | 450 |\n";
    const extraction = extractStructuredFromTabular({
      bytes: Buffer.from(text, "utf8"),
      filename: "mapa.txt",
      kindHint: "fracao",
    });
    expect(extraction.lines).toHaveLength(2);
  });

  test("Excel com cabeçalhos não standard", () => {
    const extraction = extractStructuredFromTabular({
      bytes: xlsxOf([
        ["Unidade", "Coeficiente"],
        ["Loja 1", "12,5%"],
        ["A", "875"],
      ]),
      filename: "mapa.xlsx",
      kindHint: "fracao",
    });
    expect(extraction.lines).toHaveLength(2);
    const byCode = Object.fromEntries(
      extraction.lines.map((l) => [l.payload.codigo, l.payload.permilagem]),
    );
    expect(byCode["Loja 1"]).toBe(125);
    expect(byCode.A).toBe(875);
  });

  test("contactos CSV", () => {
    const csv = "fracao,nome,email\nA,Maria Costa,maria@condo.test\n";
    const extraction = extractStructuredFromTabular({
      bytes: Buffer.from(csv, "utf8"),
      filename: "contactos.csv",
      kindHint: "contacto",
    });
    expect(extraction.lines[0]!.payload).toMatchObject({
      fracaoCodigo: "A",
      personName: "Maria Costa",
      email: "maria@condo.test",
    });
  });
});
