/**
 * Regressão Fonte: pipeline + confirmação humana explícita.
 * O valor documental de M (3950) confirma-se sem ajuste.
 * Um valor inventado não fecha a soma e não grava frações.
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
  test("Σ centésimas = 100000 com M = 3950; valor inventado não grava", async () => {
    const bytes = fs.readFileSync(FIXTURE);

    const pipeline = await runIngestPipeline({
      bytes,
      filename: "anexo-regulamento-fonte.pdf",
      documentId: "pre-confirm",
    });
    expect(pipeline.units).toHaveLength(33);
    expect(pipeline.units.filter((unit) => unit.review === "pending_review")).toHaveLength(33);
    expect(pipeline.units.filter((unit) => unit.review === "needs_human_review")).toHaveLength(0);
    const sum = pipeline.units.reduce((acc, unit) => acc + (unit.permilagemCentesimas ?? 0), 0);
    expect(sum).toBe(100000);
    expect(pipeline.summary.blocking.some((item) => item.code === "permilagem_sum")).toBe(false);
    expect(pipeline.summary.readyForConfirmation).toBe(33);

    const m = pipeline.units.find((unit) => unit.codigo === "M")!;
    expect(m.permilagemCentesimas).toBe(3950);
    expect(m.permilagem).toBeNull();
    expect(m.evidence.find((item) => item.field === "permilagem")?.originalText).toBe("39,50");

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
    expect(await listConstitutionFracoes(deps, { tenantId: TENANT })).toHaveLength(0);

    const invented = extracted.lines.map((line) => {
      const payload = JSON.parse(line.payloadJson) as {
        codigo: string;
        tipo?: string;
        permilagem_centesimas: number;
      };
      if (payload.codigo === "M") {
        return {
          lineId: line.id,
          payload: {
            codigo: "M",
            tipo: payload.tipo ?? "fracao",
            permilagem: null,
            permilagem_centesimas: 3951,
          },
        };
      }
      return { lineId: line.id };
    });
    await expect(
      confirmFracaoLines(deps, {
        tenantId: TENANT,
        documentId: document.id,
        confirmations: invented,
        actor: { personId, userId: ADMIN },
      }),
    ).rejects.toMatchObject({ code: "permilagem_sum" });
    expect(await listConstitutionFracoes(deps, { tenantId: TENANT })).toHaveLength(0);

    const confirmed = await confirmFracaoLines(deps, {
      tenantId: TENANT,
      documentId: document.id,
      confirmations: extracted.lines.map((line) => ({ lineId: line.id })),
      actor: { personId, userId: ADMIN },
    });
    expect(confirmed.permilagemCentesimasSum).toBe(100000);
    expect(confirmed.fracoes).toHaveLength(33);

    const fracoes = await listConstitutionFracoes(deps, { tenantId: TENANT });
    expect(fracoes).toHaveLength(33);
    expect(fracoes.reduce((acc, row) => acc + (row.permilagemCentesimas ?? 0), 0)).toBe(100000);
    const storedM = fracoes.find((row) => row.codigo === "M");
    expect(storedM?.permilagemCentesimas).toBe(3950);
    expect(storedM?.permilagem).toBeNull();
    for (const row of fracoes) {
      const source = pipeline.units.find((unit) => unit.codigo === row.codigo);
      expect(row.permilagemCentesimas).toBe(source?.permilagemCentesimas ?? null);
    }
  });
});
