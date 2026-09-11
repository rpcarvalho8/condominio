/**
 * Identity match tenant-scoped (transplante de identity-matrix.ts).
 * Usa constitution_fracoes + owner_contact_drafts confirmados — nunca MATRIZ Fonte / Quota.pago.
 * Não decide Allocation; só liga Payment candidato a uma Fração.
 */
import { and, eq } from "drizzle-orm";
import { constitutionFracoes, obligations, ownerContactDrafts } from "../../database/schema";
import { EXTRACT_LINE_STATUS } from "../../domain/constitution";
import type { KernelDeps } from "../../infra/kernel-deps";

export type TenantIdentityRow = {
  fracaoId: string;
  codigo: string;
  names: string[];
};

export type IdentityMatch = {
  fracaoId: string | null;
  codigo: string | null;
  confidence: number;
  criteria: string[];
  payerName: string | null;
};

export function normalizeIdentityText(s: string): string {
  return s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extração genérica do pagador no descritivo (Santander / SEPA) — sem PII hardcoded. */
export function extractPayerFromDescription(descricao?: string | null): string | null {
  if (!descricao) return null;
  const raw = descricao.trim();
  const m1 = raw.match(
    /(?:TRF\.?\s*IMED\.?|TRANSF(?:ERENCIA)?(?:\s*IMED(?:IATA)?)?|TRF\s+CRED\s+(?:SEPA\+|INTRABANC)?)\s*DE\s+(.+?)(?:\s*[-–]\s*\d{5,}|\s*$)/i,
  );
  if (m1?.[1]) {
    const name = stripFracaoSuffix(m1[1]);
    if (name.length >= 3) return name;
  }
  const m2 = raw.match(/^DE\s+(.+?)(?:\s*[-–]\s*\d{5,})\s*$/i);
  if (m2?.[1]) {
    const name = stripFracaoSuffix(m2[1]);
    if (name.length >= 3) return name;
  }
  return null;
}

/** Remove sufixo «FRAÇÃO A» / «FRACAO 12B» do nome extraído do descritivo. */
function stripFracaoSuffix(raw: string): string {
  const noDa = raw.replace(/\s+DA\s*$/i, "").trim();
  const parts = normalizeIdentityText(noDa).split(" ").filter(Boolean);
  if (parts.length >= 3 && /^FRAC[A-Z0-9]*$/.test(parts[parts.length - 2]!)) {
    return parts.slice(0, -2).join(" ");
  }
  return noDa;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Bare-word match of fração codes shorter than this is too noisy
 * (e.g. "DE", "SE", "DA" inside SEPA descriptions). Shorter codes only
 * match with an explicit FRACAO/FRACÇÃO prefix.
 */
export const MIN_BARE_FRACAO_CODE_LENGTH = 3;

export function extractFracaoCodeFromDescription(
  descricao: string,
  knownCodes: string[],
): string | null {
  const norm = normalizeIdentityText(descricao);
  const ordered = [...knownCodes].sort((a, b) => b.length - a.length);
  for (const code of ordered) {
    const c = normalizeIdentityText(code);
    if (!c) continue;
    const token = escapeRegExp(c);
    const re = new RegExp(`(?:FRAC(?:A|AO)|FRACC?A?O|FRACAO)\\s+${token}\\b`);
    if (re.test(norm)) return code;
    if (c.length >= MIN_BARE_FRACAO_CODE_LENGTH && new RegExp(`\\b${token}\\b`).test(norm)) {
      return code;
    }
  }
  return null;
}

export async function loadTenantIdentity(
  deps: KernelDeps,
  tenantId: string,
): Promise<TenantIdentityRow[]> {
  const fracoes = await deps.db
    .select()
    .from(constitutionFracoes)
    .where(eq(constitutionFracoes.tenantId, tenantId));
  const contacts = await deps.db
    .select()
    .from(ownerContactDrafts)
    .where(
      and(
        eq(ownerContactDrafts.tenantId, tenantId),
        eq(ownerContactDrafts.status, EXTRACT_LINE_STATUS.confirmed),
      ),
    );

  return fracoes.map((f) => ({
    fracaoId: f.id,
    codigo: f.codigo,
    names: contacts
      .filter((c) => normalizeIdentityText(c.fracaoCodigo) === normalizeIdentityText(f.codigo))
      .map((c) => c.personName)
      .filter(Boolean),
  }));
}

function identityNameTokens(s: string): string[] {
  return normalizeIdentityText(s)
    .split(" ")
    .filter((t) => t.length >= 3);
}

/**
 * Nome do pagador vs contacto confirmado: igualdade exacta ou tokens completos.
 * Não usa substring bidireccional (ANA ⊄ MARIANA).
 */
export function identityNameMatches(payerName: string, storedName: string): boolean {
  const payer = normalizeIdentityText(payerName);
  const stored = normalizeIdentityText(storedName);
  if (payer.length < 3 || stored.length < 3) return false;
  if (payer === stored) return true;
  const payerTok = identityNameTokens(payerName);
  const storedTok = identityNameTokens(storedName);
  if (payerTok.length === 0 || storedTok.length === 0) return false;
  const storedSet = new Set(storedTok);
  return payerTok.every((t) => storedSet.has(t));
}

function uniqueNameHits(name: string, rows: TenantIdentityRow[]): TenantIdentityRow[] {
  const needle = normalizeIdentityText(name);
  if (needle.length < 3) return [];
  return rows.filter((r) => r.names.some((n) => identityNameMatches(name, n)));
}

/**
 * Liga movimento a Fração. Score ≥ 40 com nome ou código único → identificado.
 * Montante só reforça confiança; nunca aloca.
 */
export async function matchCandidateIdentity(
  deps: KernelDeps,
  input: {
    tenantId: string;
    description?: string | null;
    debtorName?: string | null;
    amountCents: number;
  },
): Promise<IdentityMatch> {
  const rows = await loadTenantIdentity(deps, input.tenantId);
  const extracted = extractPayerFromDescription(input.description);
  const rawPayer = (input.debtorName?.trim() || extracted || "").trim();
  const payerName = rawPayer ? stripFracaoSuffix(rawPayer) || rawPayer : null;
  const criteria: string[] = [];
  let fracao: TenantIdentityRow | null = null;
  let confidence = 0;

  if (payerName) {
    const hits = uniqueNameHits(payerName, rows);
    if (hits.length === 1) {
      fracao = hits[0]!;
      criteria.push("nome");
      confidence += 45;
    }
  }

  const code = extractFracaoCodeFromDescription(
    [input.description, payerName].filter(Boolean).join(" "),
    rows.map((r) => r.codigo),
  );
  if (code) {
    const byCode = rows.find((r) => normalizeIdentityText(r.codigo) === normalizeIdentityText(code));
    if (byCode && (!fracao || byCode.fracaoId === fracao.fracaoId)) {
      fracao = byCode;
      if (!criteria.includes("fracao_codigo")) {
        criteria.push("fracao_codigo");
        confidence += 30;
      }
    } else if (byCode && fracao && byCode.fracaoId !== fracao.fracaoId) {
      return {
        fracaoId: null,
        codigo: null,
        confidence: 0,
        criteria: ["colisao"],
        payerName,
      };
    }
  }

  if (fracao) {
    const open = await deps.db
      .select()
      .from(obligations)
      .where(and(eq(obligations.tenantId, input.tenantId), eq(obligations.fracaoId, fracao.fracaoId)));
    const openSum = open
      .filter((o) => o.status === "open" && o.openAmountCents > 0)
      .reduce((s, o) => s + o.openAmountCents, 0);
    if (openSum > 0 && openSum === input.amountCents) {
      criteria.push("montante");
      confidence += 15;
    }
  }

  const identified = Boolean(fracao) && confidence >= 40 && criteria.some((c) => c === "nome" || c === "fracao_codigo");
  return {
    fracaoId: identified ? fracao!.fracaoId : null,
    codigo: identified ? fracao!.codigo : null,
    confidence: identified ? Math.min(100, confidence) : Math.min(confidence, 39),
    criteria,
    payerName,
  };
}
