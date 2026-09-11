import { Hono } from "hono";
import {
  allocatePayment,
  closeAccountingPeriod,
  depositCashPayment,
  issuePaymentNotice,
  issueReceiptForPayment,
  openAccountingPeriod,
  registerPayment,
  validateLedgerChain,
  verifyCashPayment,
} from "../application/finance/f2-finance";
import {
  ingestCandidateMovements,
  ingestCandidatesFromCsv,
} from "../application/finance/f2-candidates";
import {
  listBankConnections,
  sweepBankReauthNotices,
  upsertBankConnection,
} from "../application/finance/f2-bank-connection";
import {
  generateMonthlyPaymentNotices,
  runF2CalendarSweep,
  sweepReceiptsForAllocatedPayments,
} from "../application/finance/f2-jobs";
import { processOutbox } from "../application/jobs/process-outbox";
import { DomainError } from "../domain/errors";
import type { KernelDeps } from "../infra/kernel-deps";
import {
  createRequireActiveMembership,
  createRequireCashVerifier,
  createRequireFinanceManager,
  type KernelVariables,
} from "../middleware/membership";

function requestIdFrom(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header("x-request-id")?.trim() || crypto.randomUUID();
}

function httpError(err: unknown): { message: string; status: 400 | 403 | 404 | 409 | 500 } {
  if (err instanceof DomainError) {
    const status = err.httpStatus;
    if (status === 400 || status === 403 || status === 404 || status === 409) {
      return { message: err.message, status };
    }
  }
  console.error("[f2]", err);
  return { message: "Erro interno", status: 500 };
}

function actorFrom(c: {
  get: (k: string) => unknown;
  req: { header: (n: string) => string | undefined };
}) {
  const person = c.get("person") as { id?: string } | null;
  const user = c.get("user") as { id?: string } | null;
  return {
    personId: person?.id ?? null,
    userId: user?.id ?? null,
    requestId: requestIdFrom(c),
  };
}

/**
 * F2 — Financeiro / Ledger.
 * Gestor: registar / depositar / alocar / documentos.
 * verify-cash: Fiscalizacao ou gestor (ADR-028 / ADR-031).
 */
