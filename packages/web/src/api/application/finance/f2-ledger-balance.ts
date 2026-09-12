/**
 * Reconstructs fraction saldo / dívidas from the Ledger.
 * Never Quota.pago. Never Obligation.openAmountCents as source of truth.
 *
 * SoT (02-DOMINIO): Σ Obligation.amountCents − Σ Ledger credits (+ adjustments).
 */
import { and, eq, inArray } from "drizzle-orm";
import { constitutionFracoes, ledgerEntries, obligations } from "../../database/schema";
import { LEDGER_ENTRY_TYPES } from "../../domain/finance";
import { DomainError } from "../../domain/errors";
import type { KernelDeps } from "../../infra/kernel-deps";

export type FracaoDebt = {
  obligationId: string;
  kind: string;
  periodYear: number;
  amountCents: number;
  allocatedCents: number;
  adjustmentCents: number;
  openCents: number;
  status: string;
};

export type FracaoLedgerBalance = {
  source: "ledger";
  tenantId: string;
  fracaoId: string;
  fracaoCodigo: string;
  permilagem: number;
  originalCents: number;
  allocatedCents: number;
  adjustmentCents: number;
  openCents: number;
  debts: FracaoDebt[];
};

function signedLedgerCents(direction: string | null, amountCents: number | null): number {
  const amount = amountCents ?? 0;
  if (direction === "debit") return -amount;
  return amount;
}

export async function reconstructFracaoBalance(
  deps: KernelDeps,
  input: { tenantId: string; fracaoId: string },
): Promise<FracaoLedgerBalance> {
  const tenantId = input.tenantId.trim();
  const fracaoId = input.fracaoId.trim();
  if (!tenantId) throw new DomainError("tenant_required", "tenant_id é obrigatório", 403);
  if (!fracaoId) throw new DomainError("fracao_required", "fracao_id é obrigatório", 400);

  const [fracao] = await deps.db
    .select()
    .from(constitutionFracoes)
    .where(and(eq(constitutionFracoes.id, fracaoId), eq(constitutionFracoes.tenantId, tenantId)))
    .limit(1);
  if (!fracao) {
    throw new DomainError("fracao_not_found", "Fração não encontrada neste tenant", 404);
  }

  const obs = await deps.db
    .select()
    .from(obligations)
    .where(and(eq(obligations.tenantId, tenantId), eq(obligations.fracaoId, fracaoId)));

  const obligationIds = obs.map((o) => o.id);
  const entries =
    obligationIds.length === 0
      ? []
      : await deps.db
          .select()
          .from(ledgerEntries)
          .where(
            and(eq(ledgerEntries.tenantId, tenantId), inArray(ledgerEntries.obligationId, obligationIds)),
          );

  const allocatedByOb = new Map<string, number>();
  const adjustmentByOb = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.obligationId) continue;
    const signed = signedLedgerCents(entry.direction, entry.amountCents);
    if (entry.entryType === LEDGER_ENTRY_TYPES.allocation) {
      allocatedByOb.set(entry.obligationId, (allocatedByOb.get(entry.obligationId) ?? 0) + signed);
    } else if (entry.entryType === LEDGER_ENTRY_TYPES.adjustment) {
      adjustmentByOb.set(entry.obligationId, (adjustmentByOb.get(entry.obligationId) ?? 0) + signed);
    }
  }

  const debts: FracaoDebt[] = obs
    .map((o) => {
      const allocatedCents = allocatedByOb.get(o.id) ?? 0;
      const adjustmentCents = adjustmentByOb.get(o.id) ?? 0;
      const openCents = o.amountCents - allocatedCents + adjustmentCents;
      return {
        obligationId: o.id,
        kind: o.kind,
        periodYear: o.periodYear,
        amountCents: o.amountCents,
        allocatedCents,
        adjustmentCents,
        openCents,
        status: openCents <= 0 ? "settled" : "open",
      };
    })
    .sort((a, b) => a.periodYear - b.periodYear || a.kind.localeCompare(b.kind));

  const originalCents = debts.reduce((s, d) => s + d.amountCents, 0);
  const allocatedCents = debts.reduce((s, d) => s + d.allocatedCents, 0);
  const adjustmentCents = debts.reduce((s, d) => s + d.adjustmentCents, 0);
  const openCents = debts.reduce((s, d) => s + d.openCents, 0);

  return {
    source: "ledger",
    tenantId,
    fracaoId: fracao.id,
    fracaoCodigo: fracao.codigo,
    permilagem: fracao.permilagem,
    originalCents,
    allocatedCents,
    adjustmentCents,
    openCents,
    debts,
  };
}
