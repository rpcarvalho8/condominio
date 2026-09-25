/**
 * F1 — Ingestão + Constituição (vertical slice).
 * Prova: upload ≠ definitivo; confirmação linha a linha; Σ permilagem_centesimas = 100000; obligations do orçamento.
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
  confirmContactLines,
  confirmFracaoLines,
  createAnnualBudget,
  editExtractLine,
  isUniqueCodigoConstraint,
  extractDocumentLines,
  listConstitutionFracoes,
  listExtractLines,
  listIngestDocuments,
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
const OWNER_USER_ID = "user-f1-owner";

function fakePdf(text: string): Buffer {
  return Buffer.from(`%PDF-1.4\nBT (${text}) Tj ET\n${text}\n%%EOF\n`, "utf8");
}

function fakeJpeg(text: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
    Buffer.from(`\n${text}\n`, "utf8"),
    Buffer.from([0xff, 0xd9]),
  ]);
}

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
  const owner = await personRepo.insert({
    id: crypto.randomUUID(),
    userId: OWNER_USER_ID,
    name: "Owner F1",
    email: "owner-f1@example.test",
    createdAt: new Date(),
  });
  await membershipRepo.insert({
    id: crypto.randomUUID(),
    personId: owner.id,
    tenantId: TENANT,
    roleCode: "Owner",
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
    "owner_contact_drafts",
    "condo_iban_proofs",
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

  test("confirmação exige Σ permilagem_centesimas = 100000", async () => {
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
    expect(confirmed.permilagemSum).toBe(100000);
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

  test("resto F2 é determinístico na colação BINARY, com uma fracção e com resto zero", async () => {
    // ORDER BY codigo ASC, colação BINARY: 10, 1A, 9, AA, B, a. O resto vai para "a".
    const codes = ["10", "9", "1A", "AA", "B", "a"];
    const shares: Record<string, number> = {
      "10": 1,
      "1A": 10,
      "9": 100,
      AA: 1000,
      B: 10000,
      a: 88889,
    };

    async function centsByCodigo(
      insertOrder: string[],
      quota: Record<string, number>,
      amountCents: number,
    ): Promise<Record<string, number>> {
      for (const table of [
        "obligations",
        "annual_budget_lines",
        "annual_budgets",
        "constitution_fracoes",
        "extract_lines",
        "ingest_documents",
      ]) {
        await client.execute(`DELETE FROM ${table}`);
      }
      const doc = await registerIngestDocument(deps, {
        tenantId: TENANT,
        kind: INGEST_DOCUMENT_KINDS.regulamento,
        filename: "resto.pdf",
      });
      const { lines } = await extractDocumentLines(deps, {
        tenantId: TENANT,
        documentId: doc.id,
        extraction: {
          lines: insertOrder.map((codigo) => ({
            kind: "fracao",
            payload: { codigo, permilagem_centesimas: quota[codigo] },
            sourceExcerpt: `${codigo} — quota`,
          })),
        },
      });
      const lineIdByCodigo = new Map(
        lines.map((line) => {
          const payload = JSON.parse(line.payloadJson) as { codigo: string };
          return [payload.codigo, line.id] as const;
        }),
      );
      await confirmFracaoLines(deps, {
        tenantId: TENANT,
        documentId: doc.id,
        confirmations: insertOrder.map((codigo) => ({ lineId: lineIdByCodigo.get(codigo)! })),
      });
      const fcr = Math.max(1, Math.ceil(amountCents * 0.1));
      const budget = await createAnnualBudget(deps, {
        tenantId: TENANT,
        year: 2027,
        title: "Resto",
        lines: [
          { kind: BUDGET_LINE_KINDS.quotaCorrente, label: "Q", amountCents },
          { kind: BUDGET_LINE_KINDS.fcr, label: "F", amountCents: fcr },
        ],
      });
      const approved = await approveBudgetAndCreateObligations(deps, {
        tenantId: TENANT,
        budgetId: budget.budget.id,
      });
      const fracoes = await listConstitutionFracoes(deps, { tenantId: TENANT });
      const idToCodigo = new Map(fracoes.map((f) => [f.id, f.codigo]));
      const out: Record<string, number> = {};
      for (const obligation of approved.obligations) {
        if (obligation.kind !== BUDGET_LINE_KINDS.quotaCorrente) continue;
        const codigo = idToCodigo.get(obligation.fracaoId);
        if (codigo) out[codigo] = obligation.amountCents;
      }
      return out;
    }

    const expected = { "10": 0, "1A": 0, "9": 0, AA: 0, B: 1, a: 9 };
    const firstOrder = await centsByCodigo(codes, shares, 10);
    const reversed = await centsByCodigo([...codes].reverse(), shares, 10);
    expect(firstOrder).toEqual(expected);
    expect(reversed).toEqual(firstOrder);

    const alone = await centsByCodigo(["Z"], { Z: 100000 }, 12345);
    expect(alone).toEqual({ Z: 12345 });

    const even = { A: 50000, B: 50000 };
    const zeroA = await centsByCodigo(["B", "A"], even, 100);
    const zeroB = await centsByCodigo(["A", "B"], even, 100);
    expect(zeroA).toEqual({ A: 50, B: 50 });
    expect(zeroB).toEqual(zeroA);
  });

  async function insertLegacyFracao(id: string, codigo: string, permilagem: number) {
    await client.execute({
      sql: `INSERT INTO constitution_fracoes (
        id, tenant_id, codigo, tipo, permilagem, permilagem_centesimas,
        source_excerpt, status, created_at, confirmed_at
      ) VALUES (?, ?, ?, 'fracao', ?, NULL, 'legado', 'confirmed', 1, 1)`,
      args: [id, TENANT, codigo, permilagem],
    });
  }

  test("constituição anterior a 0011: aprovar sem centésimas pede reconfirmação", async () => {
    await insertLegacyFracao("legacy-e", "E", 3);
    await insertLegacyFracao("legacy-m", "M", 40);
    const budget = await createAnnualBudget(deps, {
      tenantId: TENANT,
      year: 2026,
      title: "Legado",
      lines: [
        { kind: BUDGET_LINE_KINDS.quotaCorrente, label: "Q", amountCents: 10_000 },
        { kind: BUDGET_LINE_KINDS.fcr, label: "F", amountCents: 1_000 },
      ],
    });
    const failed = await approveBudgetAndCreateObligations(deps, {
      tenantId: TENANT,
      budgetId: budget.budget.id,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failed).toBeInstanceOf(DomainError);
    const domain = failed as DomainError;
    expect(domain.code).toBe("permilagem_centesimas_missing");
    expect(domain.message).toContain("E");
    expect(domain.message).toContain("M");
    expect(domain.message).toMatch(/0011/);
    expect(domain.message.toLowerCase()).toMatch(/reconfirm/);
    expect(domain.message.toLowerCase()).toMatch(/regulamento/);
    const still = await listConstitutionFracoes(deps, { tenantId: TENANT });
    expect(still.map((f) => f.id).sort()).toEqual(["legacy-e", "legacy-m"]);
    expect(still.every((f) => f.permilagemCentesimas == null)).toBe(true);
  });

  test("reconfirmação completa centésimas no mesmo id e o orçamento aprova", async () => {
    await insertLegacyFracao("legacy-e", "E", 961);
    await insertLegacyFracao("legacy-m", "M", 40);
    const doc = await registerIngestDocument(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "reconfirmacao.pdf",
    });
    const { lines } = await extractDocumentLines(deps, {
      tenantId: TENANT,
      documentId: doc.id,
      extraction: {
        lines: [
          {
            kind: "fracao",
            payload: {
              codigo: "M",
              permilagem: 39,
              evidence: [
                { field: "permilagem", originalText: "38,80", transform: "identity_permille" },
              ],
            },
            sourceExcerpt: "M — 38,80",
          },
          {
            kind: "fracao",
            payload: { codigo: "E", permilagem_centesimas: 96120 },
            sourceExcerpt: "E — 961,20",
          },
        ],
      },
    });
    const confirmed = await confirmFracaoLines(deps, {
      tenantId: TENANT,
      documentId: doc.id,
      confirmations: lines.map((line) => ({ lineId: line.id })),
    });
    expect(confirmed.permilagemCentesimasSum).toBe(100000);
    const fracoes = await listConstitutionFracoes(deps, { tenantId: TENANT });
    expect(fracoes.map((f) => f.id).sort()).toEqual(["legacy-e", "legacy-m"]);
    const storedM = fracoes.find((f) => f.codigo === "M")!;
    const storedE = fracoes.find((f) => f.codigo === "E")!;
    expect(storedM.permilagemCentesimas).toBe(3880);
    expect(storedM.permilagem).toBeNull();
    expect(storedE.permilagemCentesimas).toBe(96120);
    expect(storedE.permilagem).toBeNull();

    const audit = await client.execute(
      "SELECT entity_id, before_json, after_json FROM audit_events WHERE type = 'constitution.fracao_centesimas_completed'",
    );
    expect(audit.rows.map((row) => String(row.entity_id)).sort()).toEqual(["legacy-e", "legacy-m"]);

    const budget = await createAnnualBudget(deps, {
      tenantId: TENANT,
      year: 2028,
      title: "Depois da reconfirmação",
      lines: [
        { kind: BUDGET_LINE_KINDS.quotaCorrente, label: "Q", amountCents: 10_000 },
        { kind: BUDGET_LINE_KINDS.fcr, label: "F", amountCents: 1_000 },
      ],
    });
    const approved = await approveBudgetAndCreateObligations(deps, {
      tenantId: TENANT,
      budgetId: budget.budget.id,
    });
    expect(approved.idempotent).toBe(false);
    expect(new Set(approved.obligations.map((row) => row.fracaoId))).toEqual(
      new Set(["legacy-e", "legacy-m"]),
    );

    const again = await registerIngestDocument(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "duplicado.pdf",
    });
    const second = await extractDocumentLines(deps, {
      tenantId: TENANT,
      documentId: again.id,
      extraction: {
        lines: [
          {
            kind: "fracao",
            payload: { codigo: "M", permilagem_centesimas: 3950 },
            sourceExcerpt: "M",
          },
          {
            kind: "fracao",
            payload: { codigo: "E", permilagem_centesimas: 96050 },
            sourceExcerpt: "E",
          },
        ],
      },
    });
    const conflict = await confirmFracaoLines(deps, {
      tenantId: TENANT,
      documentId: again.id,
      confirmations: second.lines.map((line) => ({ lineId: line.id })),
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(conflict).toBeInstanceOf(DomainError);
    const domain = conflict as DomainError;
    expect(domain.code).toBe("duplicate_codigo");
    expect(domain.httpStatus).toBe(409);
    expect(domain.message).not.toMatch(/UNIQUE constraint|SQLITE/i);
    expect(domain.message.toLowerCase()).toMatch(/não crie outra fração/);
    const afterConflict = await listConstitutionFracoes(deps, { tenantId: TENANT });
    expect(afterConflict.map((f) => f.id).sort()).toEqual(["legacy-e", "legacy-m"]);
  });

  test("M1-race: segunda reconfirmação, depois das centésimas preenchidas, é 409 e não substitui a primeira", async () => {
    await insertLegacyFracao("legacy-a", "A", 600);
    await insertLegacyFracao("legacy-b", "B", 400);

    async function confirmPair(filename: string, a: number, b: number) {
      const doc = await registerIngestDocument(deps, {
        tenantId: TENANT,
        kind: INGEST_DOCUMENT_KINDS.regulamento,
        filename,
      });
      const extracted = await extractDocumentLines(deps, {
        tenantId: TENANT,
        documentId: doc.id,
        extraction: {
          lines: [
            {
              kind: "fracao",
              payload: { codigo: "A", permilagem_centesimas: a },
              sourceExcerpt: "A",
            },
            {
              kind: "fracao",
              payload: { codigo: "B", permilagem_centesimas: b },
              sourceExcerpt: "B",
            },
          ],
        },
      });
      return confirmFracaoLines(deps, {
        tenantId: TENANT,
        documentId: doc.id,
        confirmations: extracted.lines.map((line) => ({ lineId: line.id })),
      });
    }

    await confirmPair("reconfirm-primeira.pdf", 60000, 40000);
    const auditsAfterFirst = await client.execute(
      "SELECT type, entity_id FROM audit_events WHERE type = 'constitution.fracao_centesimas_completed'",
    );
    expect(auditsAfterFirst.rows).toHaveLength(2);
    const allAfterFirst = await client.execute("SELECT COUNT(*) AS n FROM audit_events");
    const auditCount = Number(allAfterFirst.rows[0]!.n);

    const second = await confirmPair("reconfirm-segunda.pdf", 55000, 45000).then(
      () => null,
      (err: unknown) => err,
    );
    expect(second).toBeInstanceOf(DomainError);
    const domain = second as DomainError;
    expect(domain.httpStatus).toBe(409);
    expect(domain.message).not.toMatch(/não ficou gravada|Nada foi alterado|Nenhum valor foi alterado/i);

    const stored = await listConstitutionFracoes(deps, { tenantId: TENANT });
    expect(stored.map((row) => row.id).sort()).toEqual(["legacy-a", "legacy-b"]);
    expect(stored.find((row) => row.codigo === "A")!.permilagemCentesimas).toBe(60000);
    expect(stored.find((row) => row.codigo === "B")!.permilagemCentesimas).toBe(40000);

    const auditsAfterSecond = await client.execute(
      "SELECT type, entity_id FROM audit_events WHERE type = 'constitution.fracao_centesimas_completed'",
    );
    expect(auditsAfterSecond.rows).toHaveLength(2);
    const allAfterSecond = await client.execute("SELECT COUNT(*) AS n FROM audit_events");
    expect(Number(allAfterSecond.rows[0]!.n)).toBe(auditCount);
  });

  test("edição humana sem inteiro grava originalText formatado", async () => {
    const doc = await registerIngestDocument(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "edicao.pdf",
    });
    const { lines } = await extractDocumentLines(deps, {
      tenantId: TENANT,
      documentId: doc.id,
      extraction: {
        lines: [
          {
            kind: "fracao",
            payload: { codigo: "M", permilagem: null, permilagem_centesimas: 3950 },
            sourceExcerpt: "M 39,50",
          },
        ],
      },
    });
    const edited = await editExtractLine(deps, {
      tenantId: TENANT,
      documentId: doc.id,
      lineId: lines[0]!.id,
      payload: { codigo: "M", permilagem: null, permilagem_centesimas: 3950 },
    });
    const stored = JSON.parse(edited.line.editedPayloadJson!) as {
      evidence?: Array<{ transform?: string; originalText?: string }>;
    };
    const human = stored.evidence?.find((item) => item.transform === "human_edit");
    expect(human?.originalText).toBe("39,50");
  });

  test("troca humana legada A/B fica gravada; unidade rejeitada pede re-extração", async () => {
    const doc = await registerIngestDocument(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "troca-humana.pdf",
    });
    const { lines } = await extractDocumentLines(deps, {
      tenantId: TENANT,
      documentId: doc.id,
      extraction: {
        lines: [
          {
            kind: "fracao",
            payload: {
              codigo: "A",
              permilagem: 400,
              evidence: [
                { field: "permilagem", originalText: "600,00", transform: "identity_permille" },
                { field: "permilagem", originalText: "400", transform: "human_edit" },
              ],
            },
            sourceExcerpt: "A 400",
          },
          {
            kind: "fracao",
            payload: {
              codigo: "B",
              permilagem: 600,
              evidence: [
                { field: "permilagem", originalText: "400,00", transform: "identity_permille" },
                { field: "permilagem", originalText: "600", transform: "human_edit" },
              ],
            },
            sourceExcerpt: "B 600",
          },
        ],
      },
    });
    const confirmed = await confirmFracaoLines(deps, {
      tenantId: TENANT,
      documentId: doc.id,
      confirmations: lines.map((line) => ({ lineId: line.id })),
    });
    expect(confirmed.permilagemCentesimasSum).toBe(100000);
    const fracoes = await listConstitutionFracoes(deps, { tenantId: TENANT });
    expect(fracoes.find((row) => row.codigo === "A")?.permilagemCentesimas).toBe(40000);
    expect(fracoes.find((row) => row.codigo === "B")?.permilagemCentesimas).toBe(60000);

    const ambiguous = await registerIngestDocument(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "unidade-rejeitada.pdf",
    });
    const rejected = await extractDocumentLines(deps, {
      tenantId: TENANT,
      documentId: ambiguous.id,
      extraction: {
        lines: [
          {
            kind: "fracao",
            payload: {
              codigo: "J",
              permilagem: null,
              permilagem_centesimas: null,
              warnings: [{ code: "ambiguous_unit" }],
              evidence: [{ field: "permilagem", originalText: "38,80", transform: null }],
            },
            sourceExcerpt: "J 38,80",
          },
          {
            kind: "fracao",
            payload: {
              codigo: "K",
              permilagem: null,
              permilagem_centesimas: null,
              warnings: [{ code: "mixed_units" }],
              evidence: [{ field: "permilagem", originalText: "3,88%", transform: null }],
            },
            sourceExcerpt: "K 3,88%",
          },
        ],
      },
    });
    const failed = await confirmFracaoLines(deps, {
      tenantId: TENANT,
      documentId: ambiguous.id,
      confirmations: [{ lineId: rejected.lines[0]!.id }],
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failed).toBeInstanceOf(DomainError);
    const domain = failed as DomainError;
    expect(domain.code).toBe("permilagem_reextract");
    expect(domain.httpStatus).toBe(400);
    const still = await listConstitutionFracoes(deps, { tenantId: TENANT });
    expect(still.map((row) => row.codigo).sort()).toEqual(["A", "B"]);
  });

  test("Σ inválida não grava a rejeição pedida no mesmo lote", async () => {
    const doc = await registerIngestDocument(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "rejeicao-soma.pdf",
    });
    const extracted = await extractDocumentLines(deps, {
      tenantId: TENANT,
      documentId: doc.id,
      extraction: {
        lines: [
          {
            kind: "fracao",
            payload: { codigo: "A", permilagem_centesimas: 60000 },
            sourceExcerpt: "A",
          },
          {
            kind: "fracao",
            payload: { codigo: "B", permilagem_centesimas: 40000 },
            sourceExcerpt: "B",
          },
        ],
      },
    });
    const failed = await confirmFracaoLines(deps, {
      tenantId: TENANT,
      documentId: doc.id,
      confirmations: [
        { lineId: extracted.lines[0]!.id, reject: true },
        { lineId: extracted.lines[1]!.id },
      ],
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failed).toBeInstanceOf(DomainError);
    const domain = failed as DomainError;
    expect(domain.code).toBe("permilagem_sum");
    expect(domain.message).toMatch(/Nenhum valor foi alterado/);
    const after = await listExtractLines(deps, { tenantId: TENANT, documentId: doc.id });
    expect(after.lines.map((line) => line.status)).toEqual(["pending_review", "pending_review"]);
    const fracoes = await listConstitutionFracoes(deps, { tenantId: TENANT });
    expect(fracoes).toHaveLength(0);
  });

  test("UNIQUE embrulhado pelo Drizzle conta como duplicate_codigo; NOT NULL não", () => {
    const cause = Object.assign(
      new Error(
        "UNIQUE constraint failed: constitution_fracoes.tenant_id, constitution_fracoes.codigo",
      ),
      {
        code: "SQLITE_CONSTRAINT",
        extendedCode: "SQLITE_CONSTRAINT_UNIQUE",
        rawCode: 2067,
      },
    );
    const wrapped = new Error(
      "Failed query: insert into constitution_fracoes (id, tenant_id, codigo) values (?, ?, ?)",
    );
    (wrapped as Error & { cause?: unknown }).cause = cause;
    expect(isUniqueCodigoConstraint(wrapped)).toBe(true);
    expect(String(wrapped.message)).not.toMatch(/UNIQUE constraint/);

    const notNull = Object.assign(
      new Error("NOT NULL constraint failed: constitution_fracoes.codigo"),
      { code: "SQLITE_CONSTRAINT", extendedCode: "SQLITE_CONSTRAINT_NOTNULL", rawCode: 1299 },
    );
    const wrappedNull = new Error("Failed query: insert into constitution_fracoes");
    (wrappedNull as Error & { cause?: unknown }).cause = notNull;
    expect(isUniqueCodigoConstraint(wrappedNull)).toBe(false);
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
    expect(confirmed.permilagemSum).toBe(100000);

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

  test("upload PDF → extract-from-file (OCR stub) → pending_review com excerto", async () => {
    const { document } = await uploadIngestDocumentFile(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "regulamento.pdf",
      bytes: fakePdf("Fração A — 600‰\nFração B — 400‰"),
    });
    const extracted = await extractDocumentFromStoredContent(deps, {
      tenantId: TENANT,
      documentId: document.id,
    });
    expect(extracted.lines).toHaveLength(2);
    expect(extracted.lines.every((l) => l.status === "pending_review")).toBe(true);
    expect(extracted.lines.every((l) => l.sourceExcerpt.trim().length > 0)).toBe(true);
    expect(extracted.document.status).toBe("pending_review");
  });

  test("upload foto JPEG → extract-from-file → confirmar frações", async () => {
    const { document } = await uploadIngestDocumentFile(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "mapa.jpg",
      bytes: fakeJpeg("Fração A — 700‰\nFração B — 300‰"),
    });
    const extracted = await extractDocumentFromStoredContent(deps, {
      tenantId: TENANT,
      documentId: document.id,
    });
    const confirmed = await confirmFracaoLines(deps, {
      tenantId: TENANT,
      documentId: document.id,
      confirmations: extracted.lines.map((l) => ({ lineId: l.id })),
    });
    expect(confirmed.permilagemSum).toBe(100000);
  });

  test("OCR fraco marca HUMAN REVIEW e não confirma", async () => {
    const { document } = await uploadIngestDocumentFile(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "borrado.pdf",
      bytes: fakePdf("lorem ipsum scan noise without permilage marks"),
    });
    await expect(
      extractDocumentFromStoredContent(deps, {
        tenantId: TENANT,
        documentId: document.id,
      }),
    ).rejects.toMatchObject({ code: "human_review" });
    const listed = await listIngestDocuments(deps, { tenantId: TENANT });
    const row = listed.find((d) => d.id === document.id)!;
    expect(row.status).toBe("failed");
    expect(String(row.error ?? "").toUpperCase()).toContain("HUMAN REVIEW");
  });

  test("editar linha + confirmar contactos não dispara convites", async () => {
    const { document } = await uploadIngestDocumentFile(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.contactos,
      filename: "contactos.csv",
      bytes: Buffer.from("fracao,nome,email\nA,Ana Silva,ana@old.test\n", "utf8"),
    });
    const extracted = await extractDocumentFromStoredContent(deps, {
      tenantId: TENANT,
      documentId: document.id,
    });
    const line = extracted.lines[0]!;
    const edited = await editExtractLine(deps, {
      tenantId: TENANT,
      documentId: document.id,
      lineId: line.id,
      payload: {
        fracaoCodigo: "A",
        personName: "Ana Silva",
        email: "ana@new.test",
      },
    });
    expect(JSON.parse(edited.line.editedPayloadJson!)).toMatchObject({ email: "ana@new.test" });
    const confirmed = await confirmContactLines(deps, {
      tenantId: TENANT,
      documentId: document.id,
      confirmations: [{ lineId: line.id }],
    });
    expect(confirmed.contacts).toHaveLength(1);
    expect(confirmed.contacts[0]!.email).toBe("ana@new.test");
    expect(confirmed.contacts[0]!.status).toBe("confirmed");
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
    form.set("file", new File(["MZ fake exe"], "payload.exe", { type: "application/octet-stream" }));
    const res = await f1App.request("/f1/documents/upload", { method: "POST", body: form });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { message: string };
    expect(json.message.toLowerCase()).toMatch(/tipo|csv|excel|pdf/);
  });

  test("PDF dentro do limite → 201", async () => {
    currentUser = { id: ADMIN_USER_ID, email: "admin-f1@example.test", name: "Admin F1" };
    const form = new FormData();
    form.set("kind", INGEST_DOCUMENT_KINDS.regulamento);
    const bytes = fakePdf("Fração A — 1000‰");
    form.set("file", new File([bytes], "regulamento.pdf", { type: "application/pdf" }));
    const res = await f1App.request("/f1/documents/upload", { method: "POST", body: form });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { document: { filename: string; contentHash: string } };
    expect(json.document.filename).toBe("regulamento.pdf");
    expect(json.document.contentHash).toMatch(/^[a-f0-9]{64}$/);
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

  test("Owner → 403 fail-closed; sem sessão → 401", async () => {
    currentUser = { id: OWNER_USER_ID, email: "owner-f1@example.test", name: "Owner F1" };
    const denied = await f1App.request("/f1/documents");
    expect(denied.status).toBe(403);

    currentUser = null;
    const unauth = await f1App.request("/f1/documents");
    expect(unauth.status).toBe(401);
  });

  test("Admin lista documentos e extrai PDF via HTTP", async () => {
    currentUser = { id: ADMIN_USER_ID, email: "admin-f1@example.test", name: "Admin F1" };
    const form = new FormData();
    form.set("kind", INGEST_DOCUMENT_KINDS.regulamento);
    form.set(
      "file",
      new File([fakePdf("Fração A — 1000‰")], "mapa.pdf", { type: "application/pdf" }),
    );
    const uploaded = await f1App.request("/f1/documents/upload", { method: "POST", body: form });
    expect(uploaded.status).toBe(201);
    const body = (await uploaded.json()) as { document: { id: string } };

    const extracted = await f1App.request(`/f1/documents/${body.document.id}/extract-from-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(extracted.status).toBe(201);
    const extractedBody = (await extracted.json()) as {
      lines: Array<{ status: string; sourceExcerpt: string }>;
    };
    expect(extractedBody.lines.every((l) => l.status === "pending_review")).toBe(true);
    expect(extractedBody.lines.every((l) => l.sourceExcerpt.length > 0)).toBe(true);

    const listed = await f1App.request("/f1/documents");
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { documents: Array<{ id: string }> };
    expect(listBody.documents.some((d) => d.id === body.document.id)).toBe(true);
  });

  test("HTTP: cobertura incompleta → rejeitar lacuna → confirmar Σ=1000‰ sem inventar permilagem", async () => {
    currentUser = { id: ADMIN_USER_ID, email: "admin-f1@example.test", name: "Admin F1" };
    const form = new FormData();
    form.set("kind", INGEST_DOCUMENT_KINDS.regulamento);
    form.set(
      "file",
      new File(
        [
          [
            "Fracção A ........ 600 milésimas",
            "Fracção B ........ 400 milésimas",
            "Fracção C ........ a preencher",
            "",
          ].join("\n"),
        ],
        "cobertura.txt",
        { type: "text/plain" },
      ),
    );
    const uploaded = await f1App.request("/f1/documents/upload", { method: "POST", body: form });
    expect(uploaded.status).toBe(201);
    const { document } = (await uploaded.json()) as { document: { id: string } };

    const extractedRes = await f1App.request(`/f1/documents/${document.id}/extract-from-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(extractedRes.status).toBe(201);
    const extracted = (await extractedRes.json()) as {
      document: { status: string };
      lines: Array<{ id: string; status: string; payloadJson: string }>;
    };
    expect(extracted.document.status).toBe("needs_human_review");
    const gap = extracted.lines.find((line) => line.status === "needs_human_review")!;
    const ready = extracted.lines.filter((line) => line.status === "pending_review");
    expect(ready).toHaveLength(2);
    const gapPayload = JSON.parse(gap.payloadJson) as { permilagem: number | null };
    expect(gapPayload.permilagem == null || !Number.isFinite(Number(gapPayload.permilagem))).toBe(
      true,
    );

    const blocked = await f1App.request(`/f1/documents/${document.id}/confirm-fracoes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirmations: ready.map((line) => ({ lineId: line.id })),
      }),
    });
    expect(blocked.status).toBe(400);
    expect(await listConstitutionFracoes(deps, { tenantId: TENANT })).toHaveLength(0);

    // Mesmo contrato da UI Rejeitar: { lineId, reject: true } sem inventar permilagem.
    const rejected = await f1App.request(`/f1/documents/${document.id}/confirm-fracoes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirmations: [{ lineId: gap.id, reject: true }],
      }),
    });
    expect(rejected.status).toBe(200);

    const linesAfterReject = await f1App.request(`/f1/documents/${document.id}/lines`);
    expect(linesAfterReject.status).toBe(200);
    const afterReject = (await linesAfterReject.json()) as {
      document: { status: string };
      lines: Array<{ id: string; status: string }>;
    };
    expect(afterReject.lines.find((line) => line.id === gap.id)?.status).toBe("rejected");
    expect(afterReject.lines.filter((line) => line.status === "needs_human_review")).toHaveLength(0);

    const confirmed = await f1App.request(`/f1/documents/${document.id}/confirm-fracoes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirmations: ready.map((line) => ({ lineId: line.id })),
      }),
    });
    expect(confirmed.status).toBe(200);
    const confirmedBody = (await confirmed.json()) as {
      permilagemSum: number;
      fracoes: Array<{ codigo: string; permilagem: number }>;
    };
    expect(confirmedBody.permilagemSum).toBe(100000);
    expect(confirmedBody.fracoes).toHaveLength(2);
    expect(confirmedBody.fracoes.every((f) => f.codigo !== "C")).toBe(true);
    expect(await listConstitutionFracoes(deps, { tenantId: TENANT })).toHaveLength(2);
  });
});

describe("F1 pipeline ADR-043 no fluxo /f1", () => {
  test("prosa com líderes fica pendente, com evidência, e só a confirmação cria frações", async () => {
    const { document } = await uploadIngestDocumentFile(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "lideres.txt",
      bytes: Buffer.from(
        "Fracção A ........ 600 milésimas\nFracção B ........ 400 milésimas\n",
        "utf8",
      ),
    });
    expect(await listConstitutionFracoes(deps, { tenantId: TENANT })).toHaveLength(0);
    const extracted = await extractDocumentFromStoredContent(deps, {
      tenantId: TENANT,
      documentId: document.id,
    });
    expect(extracted.document.status).toBe("pending_review");
    expect(extracted.lines.every((line) => line.status === "pending_review")).toBe(true);
    expect(extracted.lines.every((line) => line.sourceExcerpt.includes("milésimas"))).toBe(true);
    const payload = JSON.parse(extracted.lines[0]!.payloadJson) as {
      confidenceSource: string;
      permilagem: number;
    };
    expect(payload.confidenceSource).toBe("system_checks");
    expect(payload.permilagem).toBe(600);
    expect(await listConstitutionFracoes(deps, { tenantId: TENANT })).toHaveLength(0);

    const confirmed = await confirmFracaoLines(deps, {
      tenantId: TENANT,
      documentId: document.id,
      confirmations: extracted.lines.map((line) => ({ lineId: line.id })),
    });
    expect(confirmed.permilagemSum).toBe(100000);
  });

  test("cobertura incompleta não confirma o subconjunto", async () => {
    const { document } = await uploadIngestDocumentFile(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "cobertura.txt",
      bytes: Buffer.from(
        [
          "Fracção A ........ 600 milésimas",
          "Fracção B ........ 400 milésimas",
          "Fracção C ........ a preencher",
          "",
        ].join("\n"),
        "utf8",
      ),
    });
    const extracted = await extractDocumentFromStoredContent(deps, {
      tenantId: TENANT,
      documentId: document.id,
    });
    expect(extracted.lines).toHaveLength(3);
    expect(extracted.document.status).toBe("needs_human_review");
    const gap = extracted.lines.find((line) => line.status === "needs_human_review")!;
    const ready = extracted.lines.filter((line) => line.status === "pending_review");
    expect(ready).toHaveLength(2);
    await expect(
      confirmFracaoLines(deps, {
        tenantId: TENANT,
        documentId: document.id,
        confirmations: ready.map((line) => ({ lineId: line.id })),
      }),
    ).rejects.toMatchObject({ code: "needs_human_review" });
    expect(await listConstitutionFracoes(deps, { tenantId: TENANT })).toHaveLength(0);

    const confirmed = await confirmFracaoLines(deps, {
      tenantId: TENANT,
      documentId: document.id,
      confirmations: [
        ...ready.map((line) => ({ lineId: line.id })),
        { lineId: gap.id, reject: true },
      ],
    });
    expect(confirmed.permilagemSum).toBe(100000);
    expect(confirmed.fracoes).toHaveLength(2);
  });

  test("coluna valor exige edição humana antes de confirmar", async () => {
    const { document } = await uploadIngestDocumentFile(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "valor.csv",
      bytes: Buffer.from("codigo,valor\nA,600\nB,400\n", "utf8"),
    });
    const extracted = await extractDocumentFromStoredContent(deps, {
      tenantId: TENANT,
      documentId: document.id,
    });
    expect(extracted.lines.every((line) => line.status === "needs_human_review")).toBe(true);
    expect(
      extracted.lines.every((line) => {
        const payload = JSON.parse(line.payloadJson) as { permilagem: number | null };
        return payload.permilagem == null;
      }),
    ).toBe(true);
    await expect(
      confirmFracaoLines(deps, {
        tenantId: TENANT,
        documentId: document.id,
        confirmations: extracted.lines.map((line) => ({
          lineId: line.id,
          payload: {
            codigo: JSON.parse(line.payloadJson).codigo as string,
            permilagem: 600,
          },
        })),
      }),
    ).rejects.toMatchObject({ code: "needs_human_review" });
    expect(await listConstitutionFracoes(deps, { tenantId: TENANT })).toHaveLength(0);

    for (const line of extracted.lines) {
      const payload = JSON.parse(line.payloadJson) as { codigo: string };
      await editExtractLine(deps, {
        tenantId: TENANT,
        documentId: document.id,
        lineId: line.id,
        payload: {
          codigo: payload.codigo,
          permilagem: payload.codigo === "A" ? 600 : 400,
        },
      });
    }
    const listed = await listExtractLines(deps, {
      tenantId: TENANT,
      documentId: document.id,
    });
    expect(listed.lines.every((line) => line.status === "pending_review")).toBe(true);
    expect(listed.document.status).toBe("pending_review");
    const confirmed = await confirmFracaoLines(deps, {
      tenantId: TENANT,
      documentId: document.id,
      confirmations: listed.lines.map((line) => ({ lineId: line.id })),
    });
    expect(confirmed.permilagemSum).toBe(100000);
  });
});
