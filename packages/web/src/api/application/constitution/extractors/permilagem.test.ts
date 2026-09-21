import { describe, expect, test } from "bun:test";
import {
  fracaoCodigoKey,
  isPlausibleFracaoCodigo,
  normalizeFracaoCodigo,
  parsePermilagem,
} from "./permilagem";

describe("parsePermilagem", () => {
  test("inteiros e símbolo ‰", () => {
    expect(parsePermilagem("600")).toBe(600);
    expect(parsePermilagem("600‰")).toBe(600);
    expect(parsePermilagem("600 permilagens")).toBe(600);
    expect(parsePermilagem("75 permilagem")).toBe(75);
    expect(parsePermilagem("125 milésimas")).toBe(125);
  });

  test("fracção de 1 e percentagem", () => {
    expect(parsePermilagem("0.6")).toBe(600);
    expect(parsePermilagem("0,6")).toBe(600);
    expect(parsePermilagem("0,125")).toBe(125);
    expect(parsePermilagem("12,5%")).toBe(125);
    expect(parsePermilagem("100%")).toBe(1000);
    expect(parsePermilagem("1.0")).toBe(1000);
  });

  test("razões n/d", () => {
    expect(parsePermilagem("600/1000")).toBe(600);
    expect(parsePermilagem("3/5")).toBe(600);
  });

  test("rejeita valores impossíveis", () => {
    expect(parsePermilagem("")).toBeNull();
    expect(parsePermilagem("0")).toBeNull();
    expect(parsePermilagem("abc")).toBeNull();
    expect(parsePermilagem("1500")).toBeNull();
  });
});

describe("normalizeFracaoCodigo", () => {
  test("remove prefixo Fração e rejeita cabeçalhos", () => {
    expect(normalizeFracaoCodigo("Fração A")).toBe("A");
    expect(normalizeFracaoCodigo("1.º Esq")).toBe("1.º Esq");
    expect(normalizeFracaoCodigo("Loja 1")).toBe("Loja 1");
    expect(normalizeFracaoCodigo("permilagem")).toBeNull();
    expect(normalizeFracaoCodigo("total")).toBeNull();
    expect(isPlausibleFracaoCodigo("maria@x.pt")).toBe(false);
    expect(fracaoCodigoKey("a")).toBe("A");
  });
});
