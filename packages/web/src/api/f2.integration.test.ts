/**
 * F2 — Financeiro / Ledger (vertical slice).
 * Prova: cash 3 estados; allocate só após verified; hash-chain; recibo com generated_from.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./database/schema";
import {
  approveBudgetAndCreateObligations,
  confirmFracaoLines,
  createAnnualBudget,
  extractDocumentLines,
  listConstitutionFracoes,
  registerIngestDocument,
} from "./application/constitution/f1-constitution";
import {
  allocatePayment,
  depositCashPayment,
  issueReceiptForPayment,
  registerPayment,
  validateLedgerChain,
  verifyCashPayment,
} from "./application/finance/f2-finance";
import { BUDGET_LINE_KINDS, INGEST_DOCUMENT_KINDS } from "./domain/constitution";
import {
  ALLOCATION_STATUS,
  CASH_STATUS,
  PAYMENT_METHODS,
  VERIFICATION_METHOD,
} from "./domain/finance";
import { DomainError } from "./domain/errors";
import { applyDomainKernelSchema } from "./infra/kernel-schema";
import { applyF1ConstitutionSchema } from "./infra/f1-schema";
import { applyF2FinanceSchema } from "./infra/f2-schema";
import type { KernelDeps } from "./infra/kernel-deps";

const DB_PATH = path.join(import.meta.dir, "..", "..", ".tmp-test-f2.db");

let client: ReturnType<typeof createClient>;
let deps: KernelDeps;
const TENANT = "tenant-f2";

async function seedFracaoWithObligations() {
  const doc = await registerIngestDocument(deps, {
    tenantId: TENANT,
    kind: INGEST_DOCUMENT_KINDS.regulamento,
    filename: "regulamento.pdf",
  });
  const { lines } = await extractDocumentLines(deps, {
    tenantId: TENANT,
    documentId: doc.id,
    extraction: {
      lines: [
        {
          kind: "fracao",
          payload: { codigo: "A", permilagem: 1000 },
          sourceExcerpt: "A — 1000‰",
        },
      ],
    },
  });
  await confirmFracaoLines(deps, {
    tenantId: TENANT,
    documentId: doc.id,
    confirmations: lines.map((l) => ({ lineId: l.id })),
  });
  const fracoes = await listConstitutionFracoes(deps, { tenantId: TENANT });
  const budget = await createAnnualBudget(deps, {
    tenantId: TENANT,
    year: 2026,
    title: "Orçamento 2026",
    lines: [
      { kind: BUDGET_LINE_KINDS.quotaCorrente, label: "Quota", amountCents: 10_000_00 },
      { kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 1_000_00 },
    ],
  });
  const approved = await approveBudgetAndCreateObligations(deps, {
    tenantId: TENANT,
    budgetId: budget.budget.id,
  });
  return { fracao: fracoes[0]!, obligations: approved.obligations };
}

beforeAll(async () => {
  try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  } catch {
    /* ignore */
  }
  client = createClient({ url: `file:${DB_PATH}` });
  await applyDomainKernelSchema(client);
  await applyF1ConstitutionSchema(client);
  await applyF2FinanceSchema(client);
  const db = drizzle(client, { schema });
  deps = { db, getTenantId: () => TENANT };
});

beforeEach(async () => {
  for (const table of [
    "financial_documents",
    "allocations",
    "ledger_entries",
    "tenant_ledger_integrity",
    "payments",
    "settlement_policies",
    "accounting_periods",
    "obligations",
    "annual_budget_lines",
    "annual_budgets",
    "constitution_fracoes",
    "extract_lines",
    "ingest_documents",
    "audit_events",
    "domain_events",
  ]) {
    await client.execute(`DELETE FROM ${table}`);
  }
});

afterAll(() => {
  try {
    client.close();
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  } catch {
    /* ignore */
  }
});

