import { Hono } from "hono";
import {
  approveBudgetAndCreateObligations,
  confirmContactLines,
  confirmFracaoLines,
  createAnnualBudget,
  extractDocumentLines,
  listConstitutionFracoes,
  listExtractLines,
  registerIbanProof,
  registerIngestDocument,
} from "../application/constitution/f1-constitution";
import { DomainError } from "../domain/errors";
import type { KernelDeps } from "../infra/kernel-deps";
import {
  createRequireActiveMembership,
  createRequireMembershipManager,
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
  console.error("[f1]", err);
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

/** F1 — Ingestão + Constituição. Upload ≠ confirmação. */
export function createF1Routes(deps: KernelDeps) {
  const requireMembership = createRequireActiveMembership(deps);
  const requireManager = createRequireMembershipManager();

  return new Hono<{ Variables: KernelVariables }>()
    .use(requireMembership)
    .use(requireManager)
    .post("/documents", async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          kind?: string;
          filename?: string;
          contentUploadId?: string;
          contentHash?: string;
        };
        if (!body.kind || !body.filename) {
          return c.json({ message: "kind e filename são obrigatórios" }, 400);
        }
        const doc = await registerIngestDocument(deps, {
          tenantId: c.get("tenantId")!,
          kind: body.kind,
          filename: body.filename,
          contentUploadId: body.contentUploadId,
          contentHash: body.contentHash,
          actor: actorFrom(c),
        });
        return c.json(doc, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/documents/:id/extract", async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          lines?: Array<{
            kind: string;
            payload: Record<string, unknown>;
            sourceExcerpt: string;
            confidence?: number;
          }>;
        };
        const result = await extractDocumentLines(deps, {
          tenantId: c.get("tenantId")!,
          documentId: c.req.param("id"),
          extraction: { lines: body.lines ?? [] },
          actor: actorFrom(c),
        });
        return c.json(result, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .get("/documents/:id/lines", async (c) => {
      try {
        const result = await listExtractLines(deps, {
          tenantId: c.get("tenantId")!,
          documentId: c.req.param("id"),
        });
        return c.json(result);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/documents/:id/confirm-fracoes", async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          confirmations?: Array<{
            lineId: string;
            payload?: { codigo: string; tipo?: string; permilagem: number };
            reject?: boolean;
          }>;
        };
        const result = await confirmFracaoLines(deps, {
          tenantId: c.get("tenantId")!,
          documentId: c.req.param("id"),
          confirmations: body.confirmations ?? [],
          actor: actorFrom(c),
        });
        return c.json(result);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/documents/:id/confirm-contactos", async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          confirmations?: Array<{
            lineId: string;
            payload?: {
              fracaoCodigo: string;
              personName: string;
              email?: string | null;
              phone?: string | null;
              nif?: string | null;
            };
            reject?: boolean;
          }>;
        };
        const result = await confirmContactLines(deps, {
          tenantId: c.get("tenantId")!,
          documentId: c.req.param("id"),
          confirmations: body.confirmations ?? [],
          actor: actorFrom(c),
        });
        return c.json(result);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/documents/:id/iban-proof", async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as { iban?: string };
        if (!body.iban) return c.json({ message: "iban é obrigatório" }, 400);
        const proof = await registerIbanProof(deps, {
          tenantId: c.get("tenantId")!,
          documentId: c.req.param("id"),
          iban: body.iban,
          actor: actorFrom(c),
        });
        return c.json(proof, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .get("/fracoes", async (c) => {
      const rows = await listConstitutionFracoes(deps, { tenantId: c.get("tenantId")! });
      return c.json(rows);
    })
    .post("/budgets", async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          year?: number;
          title?: string;
          lines?: Array<{ kind: string; label: string; amountCents: number }>;
        };
        if (!body.year || !body.lines) {
          return c.json({ message: "year e lines são obrigatórios" }, 400);
        }
        const result = await createAnnualBudget(deps, {
          tenantId: c.get("tenantId")!,
          year: body.year,
          title: body.title ?? `Orçamento ${body.year}`,
          lines: body.lines,
          actor: actorFrom(c),
        });
        return c.json(result, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/budgets/:id/approve", async (c) => {
      try {
        const result = await approveBudgetAndCreateObligations(deps, {
          tenantId: c.get("tenantId")!,
          budgetId: c.req.param("id"),
          actor: actorFrom(c),
        });
        return c.json(result);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    });
}
