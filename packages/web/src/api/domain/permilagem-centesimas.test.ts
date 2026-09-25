import { describe, expect, test } from "bun:test";
import { readPermilagemCentesimas } from "../application/constitution/f1-constitution";
import {
  centesimasFromQuotaToken,
  centesimasFromStoredPayload,
  formatPermilagemCentesimas,
  legacyIntegerPermilagem,
} from "./permilagem-centesimas";

/** O mesmo contrato do pré-preenchimento em /f1: null não entra no campo nem na Σ. */
function uiCentesimas(payload: Record<string, unknown>): number | null {
  const read = centesimasFromStoredPayload(payload);
  return read.ok ? read.centesimas : null;
}

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

  test("38,80 com identity_permille continua 3880 e não o inteiro ×100", () => {
    const payload = {
      permilagem: 39,
      evidence: [{ field: "permilagem", originalText: "38,80", transform: "identity_permille" }],
    };
    expect(centesimasFromStoredPayload(payload)).toEqual({ ok: true, centesimas: 3880 });
    expect(uiCentesimas(payload)).toBe(3880);
    expect(readPermilagemCentesimas(payload)).toBe(3880);
    expect(
      centesimasFromStoredPayload({
        permilagem: 39,
        evidence: [{ field: "permilagem", originalText: "38,801", transform: "identity_permille" }],
      }),
    ).toEqual({ ok: false, reason: "reextract" });
    expect(
      centesimasFromStoredPayload({ permilagem: 39, origem: "table" }),
    ).toEqual({ ok: false, reason: "reextract" });
    expect(centesimasFromStoredPayload({ permilagem: 600 })).toEqual({
      ok: true,
      centesimas: 60000,
    });
    expect(centesimasFromStoredPayload({ permilagem_centesimas: 100000 })).toEqual({
      ok: true,
      centesimas: 100000,
    });
    expect(centesimasFromStoredPayload({ permilagem_centesimas: 100001 }).ok).toBe(false);
    expect(centesimasFromStoredPayload({ permilagem_centesimas: 39.5 }).ok).toBe(false);
  });

  test("human_edit mais recente ganha ao pipeline; token que não bate com o inteiro recusa", () => {
    const swappedA = {
      codigo: "A",
      permilagem: 400,
      evidence: [
        { field: "permilagem", originalText: "600,00", transform: "identity_permille" },
        { field: "permilagem", originalText: "400", transform: "human_edit" },
      ],
    };
    const swappedB = {
      codigo: "B",
      permilagem: 600,
      evidence: [
        { field: "permilagem", originalText: "400,00", transform: "identity_permille" },
        { field: "permilagem", originalText: "600", transform: "human_edit" },
      ],
    };
    expect(centesimasFromStoredPayload(swappedA)).toEqual({ ok: true, centesimas: 40000 });
    expect(centesimasFromStoredPayload(swappedB)).toEqual({ ok: true, centesimas: 60000 });
    expect(uiCentesimas(swappedA)).toBe(40000);
    expect(readPermilagemCentesimas(swappedB)).toBe(60000);

    const contradicted = {
      permilagem: 400,
      evidence: [{ field: "permilagem", originalText: "600,00", transform: "identity_permille" }],
    };
    expect(centesimasFromStoredPayload(contradicted)).toEqual({ ok: false, reason: "reextract" });
    expect(uiCentesimas(contradicted)).toBeNull();
    expect(readPermilagemCentesimas(contradicted)).toBeNull();
  });

  test("unidade rejeitada pelo pipeline não se lê como ‰", () => {
    const ambiguous = {
      permilagem: null,
      permilagem_centesimas: null,
      warnings: [{ code: "ambiguous_unit" }],
      evidence: [{ field: "permilagem", originalText: "38,80", transform: null }],
    };
    const mixed = {
      permilagem: null,
      permilagem_centesimas: null,
      warnings: [{ code: "mixed_units" }],
      evidence: [{ field: "permilagem", originalText: "3,88%", transform: null }],
    };
    const inconsistent = {
      permilagem: null,
      warnings: [{ code: "unit_context_inconsistent" }],
      evidence: [{ field: "permilagem", originalText: "3,88%", transform: null }],
    };
    for (const payload of [ambiguous, mixed, inconsistent]) {
      expect(centesimasFromStoredPayload(payload)).toEqual({ ok: false, reason: "reextract" });
      expect(uiCentesimas(payload)).toBeNull();
      expect(readPermilagemCentesimas(payload)).toBeNull();
      const read = centesimasFromStoredPayload(payload);
      expect(read.ok ? read.centesimas : null).not.toBe(388);
      expect(read.ok ? read.centesimas : null).not.toBe(3880);
    }
    expect(
      centesimasFromStoredPayload({
        permilagem: null,
        evidence: [{ field: "permilagem", originalText: "3,88%", transform: "percent_to_permille:*10" }],
      }),
    ).toEqual({ ok: true, centesimas: 3880 });
  });
});
