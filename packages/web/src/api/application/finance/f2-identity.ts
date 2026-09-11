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
    const name = m1[1].replace(/\s+DA\s*$/i, "").trim();
    if (name.length >= 3) return name;
  }
  const m2 = raw.match(/^DE\s+(.+?)(?:\s*[-–]\s*\d{5,})\s*$/i);
  if (m2?.[1] && m2[1].trim().length >= 3) return m2[1].trim();
  return null;
}

export function extractFracaoCodeFromDescription(
  descricao: string,
  knownCodes: string[],
): string | null {
  const norm = normalizeIdentityText(descricao);
  const ordered = [...knownCodes].sort((a, b) => b.length - a.length);
  for (const code of ordered) {
    const c = normalizeIdentityText(code);
    if (!c) continue;
    const re = new RegExp(`(?:FRAC(?:A|AO)|FRACC?A?O|FRACAO)\\s+${c}\\b`);
    if (re.test(norm)) return code;
    if (new RegExp(`\\b${c}\\b`).test(norm) && c.length >= 2) return code;
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

function uniqueNameHits(name: string, rows: TenantIdentityRow[]): TenantIdentityRow[] {
  const needle = normalizeIdentityText(name);
  if (needle.length < 3) return [];
  return rows.filter((r) =>
    r.names.some((n) => {
      const hay = normalizeIdentityText(n);
      return hay.includes(needle) || needle.includes(hay);
    }),
  );
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
  const payerName = (input.debtorName?.trim() || extracted || "").trim() || null;
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
