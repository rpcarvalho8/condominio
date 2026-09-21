import { describe, expect, test } from "bun:test";
import { extractContactosFromPlainText, extractFracoesFromPlainText } from "./from-text";

function codes(text: string): string[] {
  return extractFracoesFromPlainText(text).lines.map(
    (l) => (l.payload as { codigo: string }).codigo,
  );
}

function perm(text: string, codigo: string): number {
  const line = extractFracoesFromPlainText(text).lines.find(
    (l) => (l.payload as { codigo: string }).codigo === codigo,
  );
  return Number(line?.payload.permilagem);
}

describe("extractFracoesFromPlainText — layouts irregulares", () => {
  test("padrão clássico código — N‰", () => {
    const extraction = extractFracoesFromPlainText("Fração A — 600‰\nFração B — 400‰");
    expect(extraction.lines).toHaveLength(2);
    expect(perm("Fração A — 600‰\nFração B — 400‰", "A")).toBe(600);
  });

  test("milésimas, 0,6, 600/1000, percentagem e 1.º Esq", () => {
    const text = [
      "CONDOMÍNIO EXEMPLO — mapa de permilagens",
      "A fracção A tem 125 milésimas.",
      "A fracção B corresponde a 0,250 do prédio.",
      "Fracção C — 125/1000",
      "Loja 1: 12,5%",
      "Garagem G1  100 permilagens",
      "1.º Esq    200‰",
      "2º Dto     75 permilagem",
    ].join("\n");
    const extraction = extractFracoesFromPlainText(text);
    const byCode = Object.fromEntries(
      extraction.lines.map((l) => [
        (l.payload as { codigo: string }).codigo,
        Number(l.payload.permilagem),
      ]),
    );
    expect(byCode.A).toBe(125);
    expect(byCode.B).toBe(250);
    expect(byCode.C).toBe(125);
    expect(byCode["Loja 1"] ?? byCode["1"]).toBe(125);
    expect(byCode.G1 ?? byCode["Garagem G1"]).toBe(100);
    expect(byCode["1.º Esq"] ?? byCode["1.ºEsq"]).toBe(200);
    expect(byCode["2º Dto"] ?? byCode["2ºDto"]).toBe(75);
    const sum = extraction.lines.reduce((a, l) => a + Number(l.payload.permilagem), 0);
    expect(sum).toBe(1000);
  });

  test("prosa sem símbolo ‰ ainda canonicaliza se a soma for ~1000", () => {
    const text = "Unidade X 600\nUnidade Y 400";
    expect(codes(text).sort()).toEqual(["X", "Y"]);
  });

  test("lorem sem permilagens → empty_extraction", () => {
    expect(() => extractFracoesFromPlainText("lorem ipsum scan noise without numbers")).toThrow();
  });
});

describe("extractContactosFromPlainText", () => {
  test("em-dash clássico", () => {
    const extraction = extractContactosFromPlainText("A — Maria Costa — maria@condo.test");
    expect(extraction.lines[0]!.payload).toMatchObject({
      fracaoCodigo: "A",
      personName: "Maria Costa",
      email: "maria@condo.test",
    });
  });

  test("telefone PT e email na mesma linha", () => {
    const extraction = extractContactosFromPlainText(
      "1.º Esq: João Silva, 912345678, joao@condo.test",
    );
    expect(extraction.lines).toHaveLength(1);
    expect(extraction.lines[0]!.payload).toMatchObject({
      fracaoCodigo: "1.º Esq",
      personName: "João Silva",
      email: "joao@condo.test",
      phone: "912345678",
    });
  });
});
