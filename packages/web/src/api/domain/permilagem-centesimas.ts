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

/** Inteiro positivo dentro de um tecto. Rejeita floats e inteiros fora de Number.isSafeInteger. */
export function positiveSafeInteger(value: unknown, max: number): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 && value <= max ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : null;
  }
  return null;
}

export type PermilagemCentesimasRead =
  | { ok: true; centesimas: number }
  | { ok: false; reason: "missing" | "reextract" };

const PIPELINE_MARKERS = [
  "origem",
  "designacao_original",
  "warnings",
  "review",
  "confidenceChecks",
  "confidenceSource",
] as const;

function permilagemEvidence(
  raw: Record<string, unknown>,
): { kind: "absent" } | { kind: "refuse" } | { kind: "text"; text: string; unit: QuotaUnit } {
  if (!Array.isArray(raw.evidence)) return { kind: "absent" };
  const perm = raw.evidence.find(
    (entry): entry is { field?: unknown; originalText?: unknown; transform?: unknown } =>
      entry != null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { field?: unknown }).field === "permilagem",
  );
  if (!perm) return { kind: "refuse" };
  if (typeof perm.originalText !== "string" || perm.originalText.trim() === "") {
    return { kind: "refuse" };
  }
  const transform = typeof perm.transform === "string" ? perm.transform : "";
  const unit: QuotaUnit = transform.startsWith("percent_to_permille") ? "percent" : "permille";
  return { kind: "text", text: perm.originalText, unit };
}

/**
 * Centésimas a partir de um payload já gravado.
 * Com evidência do pipeline, o token `originalText` ganha ao inteiro arredondado.
 * Sem evidência, inteiro×100 só para entrada manual ou CSV inteira.
 * Caso contrário: re-extrair. Nunca se fabrica centésimas a partir de um arredondamento.
 */
export function centesimasFromStoredPayload(raw: Record<string, unknown>): PermilagemCentesimasRead {
  const directField = raw.permilagem_centesimas ?? raw.permilagemCentesimas;
  if (directField != null) {
    const direct = positiveSafeInteger(directField, PERMILAGEM_CENTESIMAS_TOTAL);
    return direct == null ? { ok: false, reason: "missing" } : { ok: true, centesimas: direct };
  }

  const evidence = permilagemEvidence(raw);
  if (evidence.kind === "text") {
    const parsed = centesimasFromQuotaToken(evidence.text, evidence.unit);
    if (
      parsed.ok &&
      parsed.centesimas > 0 &&
      parsed.centesimas <= PERMILAGEM_CENTESIMAS_TOTAL &&
      Number.isSafeInteger(parsed.centesimas)
    ) {
      return { ok: true, centesimas: parsed.centesimas };
    }
    return { ok: false, reason: "reextract" };
  }
  if (evidence.kind === "refuse") return { ok: false, reason: "reextract" };

  const looksPipeline = PIPELINE_MARKERS.some((key) => raw[key] != null);
  const perm = raw.permilagem;
  if (typeof perm === "string" && /[.,]/.test(perm)) {
    const parsed = centesimasFromQuotaToken(perm, "permille");
    if (
      parsed.ok &&
      parsed.centesimas > 0 &&
      parsed.centesimas <= PERMILAGEM_CENTESIMAS_TOTAL &&
      Number.isSafeInteger(parsed.centesimas)
    ) {
      return { ok: true, centesimas: parsed.centesimas };
    }
    return { ok: false, reason: looksPipeline ? "reextract" : "missing" };
  }
  if (typeof perm === "number" && !Number.isSafeInteger(perm)) {
    return { ok: false, reason: "reextract" };
  }
  if (looksPipeline) return { ok: false, reason: "reextract" };

  const asInt = positiveSafeInteger(perm, PERMILAGEM_CENTESIMAS_TOTAL);
  if (asInt == null) return { ok: false, reason: "missing" };
  const centesimas = asInt * 100;
  if (!Number.isSafeInteger(centesimas) || centesimas <= 0 || centesimas > PERMILAGEM_CENTESIMAS_TOTAL) {
    return { ok: false, reason: "missing" };
  }
  return { ok: true, centesimas };
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
