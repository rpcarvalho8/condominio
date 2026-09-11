/**
 * F1 — Ingestão + Constituição (vertical slice).
 * Prova: upload ≠ definitivo; confirmação linha a linha; Σ=1000‰; obligations do orçamento.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import * as schema from "./database/schema";
import {
  approveBudgetAndCreateObligations,
  confirmFracaoLines,
  createAnnualBudget,
  extractDocumentLines,
  listConstitutionFracoes,
  registerIngestDocument,
} from "./application/constitution/f1-constitution";
import { F1_MAX_UPLOAD_BYTES } from "./application/constitution/f1-upload-guard";
import {
  extractDocumentFromStoredContent,
  uploadIngestDocumentFile,
} from "./application/constitution/upload-and-extract";
import { DomainError } from "./domain/errors";
import { BUDGET_LINE_KINDS, INGEST_DOCUMENT_KINDS } from "./domain/constitution";
import { applyDomainKernelSchema } from "./infra/kernel-schema";
import { applyF1ConstitutionSchema } from "./infra/f1-schema";
import type { KernelDeps } from "./infra/kernel-deps";
import { createMembershipRepo } from "./infra/repos/membership-repo";
import { createPersonRepo } from "./infra/repos/person-repo";
import type { KernelAuthUser, KernelVariables } from "./middleware/membership";
import { createF1Routes } from "./routes/f1";

const DB_PATH = path.join(import.meta.dir, "..", "..", ".tmp-test-f1.db");
const BLOB_ROOT = path.join(import.meta.dir, "..", "..", ".tmp-test-f1-content");
process.env.CONTENT_BLOB_ROOT = BLOB_ROOT;

let client: ReturnType<typeof createClient>;
let deps: KernelDeps;
let f1App: Hono;
let currentUser: KernelAuthUser | null = null;
const TENANT = "tenant-f1";
const ADMIN_USER_ID = "user-f1-admin";

function buildF1App() {
  return new Hono<{ Variables: KernelVariables }>()
    .use(async (c, next) => {
      c.set("user", currentUser);
      await next();
    })
    .route("/f1", createF1Routes(deps));
}

function xlsxFracoes(rows: Array<[string, number]>): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([["codigo", "permilagem"], ...rows]);
  XLSX.utils.book_append_sheet(wb, ws, "fracoes");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
}

beforeAll(async () => {
  process.env.CONTENT_BLOB_ROOT = BLOB_ROOT;
  try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(BLOB_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  fs.mkdirSync(BLOB_ROOT, { recursive: true });
  client = createClient({ url: `file:${DB_PATH}` });
  await applyDomainKernelSchema(client);
  await applyF1ConstitutionSchema(client);
  const db = drizzle(client, { schema });
  deps = { db, getTenantId: () => TENANT };
  const personRepo = createPersonRepo(deps.db);
  const membershipRepo = createMembershipRepo(deps.db);
  const person = await personRepo.insert({
    id: crypto.randomUUID(),
    userId: ADMIN_USER_ID,
    name: "Admin F1",
    email: "admin-f1@example.test",
    createdAt: new Date(),
  });
  await membershipRepo.insert({
    id: crypto.randomUUID(),
    personId: person.id,
    tenantId: TENANT,
    roleCode: "Admin",
    createdAt: new Date(),
  });
  f1App = buildF1App();
});

beforeEach(async () => {
  for (const table of [
    "obligations",
    "annual_budget_lines",
    "annual_budgets",
    "constitution_fracoes",
    "extract_lines",
    "ingest_documents",
    "content_uploads",
    "outbox_jobs",
    "notification_deliveries",
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
  try {
    fs.rmSync(BLOB_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("F1 constituição", () => {
  test("extração sem excerto é rejeitada", async () => {
    const doc = await registerIngestDocument(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "regulamento.pdf",
    });
    expect(doc.status).toBe("uploaded");

    await expect(
      extractDocumentLines(deps, {
        tenantId: TENANT,
        documentId: doc.id,
        extraction: {
          lines: [
            {
              kind: "fracao",
              payload: { codigo: "A", permilagem: 1000 },
              sourceExcerpt: "",
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  test("confirmação exige Σ permilagens = 1000‰", async () => {
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
            payload: { codigo: "1A", permilagem: 400 },
            sourceExcerpt: "Fração 1A — 400‰",
          },
          {
            kind: "fracao",
            payload: { codigo: "1B", permilagem: 400 },
            sourceExcerpt: "Fração 1B — 400‰",
          },
        ],
      },
    });
    expect(lines).toHaveLength(2);

    await expect(
      confirmFracaoLines(deps, {
        tenantId: TENANT,
        documentId: doc.id,
        confirmations: lines.map((l) => ({ lineId: l.id })),
      }),
    ).rejects.toMatchObject({ code: "permilagem_sum" });
  });

  test("fluxo completo: confirmar frações + orçamento → obligations", async () => {
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
            payload: { codigo: "A", permilagem: 600 },
            sourceExcerpt: "A — 600‰",
          },
          {
            kind: "fracao",
            payload: { codigo: "B", permilagem: 400 },
            sourceExcerpt: "B — 400‰",
          },
        ],
      },
    });

    const confirmed = await confirmFracaoLines(deps, {
      tenantId: TENANT,
      documentId: doc.id,
      confirmations: lines.map((l) => ({ lineId: l.id })),
    });
    expect(confirmed.permilagemSum).toBe(1000);
    expect(confirmed.fracoes).toHaveLength(2);

    const fracoes = await listConstitutionFracoes(deps, { tenantId: TENANT });
    expect(fracoes.map((f) => f.codigo).sort()).toEqual(["A", "B"]);

    const budget = await createAnnualBudget(deps, {
      tenantId: TENANT,
      year: 2026,
      title: "Orçamento 2026",
      lines: [
        { kind: BUDGET_LINE_KINDS.quotaCorrente, label: "Quota corrente", amountCents: 12_000_000 },
        { kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 1_200_000 },
      ],
    });
    expect(budget.budget.status).toBe("draft");

    const approved = await approveBudgetAndCreateObligations(deps, {
      tenantId: TENANT,
      budgetId: budget.budget.id,
    });
    expect(approved.idempotent).toBe(false);
    expect(approved.obligations.length).toBe(4);

    const fracaoA = fracoes.find((f) => f.codigo === "A")!;
    const fracaoB = fracoes.find((f) => f.codigo === "B")!;
    const quotaA = approved.obligations.find(
      (o) => o.kind === BUDGET_LINE_KINDS.quotaCorrente && o.fracaoId === fracaoA.id,
    );
    const quotaB = approved.obligations.find(
      (o) => o.kind === BUDGET_LINE_KINDS.quotaCorrente && o.fracaoId === fracaoB.id,
    );
    expect(quotaA!.amountCents).toBe(7_200_000);
    expect(quotaB!.amountCents).toBe(4_800_000);
    expect(quotaA!.amountCents + quotaB!.amountCents).toBe(12_000_000);

    const again = await approveBudgetAndCreateObligations(deps, {
      tenantId: TENANT,
      budgetId: budget.budget.id,
    });
    expect(again.idempotent).toBe(true);
    expect(again.obligations.length).toBe(approved.obligations.length);
  });

  test("FCR < 10% da quota é rejeitado", async () => {
    await expect(
      createAnnualBudget(deps, {
        tenantId: TENANT,
        year: 2026,
        title: "Mau",
        lines: [
          { kind: BUDGET_LINE_KINDS.quotaCorrente, label: "Q", amountCents: 10_000 },
          { kind: BUDGET_LINE_KINDS.fcr, label: "F", amountCents: 500 },
        ],
      }),
    ).rejects.toMatchObject({ code: "fcr_too_low" });
  });

  test("upload CSV → extract-from-file → confirmar → obligations", async () => {
    const csv = [
      "codigo,permilagem",
      "A,600",
      "B,400",
      "",
    ].join("\n");
    const { document, contentHash } = await uploadIngestDocumentFile(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "fracoes.csv",
      bytes: Buffer.from(csv, "utf8"),
    });
    expect(document.contentHash).toBe(contentHash);
    expect(document.status).toBe("uploaded");

    const extracted = await extractDocumentFromStoredContent(deps, {
      tenantId: TENANT,
      documentId: document.id,
    });
    expect(extracted.lines).toHaveLength(2);
    expect(extracted.lines.every((l) => l.sourceExcerpt.includes("|"))).toBe(true);

    const confirmed = await confirmFracaoLines(deps, {
      tenantId: TENANT,
      documentId: document.id,
      confirmations: extracted.lines.map((l) => ({ lineId: l.id })),
    });
    expect(confirmed.permilagemSum).toBe(1000);

    const budget = await createAnnualBudget(deps, {
      tenantId: TENANT,
      year: 2027,
      title: "Orçamento 2027",
      lines: [
        { kind: BUDGET_LINE_KINDS.quotaCorrente, label: "Quota", amountCents: 1_000_000 },
        { kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 100_000 },
      ],
    });
    const approved = await approveBudgetAndCreateObligations(deps, {
      tenantId: TENANT,
      budgetId: budget.budget.id,
    });
    expect(approved.obligations.length).toBe(4);
  });

  test("upload Excel → extract-from-file produz frações", async () => {
    const { document } = await uploadIngestDocumentFile(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "fracoes.xlsx",
      bytes: xlsxFracoes([
        ["A", 550],
        ["B", 450],
      ]),
    });
    const extracted = await extractDocumentFromStoredContent(deps, {
      tenantId: TENANT,
      documentId: document.id,
    });
    expect(extracted.lines).toHaveLength(2);
    expect(
      extracted.lines
        .map((l) => JSON.parse(l.payloadJson) as { codigo: string })
        .map((p) => p.codigo)
        .sort(),
    ).toEqual(["A", "B"]);
  });

  test("upload texto com padrões ‰ → extract-from-file", async () => {
    const text = ["Fração A — 600‰", "Fração B — 400‰", ""].join("\n");
    const { document } = await uploadIngestDocumentFile(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "fracoes.txt",
      bytes: Buffer.from(text, "utf8"),
    });
    const extracted = await extractDocumentFromStoredContent(deps, {
      tenantId: TENANT,
      documentId: document.id,
    });
    expect(extracted.lines).toHaveLength(2);
    expect(extracted.lines.every((l) => l.sourceExcerpt.includes("‰"))).toBe(true);
  });

  test("extract-from-file duplicado → 409", async () => {
    const csv = ["codigo,permilagem", "A,1000", ""].join("\n");
    const { document } = await uploadIngestDocumentFile(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "uma.csv",
      bytes: Buffer.from(csv, "utf8"),
    });
    await extractDocumentFromStoredContent(deps, {
      tenantId: TENANT,
      documentId: document.id,
    });
    await expect(
      extractDocumentFromStoredContent(deps, {
        tenantId: TENANT,
        documentId: document.id,
      }),
    ).rejects.toMatchObject({ code: "already_extracted", httpStatus: 409 });
  });

  test("registerIngestDocument rejeita contentHash com path traversal", async () => {
    await expect(
      registerIngestDocument(deps, {
        tenantId: TENANT,
        kind: INGEST_DOCUMENT_KINDS.regulamento,
        filename: "x.csv",
        contentHash: "../../etc/passwd",
      }),
    ).rejects.toMatchObject({ code: "invalid_hash", httpStatus: 400 });
  });
});

describe("F1 HTTP upload guards", () => {
  test("Content-Length acima do máximo → 400 sem exigir body enorme", async () => {
    currentUser = { id: ADMIN_USER_ID, email: "admin-f1@example.test", name: "Admin F1" };
    const res = await f1App.request("/f1/documents/upload", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=----f1",
        "content-length": String(F1_MAX_UPLOAD_BYTES + 1),
      },
      body: "tiny",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { message: string };
    expect(json.message.toLowerCase()).toContain("grande");
  });

  test("PDF / tipo fora da allowlist → 400", async () => {
    currentUser = { id: ADMIN_USER_ID, email: "admin-f1@example.test", name: "Admin F1" };
    const form = new FormData();
    form.set("kind", INGEST_DOCUMENT_KINDS.regulamento);
    form.set("file", new File(["%PDF-1.4 fake"], "regulamento.pdf", { type: "application/pdf" }));
    const res = await f1App.request("/f1/documents/upload", { method: "POST", body: form });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { message: string };
    expect(json.message.toLowerCase()).toMatch(/tipo|csv|excel/);
  });

  test("CSV dentro do limite → 201", async () => {
    currentUser = { id: ADMIN_USER_ID, email: "admin-f1@example.test", name: "Admin F1" };
    const form = new FormData();
    form.set("kind", INGEST_DOCUMENT_KINDS.regulamento);
    form.set(
      "file",
      new File(["codigo,permilagem\nA,1000\n"], "fracoes.csv", { type: "text/csv" }),
    );
    const res = await f1App.request("/f1/documents/upload", { method: "POST", body: form });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { document: { filename: string; contentHash: string } };
    expect(json.document.filename).toBe("fracoes.csv");
    expect(json.document.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