export function createF2Routes(deps: KernelDeps) {
  const requireMembership = createRequireActiveMembership(deps);
  const requireManager = createRequireFinanceManager();
  const requireCashVerifier = createRequireCashVerifier();

  return new Hono<{ Variables: KernelVariables }>()
    .use(requireMembership)
    .post("/payments", requireManager, async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          fracaoId?: string | null;
          amountCents?: number;
          paymentMethod?: string;
          payerReference?: string | null;
          evidenceUploadId?: string | null;
          bankMovementId?: string | null;
        };
        if (!body.amountCents || !body.paymentMethod) {
          return c.json({ message: "amountCents e paymentMethod são obrigatórios" }, 400);
        }
        const payment = await registerPayment(deps, {
          tenantId: c.get("tenantId")!,
          fracaoId: body.fracaoId,
          amountCents: body.amountCents,
          paymentMethod: body.paymentMethod,
          payerReference: body.payerReference,
          evidenceUploadId: body.evidenceUploadId,
          bankMovementId: body.bankMovementId,
          actor: actorFrom(c),
        });
        return c.json(payment, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/payments/:id/verify-cash", requireCashVerifier, async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          verificationMethod?: string;
          bankMovementId?: string | null;
        };
        if (!body.verificationMethod) {
          return c.json({ message: "verificationMethod é obrigatório" }, 400);
        }
        const payment = await verifyCashPayment(deps, {
          tenantId: c.get("tenantId")!,
          paymentId: c.req.param("id"),
          verificationMethod: body.verificationMethod,
          bankMovementId: body.bankMovementId,
          actor: actorFrom(c),
        });
        return c.json(payment);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/payments/:id/deposit-cash", requireManager, async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          bankMovementId?: string | null;
        };
        const payment = await depositCashPayment(deps, {
          tenantId: c.get("tenantId")!,
          paymentId: c.req.param("id"),
          bankMovementId: body.bankMovementId,
          actor: actorFrom(c),
        });
        return c.json(payment);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/payments/:id/allocate", requireManager, async (c) => {
      try {
        const result = await allocatePayment(deps, {
          tenantId: c.get("tenantId")!,
          paymentId: c.req.param("id"),
          actor: actorFrom(c),
        });
        return c.json(result);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/payments/:id/receipt", requireManager, async (c) => {
      try {
        const doc = await issueReceiptForPayment(deps, {
          tenantId: c.get("tenantId")!,
          paymentId: c.req.param("id"),
          actor: actorFrom(c),
        });
        return c.json(doc, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/ledger/validate", requireManager, async (c) => {
      try {
        const result = await validateLedgerChain(deps, {
          tenantId: c.get("tenantId")!,
          actor: actorFrom(c),
        });
        return c.json(result);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/periods/open", requireManager, async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          year?: number;
          month?: number;
        };
        if (!body.year || !body.month) {
          return c.json({ message: "year e month são obrigatórios" }, 400);
        }
        const period = await openAccountingPeriod(deps, {
          tenantId: c.get("tenantId")!,
          year: body.year,
          month: body.month,
          actor: actorFrom(c),
        });
        return c.json(period, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/periods/close", requireManager, async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          year?: number;
          month?: number;
        };
        if (!body.year || !body.month) {
          return c.json({ message: "year e month são obrigatórios" }, 400);
        }
        const result = await closeAccountingPeriod(deps, {
          tenantId: c.get("tenantId")!,
          year: body.year,
          month: body.month,
          actor: actorFrom(c),
        });
        return c.json(result);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/documents/payment-notice", requireManager, async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          fracaoId?: string;
          amountCents?: number;
          periodLabel?: string;
          obligationIds?: string[];
        };
        if (!body.fracaoId || !body.amountCents || !body.periodLabel || !body.obligationIds) {
          return c.json(
            { message: "fracaoId, amountCents, periodLabel e obligationIds são obrigatórios" },
            400,
          );
        }
        const doc = await issuePaymentNotice(deps, {
          tenantId: c.get("tenantId")!,
          fracaoId: body.fracaoId,
          amountCents: body.amountCents,
          periodLabel: body.periodLabel,
          obligationIds: body.obligationIds,
          actor: actorFrom(c),
        });
        return c.json(doc, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/bank-connections", requireManager, async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          provider?: string;
          aspsp?: string | null;
          accountIban?: string | null;
          consentStatus?: string;
          consentValidUntil?: string | null;
          authorizedByMembershipId?: string | null;
        };
        const row = await upsertBankConnection(deps, {
          tenantId: c.get("tenantId")!,
          provider: body.provider,
          aspsp: body.aspsp,
          accountIban: body.accountIban,
          consentStatus: body.consentStatus,
          consentValidUntil: body.consentValidUntil,
          authorizedByMembershipId: body.authorizedByMembershipId,
          actor: actorFrom(c),
        });
        return c.json(row, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .get("/bank-connections", requireManager, async (c) => {
      try {
        const rows = await listBankConnections(deps, c.get("tenantId")!);
        return c.json({ connections: rows });
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/payments/candidates", requireManager, async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          csvText?: string;
          movements?: Array<{
            amountCents?: number;
            description?: string | null;
            debtorName?: string | null;
            counterpartyIban?: string | null;
            externalRef?: string | null;
            bookedAt?: string | null;
            source?: string;
          }>;
        };
        const tenantId = c.get("tenantId")!;
        const actor = actorFrom(c);
        if (body.csvText) {
          const result = await ingestCandidatesFromCsv(deps, {
            tenantId,
            csvText: body.csvText,
            actor,
          });
          return c.json(result, 201);
        }
        const movements = (body.movements ?? [])
          .filter((m) => Number.isInteger(m.amountCents) && (m.amountCents ?? 0) > 0)
          .map((m) => ({
            amountCents: m.amountCents!,
            description: m.description,
            debtorName: m.debtorName,
            counterpartyIban: m.counterpartyIban,
            externalRef: m.externalRef,
            bookedAt: m.bookedAt,
            source: m.source as "csv" | "reconciliation" | "identity_matrix" | "manual" | undefined,
          }));
        if (movements.length === 0) {
          return c.json({ message: "csvText ou movements[] com amountCents é obrigatório" }, 400);
        }
        const result = await ingestCandidateMovements(deps, { tenantId, movements, actor });
        return c.json(result, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/jobs/reauth-notices", requireManager, async (c) => {
      try {
        const result = await sweepBankReauthNotices(deps, {
          tenantId: c.get("tenantId")!,
          actor: actorFrom(c),
        });
        await processOutbox(deps);
        return c.json(result);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/jobs/monthly-notices", requireManager, async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as { force?: boolean };
        const result = await generateMonthlyPaymentNotices(deps, {
          tenantId: c.get("tenantId")!,
          actor: actorFrom(c),
          force: body.force,
        });
        return c.json(result);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/jobs/receipt-sweep", requireManager, async (c) => {
      try {
        const result = await sweepReceiptsForAllocatedPayments(deps, {
          tenantId: c.get("tenantId")!,
          actor: actorFrom(c),
        });
        return c.json(result);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/jobs/calendar-sweep", requireManager, async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as { forceNotices?: boolean };
        const result = await runF2CalendarSweep(deps, {
          tenantId: c.get("tenantId")!,
          actor: actorFrom(c),
          forceNotices: body.forceNotices,
        });
        await processOutbox(deps);
        return c.json(result);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    });
}