describe("F2 financeiro / ledger", () => {
  test("cash exige evidência e não aloca em registered", async () => {
    const { fracao } = await seedFracaoWithObligations();

    await expect(
      registerPayment(deps, {
        tenantId: TENANT,
        fracaoId: fracao.id,
        amountCents: 5_000,
        paymentMethod: PAYMENT_METHODS.cash,
      }),
    ).rejects.toMatchObject({ code: "cash_evidence_required" });

    const payment = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 5_000,
      paymentMethod: PAYMENT_METHODS.cash,
      evidenceUploadId: "upload-cash-1",
      actor: { personId: "admin-1" },
    });
    expect(payment.cashStatus).toBe(CASH_STATUS.registered);

    await expect(
      allocatePayment(deps, { tenantId: TENANT, paymentId: payment.id }),
    ).rejects.toMatchObject({ code: "cash_not_verified" });
  });

  test("second_person: registante ≠ verificador; allocate + hash-chain + recibo", async () => {
    const { fracao } = await seedFracaoWithObligations();

    const payment = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 50_000,
      paymentMethod: PAYMENT_METHODS.cash,
      evidenceUploadId: "upload-cash-2",
      actor: { personId: "admin-1" },
    });

    await expect(
      verifyCashPayment(deps, {
        tenantId: TENANT,
        paymentId: payment.id,
        verificationMethod: VERIFICATION_METHOD.secondPerson,
        actor: { personId: "admin-1" },
      }),
    ).rejects.toMatchObject({ code: "self_verify_forbidden" });

    const verified = await verifyCashPayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
      verificationMethod: VERIFICATION_METHOD.secondPerson,
      actor: { personId: "fiscal-2" },
    });
    expect(verified.cashStatus).toBe(CASH_STATUS.verified);

    const deposited = await depositCashPayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
      bankMovementId: "bm-1",
      actor: { personId: "admin-1" },
    });
    expect(deposited.cashStatus).toBe(CASH_STATUS.deposited);

    const result = await allocatePayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
      actor: { personId: "admin-1" },
    });
    expect(result.idempotent).toBe(false);
    expect(result.allocations.length).toBeGreaterThan(0);
    expect(result.payment.allocationStatus).toBe(ALLOCATION_STATUS.totalmenteAlocado);

    const chain = await validateLedgerChain(deps, { tenantId: TENANT });
    expect(chain.ok).toBe(true);
    expect(chain.entries).toBeGreaterThanOrEqual(2); // genesis + ≥1 allocation

    const receipt = await issueReceiptForPayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
    });
    expect(receipt.docType).toBe("Receipt");
    const generatedFrom = JSON.parse(receipt.generatedFromJson) as {
      paymentId: string;
      allocationIds: string[];
    };
    expect(generatedFrom.paymentId).toBe(payment.id);
    expect(generatedFrom.allocationIds.length).toBe(result.allocations.length);

    const again = await allocatePayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
    });
    expect(again.idempotent).toBe(true);
  });

  test("transferência aloca directamente e cadeia detecta adulteração", async () => {
    const { fracao } = await seedFracaoWithObligations();

    const payment = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 20_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
      actor: { personId: "admin-1" },
    });
    expect(payment.cashStatus).toBeNull();

    const result = await allocatePayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
    });
    expect(result.allocations.length).toBeGreaterThan(0);

    const ok = await validateLedgerChain(deps, { tenantId: TENANT });
    expect(ok.ok).toBe(true);

    // Adulterar payload de uma entrada de allocation
    const tip = await client.execute(
      `SELECT id, payload_json FROM ledger_entries WHERE tenant_id = ? AND entry_type = 'allocation' LIMIT 1`,
      [TENANT],
    );
    const row = tip.rows[0]!;
    await client.execute({
      sql: `UPDATE ledger_entries SET payload_json = ? WHERE id = ?`,
      args: ['{"tampered":true}', String(row.id)],
    });

    const broken = await validateLedgerChain(deps, { tenantId: TENANT });
    expect(broken.ok).toBe(false);

    await expect(
      registerPayment(deps, {
        tenantId: TENANT,
        fracaoId: fracao.id,
        amountCents: 1_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      }),
    ).rejects.toMatchObject({ code: "ledger_chain_broken" });
  });

  test("recibo vazio é rejeitado", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const payment = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 1_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
    });
    await expect(
      issueReceiptForPayment(deps, { tenantId: TENANT, paymentId: payment.id }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
