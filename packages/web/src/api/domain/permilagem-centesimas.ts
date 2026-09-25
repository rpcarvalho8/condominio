/**
 * Permilagem canónica em centésimas de ‰ (Σ = 100000 = 1000,00‰).
 * A escala sai do token decimal do documento, nunca de um float acumulado
 * e nunca de Math.round.
 */

export const PERMILAGEM_CENTESIMAS_TOTAL = 100_000;

export type QuotaUnit = "permille" | "percent";

export type CentesimasParse =
  | { ok: true; centesimas: number; permilleDecimals: number }
  | { ok: false; reason: "invalid" | "too_many_decimals" };

function pow10(n: number): number {
  let value = 1;
  for (let i = 0; i < n; i++) value *= 10;
  return value;
}

/**
 * Converte o token documental para centésimas de ‰.
 * Em percentagem, as casas decimais contam-se no ‰ depois de ×10.
 * Mais de 2 casas no ‰ → too_many_decimals (a linha não é confirmável).
 */
export function centesimasFromQuotaToken(raw: string, unit: QuotaUnit): CentesimasParse {
  const trimmed = raw.trim().replace(/[‰%\s\u00a0]/g, "");
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(trimmed);
  if (!match) return { ok: false, reason: "invalid" };
  const whole = match[1]!;
  const frac = match[2] ?? "";
  const scale = frac.length;
  if (whole.length > 15 || frac.length > 8) return { ok: false, reason: "invalid" };

  if (unit === "permille") {
    if (scale > 2) return { ok: false, reason: "too_many_decimals" };
    const centesimas = Number(whole + frac.padEnd(2, "0"));
    if (!Number.isSafeInteger(centesimas)) return { ok: false, reason: "invalid" };
    return { ok: true, centesimas, permilleDecimals: scale };
  }

  const permilleDecimals = Math.max(0, scale - 1);
  if (permilleDecimals > 2) return { ok: false, reason: "too_many_decimals" };
  const digits = Number(whole + frac);
  if (!Number.isSafeInteger(digits)) return { ok: false, reason: "invalid" };
  const centesimas = digits * pow10(3 - scale);
  if (!Number.isSafeInteger(centesimas)) return { ok: false, reason: "invalid" };
  return { ok: true, centesimas, permilleDecimals };
}

/** Inteiro ‰ só quando não há centésimos. Caso contrário NULL — não se arredonda. */
export function legacyIntegerPermilagem(centesimas: number): number | null {
  if (!Number.isInteger(centesimas) || centesimas % 100 !== 0) return null;
  return centesimas / 100;
}

/** 3950 → "39,50". */
export function formatPermilagemCentesimas(centesimas: number): string {
  const negative = centesimas < 0;
  const abs = Math.abs(Math.trunc(centesimas));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${negative ? "-" : ""}${whole},${String(frac).padStart(2, "0")}`;
}
