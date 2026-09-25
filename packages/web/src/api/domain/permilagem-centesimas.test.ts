import { describe, expect, test } from "bun:test";
import {
  centesimasFromQuotaToken,
  formatPermilagemCentesimas,
  legacyIntegerPermilagem,
} from "./permilagem-centesimas";

describe("permilagem_centesimas", () => {
  test("token ‰ com 2 casas, sem float", () => {
    expect(centesimasFromQuotaToken("39,50", "permille")).toEqual({
      ok: true,
      centesimas: 3950,
      permilleDecimals: 2,
    });
    expect(centesimasFromQuotaToken("38,80", "permille")).toMatchObject({ centesimas: 3880 });
    expect(centesimasFromQuotaToken("600", "permille")).toMatchObject({ centesimas: 60000 });
    expect(formatPermilagemCentesimas(3950)).toBe("39,50");
    expect(legacyIntegerPermilagem(3950)).toBeNull();
    expect(legacyIntegerPermilagem(60000)).toBe(600);
  });

  test("mais de 2 casas no ‰ falha fechado", () => {
    expect(centesimasFromQuotaToken("39,501", "permille")).toEqual({
      ok: false,
      reason: "too_many_decimals",
    });
  });

  test("percentagem: casas contam-se no ‰ depois de ×10", () => {
    expect(centesimasFromQuotaToken("60", "percent")).toMatchObject({
      centesimas: 60000,
      permilleDecimals: 0,
    });
    expect(centesimasFromQuotaToken("6,25", "percent")).toMatchObject({
      centesimas: 6250,
      permilleDecimals: 1,
    });
    expect(centesimasFromQuotaToken("6,255", "percent")).toMatchObject({
      centesimas: 6255,
      permilleDecimals: 2,
    });
    expect(centesimasFromQuotaToken("6,2555", "percent")).toEqual({
      ok: false,
      reason: "too_many_decimals",
    });
  });
});
