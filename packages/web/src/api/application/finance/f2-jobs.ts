/**
 * Jobs F2: avisos dia 1 + recibos na confirmação de Allocation (calendário/sweep).
 * Reutiliza issuePaymentNotice / issueReceiptForPayment — não duplica documentos.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  constitutionFracoes,
  financialDocuments,
  obligations,
  payments,
} from "../../database/schema";
import { ALLOCATION_STATUS, FINANCIAL_DOC_TYPES } from "../../domain/finance";
import { OUTBOX_JOB_TYPES } from "../../domain/outbox";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createOutboxRepo } from "../../infra/repos/outbox-repo";
import { sweepBankReauthNotices } from "./f2-bank-connection";
import { issuePaymentNotice, issueReceiptForPayment } from "./f2-finance";

type Actor = {
  personId?: string | null;
  userId?: string | null;
  requestId?: string | null;
};

export function periodLabelFrom(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function isCalendarDay1(now: Date): boolean {
  return now.getUTCDate() === 1;
}

export async function enqueueReceiptForPaymentJob(
  deps: KernelDeps,
  input: { tenantId: string; paymentId: string; correlationId?: string | null },
) {
  return createOutboxRepo(deps.db).enqueue({
    tenantId: input.tenantId,
    jobType: OUTBOX_JOB_TYPES.issueReceipt,
    idempotencyKey: `f2:receipt:${input.tenantId}:${input.paymentId}`,
    payload: { paymentId: input.paymentId },
    correlationId: input.correlationId ?? null,
    availableAt: kernelNow(deps),
  });
}

export async function generateMonthlyPaymentNotices(
  deps: KernelDeps,
  input: { tenantId: string; actor?: Actor; force?: boolean },
) {
  const now = kernelNow(deps);
  if (!input.force && !isCalendarDay1(now)) {
    return {
      skipped: true as const,
      reason: "not_day_1",
      periodLabel: periodLabelFrom(now),
      issued: [] as string[],
    };
  }

  const periodLabel = periodLabelFrom(now);
  const fracoes = await deps.db
    .select()
    .from(constitutionFracoes)
    .where(eq(constitutionFracoes.tenantId, input.tenantId));

  const issued: string[] = [];
  const reused: string[] = [];
  const empty: string[] = [];

  for (const fracao of fracoes) {
    const existing = await deps.db
      .select({ id: financialDocuments.id })
      .from(financialDocuments)
      .where(
        and(
          eq(financialDocuments.tenantId, input.tenantId),
          eq(financialDocuments.fracaoId, fracao.id),
          eq(financialDocuments.docType, FINANCIAL_DOC_TYPES.paymentNotice),
          eq(financialDocuments.periodLabel, periodLabel),
        ),
      )
      .limit(1);
    if (existing[0]) {
      reused.push(existing[0].id);
      continue;
    }

    const obs = await deps.db
      .select()
      .from(obligations)
      .where(
        and(
          eq(obligations.tenantId, input.tenantId),
          eq(obligations.fracaoId, fracao.id),
          eq(obligations.status, "open"),
        ),
      );
    const open = obs.filter((o) => o.openAmountCents > 0);
    if (open.length === 0) {
      empty.push(fracao.id);
      continue;
    }

    const amountCents = open.reduce((s, o) => s + o.amountCents, 0);
    try {
      const doc = await issuePaymentNotice(deps, {
        tenantId: input.tenantId,
        fracaoId: fracao.id,
        amountCents,
        periodLabel,
        obligationIds: open.map((o) => o.id),
        actor: input.actor,
      });
      issued.push(doc.id);
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
      if (msg.includes("unique") || msg.includes("constraint")) {
        const [again] = await deps.db
          .select({ id: financialDocuments.id })
          .from(financialDocuments)
          .where(
            and(
              eq(financialDocuments.tenantId, input.tenantId),
              eq(financialDocuments.fracaoId, fracao.id),
              eq(financialDocuments.docType, FINANCIAL_DOC_TYPES.paymentNotice),
              eq(financialDocuments.periodLabel, periodLabel),
            ),
          )
          .limit(1);
        if (again) reused.push(again.id);
        else throw err;
        continue;
      }
      throw err;
    }
  }

  return {
    skipped: false as const,
    periodLabel,
    issued,
    reused,
    empty,
  };
}

export async function sweepReceiptsForAllocatedPayments(
  deps: KernelDeps,
  input: { tenantId: string; actor?: Actor },
) {
  const allocated = await deps.db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.tenantId, input.tenantId),
        inArray(payments.allocationStatus, [
          ALLOCATION_STATUS.parcialmenteAlocado,
          ALLOCATION_STATUS.totalmenteAlocado,
        ]),
      ),
    );

  const issued: string[] = [];
  const reused: string[] = [];
  for (const payment of allocated) {
    const [existing] = await deps.db
      .select({ id: financialDocuments.id })
      .from(financialDocuments)
      .where(
        and(
          eq(financialDocuments.tenantId, input.tenantId),
          eq(financialDocuments.docType, FINANCIAL_DOC_TYPES.receipt),
          eq(financialDocuments.sourcePaymentId, payment.id),
        ),
      )
      .limit(1);
    if (existing) {
      reused.push(existing.id);
      continue;
    }
    const doc = await issueReceiptForPayment(deps, {
      tenantId: input.tenantId,
      paymentId: payment.id,
      actor: input.actor,
    });
    issued.push(doc.id);
  }
  return { issued, reused, scanned: allocated.length };
}

export async function enqueueMonthlyNoticeJob(
  deps: KernelDeps,
  input: { tenantId: string; correlationId?: string | null },
) {
  const now = kernelNow(deps);
  const period = periodLabelFrom(now);
  return createOutboxRepo(deps.db).enqueue({
    tenantId: input.tenantId,
    jobType: OUTBOX_JOB_TYPES.generateMonthlyPaymentNotices,
    idempotencyKey: `f2:notices:${input.tenantId}:${period}`,
    payload: { periodLabel: period },
    correlationId: input.correlationId ?? null,
    availableAt: now,
  });
}

/**
 * Calendário F2: reauth + avisos dia 1 + sweep de recibos.
 */
export async function runF2CalendarSweep(
  deps: KernelDeps,
  input: { tenantId: string; actor?: Actor; forceNotices?: boolean },
) {
  const reauth = await sweepBankReauthNotices(deps, input);
  const notices = await generateMonthlyPaymentNotices(deps, {
    tenantId: input.tenantId,
    actor: input.actor,
    force: input.forceNotices,
  });
  const receipts = await sweepReceiptsForAllocatedPayments(deps, input);
  return { reauth, notices, receipts, at: kernelNow(deps).toISOString() };
}
