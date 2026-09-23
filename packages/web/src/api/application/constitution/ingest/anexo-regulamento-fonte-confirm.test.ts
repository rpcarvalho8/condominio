/**
 * Regressão Fonte: pipeline + confirmação humana explícita.
 * M: 40→39 é DECISÃO DO OPERADOR no lote de confirmação — nunca regra automática.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import fs from "node:fs";
import path from "node:path";
import * as schema from "../../../database/schema";
import {
  confirmFracaoLines,
  listConstitutionFracoes,
} from "../f1-constitution";
import {
  extractDocumentFromStoredContent,
  uploadIngestDocumentFile,
} from "../upload-and-extract";
import { INGEST_DOCUMENT_KINDS } from "../../../domain/constitution";
import { applyDomainKernelSchema } from "../../../infra/kernel-schema";
import { applyF1ConstitutionSchema } from "../../../infra/f1-schema";
import type { KernelDeps } from "../../../infra/kernel-deps";
import { createMembershipRepo } from "../../../infra/repos/membership-repo";
import { createPersonRepo } from "../../../infra/repos/person-repo";
import { runIngestPipeline } from "./pipeline";

const FIXTURE = path.join(
  import.meta.dir,
  "../extractors/fixtures/anexo-regulamento-fonte.pdf",
);
const DB_PATH = path.join(import.meta.dir, "../../../../.tmp-test-fonte-confirm.db");
const BLOB_ROOT = path.join(import.meta.dir, "../../../../.tmp-test-fonte-confirm-content");

const TENANT = "tenant-fonte-harden";
const ADMIN = "user-fonte-harden";

let client: ReturnType<typeof createClient>;
let deps: KernelDeps;
let personId: string;

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
  const personRepo = createPersonRepo(db);
  const membershipRepo = createMembershipRepo(db);
  const person = await personRepo.insert({
    id: crypto.randomUUID(),
    userId: ADMIN,
    name: "Admin Fonte Harden",
    email: "fonte-harden@example.test",
    createdAt: new Date(),
  });
  personId = person.id;
  await membershipRepo.insert({
    id: crypto.randomUUID(),
    personId: person.id,
    tenantId: TENANT,
    roleCode: "Admin",
    createdAt: new Date(),
  });
});

afterAll(() => {
  try {
    client?.close();
  } catch {
    /* ignore */
  }
});

describe("F1 Fonte — regressão com confirmação humana explícita", () => {
  test("blocking Σ=1001‰; operador ajusta M 40→39; constitution Σ=1000‰", async () => {
    const bytes = fs.readFileSync(FIXTURE);

    const pipeline = await runIngestPipeline({
      bytes,
      filename: "anexo-regulamento-fonte.pdf",
      documentId: "pre-confirm",
    });
    expect(pipeline.units).toHaveLength(33);
    expect(pipeline.units.filter((unit) => unit.review === "pending_review")).toHaveLength(33);
    expect(pipeline.units.filter((unit) => unit.review === "needs_human_review")).toHaveLength(0);
    const sumRound = pipeline.units.reduce((acc, unit) => acc + (unit.permilagem ?? 0), 0);
    expect(sumRound).toBe(1001);
    expect(pipeline.summary.blocking.some((item) => item.code === "permilagem_sum")).toBe(true);
    expect(pipeline.summary.readyForConfirmation).toBe(33);

    const m = pipeline.units.find((unit) => unit.codigo === "M")!;
    expect(m.permilagem).toBe(40);
    expect(m.evidence.find((item) => item.field === "permilagem")?.originalText).toBe("39,50");

    // Fail-closed: confirmar o lote arredondado sem ajuste humano deve falhar.
    const { document } = await uploadIngestDocumentFile(deps, {
      tenantId: TENANT,
      kind: INGEST_DOCUMENT_KINDS.regulamento,
      filename: "anexo-regulamento-fonte.pdf",
      bytes,
      actor: { personId, userId: ADMIN },
    });
    const extracted = await extractDocumentFromStoredContent(deps, {
      tenantId: TENANT,
      documentId: document.id,
      actor: { personId, userId: ADMIN },
    });
    expect(extracted.lines).toHaveLength(33);

    await expect(
      confirmFracaoLines(deps, {
        tenantId: TENANT,
        documentId: document.id,
        confirmations: extracted.lines.map((line) => ({ lineId: line.id })),
        actor: { personId, userId: ADMIN },
      }),
    ).rejects.toMatchObject({ code: "permilagem_sum" });

    // Decisão humana explícita (não regra automática): M 40 → 39.
    const confirmations = extracted.lines.map((line) => {
      const payload = JSON.parse(line.payloadJson) as {
        codigo: string;
        permilagem: number;
        tipo?: string;
      };
      if (payload.codigo === "M") {
        return {
          lineId: line.id,
          payload: { codigo: "M", tipo: payload.tipo ?? "fracao", permilagem: 39 },
        };
      }
      return { lineId: line.id };
    });

    const confirmed = await confirmFracaoLines(deps, {
      tenantId: TENANT,
      documentId: document.id,
      confirmations,
      actor: { personId, userId: ADMIN },
    });
    expect(confirmed.permilagemSum).toBe(1000);
    expect(confirmed.fracoes).toHaveLength(33);

    const fracoes = await listConstitutionFracoes(deps, { tenantId: TENANT });
    expect(fracoes).toHaveLength(33);
    expect(fracoes.reduce((acc, row) => acc + row.permilagem, 0)).toBe(1000);
    expect(fracoes.find((row) => row.codigo === "M")?.permilagem).toBe(39);
  });
});
