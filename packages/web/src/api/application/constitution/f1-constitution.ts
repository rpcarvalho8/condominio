import { and, asc, eq } from "drizzle-orm";
import {
  annualBudgetLines,
  annualBudgets,
  condoIbanProofs,
  constitutionFracoes,
  extractLines,
  ingestDocuments,
  obligations,
  ownerContactDrafts,
} from "../../database/schema";
import {
  BUDGET_LINE_KINDS,
  EXTRACT_LINE_KINDS,
  EXTRACT_LINE_STATUS,
  INGEST_DOCUMENT_KINDS,
  INGEST_DOCUMENT_STATUS,
  OBLIGATION_STATUS,
  PERMILAGEM_TOTAL,
  RETENTION_CLASS,
  type ContactExtractPayload,
  type FracaoExtractPayload,
  type StructuredExtraction,
} from "../../domain/constitution";
import { DomainError } from "../../domain/errors";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { publishDomainEvent } from "../events/emit";

type Actor = {
  personId?: string | null;
  userId?: string | null;
  requestId?: string | null;
};

function asFracaoPayload(raw: Record<string, unknown>): FracaoExtractPayload {
  const codigo = String(raw.codigo ?? "").trim();
  const permilagem = Number(raw.permilagem);
  if (!codigo) throw new DomainError("invalid_fracao", "código de fração obrigatório", 400);
  if (!Number.isFinite(permilagem) || permilagem <= 0) {
    throw new DomainError("invalid_permilagem", "permilagem inválida", 400);
  }
  return {
    codigo,
    tipo: raw.tipo ? String(raw.tipo) : "fracao",
    permilagem: Math.round(permilagem),
  };
}

function asContactPayload(raw: Record<string, unknown>): ContactExtractPayload {
  const fracaoCodigo = String(raw.fracaoCodigo ?? raw.fracao_codigo ?? "").trim();
  const personName = String(raw.personName ?? raw.person_name ?? "").trim();
  if (!fracaoCodigo || !personName) {
    throw new DomainError("invalid_contact", "fracaoCodigo e personName são obrigatórios", 400);
  }
  return {
    fracaoCodigo,
    personName,
    email: raw.email ? String(raw.email) : null,
    phone: raw.phone ? String(raw.phone) : null,
    nif: raw.nif ? String(raw.nif) : null,
  };
}

async function writeAudit(
  deps: KernelDeps,
  input: {
    tenantId: string;
    type: string;
    entityType: string;
    entityId: string;
    actor?: Actor;
    after?: Record<string, unknown> | null;
    reason?: string | null;
  },
) {
  await createAuditEventRepo(deps.db).append({
    tenantId: input.tenantId,
    type: input.type,
    entityType: input.entityType,
    entityId: input.entityId,
    actorPersonId: input.actor?.personId ?? null,
    actorUserId: input.actor?.userId ?? null,
    requestId: input.actor?.requestId ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    source: "f1",
  });
}

export async function registerIngestDocument(
  deps: KernelDeps,
  input: {
    tenantId: string;
    kind: string;
    filename: string;
    contentUploadId?: string | null;
    contentHash?: string | null;
    actor?: Actor;
  },
) {
  const kind = input.kind.trim();
  const allowed = Object.values(INGEST_DOCUMENT_KINDS) as string[];
  if (!allowed.includes(kind)) {
    throw new DomainError("invalid_kind", `kind inválido: ${kind}`, 400);
  }

  const retentionClass =
    kind === INGEST_DOCUMENT_KINDS.ibanProof
      ? RETENTION_CLASS.personalDocument
      : RETENTION_CLASS.legalInstrument;
  const now = kernelNow(deps);
  const id = crypto.randomUUID();

  const [row] = await deps.db
    .insert(ingestDocuments)
    .values({
      id,
      tenantId: input.tenantId,
      kind,
      contentUploadId: input.contentUploadId ?? null,
      filename: input.filename.trim() || "documento",
      contentHash: input.contentHash ?? null,
      status: INGEST_DOCUMENT_STATUS.uploaded,
      retentionClass,
      createdAt: now,
      createdByPersonId: input.actor?.personId ?? null,
    })
    .returning();

  await writeAudit(deps, {
    tenantId: input.tenantId,
    type: "ingest.document_registered",
    entityType: "ingest_document",
    entityId: id,
    actor: input.actor,
    after: { kind, filename: row!.filename, retentionClass },
  });

  return row!;
}

export async function extractDocumentLines(
  deps: KernelDeps,
  input: {
    tenantId: string;
    documentId: string;
    extraction: StructuredExtraction;
    actor?: Actor;
  },
) {
  const [doc] = await deps.db
    .select()
    .from(ingestDocuments)
    .where(
      and(eq(ingestDocuments.id, input.documentId), eq(ingestDocuments.tenantId, input.tenantId)),
    )
    .limit(1);
  if (!doc) throw new DomainError("not_found", "Documento não encontrado", 404);

  const now = kernelNow(deps);
  await deps.db
    .update(ingestDocuments)
    .set({ status: INGEST_DOCUMENT_STATUS.extracting, error: null })
    .where(eq(ingestDocuments.id, doc.id));

  const existing = await deps.db
    .select()
    .from(extractLines)
    .where(eq(extractLines.documentId, doc.id));
  if (existing.length > 0) {
    throw new DomainError("already_extracted", "Documento já tem linhas extraídas", 409);
  }

  const lines = input.extraction.lines ?? [];
  if (lines.length === 0) {
    await deps.db
      .update(ingestDocuments)
      .set({
        status: INGEST_DOCUMENT_STATUS.failed,
        error: "extração vazia",
        processedAt: now,
      })
      .where(eq(ingestDocuments.id, doc.id));
    throw new DomainError("empty_extraction", "Extração sem linhas", 400);
  }

  const inserted = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const excerpt = String(line.sourceExcerpt ?? "").trim();
    if (!excerpt) {
      throw new DomainError(
        "missing_excerpt",
        `Linha ${i + 1} sem sourceExcerpt — confirmação humana exige origem visível`,
        400,
      );
    }
    const [row] = await deps.db
      .insert(extractLines)
      .values({
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        documentId: doc.id,
        lineNo: i + 1,
        kind: String(line.kind),
        payloadJson: JSON.stringify(line.payload ?? {}),
        sourceExcerpt: excerpt,
        confidence: line.confidence ?? null,
        status: EXTRACT_LINE_STATUS.pendingReview,
        createdAt: now,
      })
      .returning();
    inserted.push(row!);
  }

  await deps.db
    .update(ingestDocuments)
    .set({ status: INGEST_DOCUMENT_STATUS.pendingReview, processedAt: now })
    .where(eq(ingestDocuments.id, doc.id));

  await writeAudit(deps, {
    tenantId: input.tenantId,
    type: "ingest.extraction_ready",
    entityType: "ingest_document",
    entityId: doc.id,
    actor: input.actor,
    after: { lines: inserted.length },
  });

  return {
    document: { ...doc, status: INGEST_DOCUMENT_STATUS.pendingReview },
    lines: inserted,
  };
}

export async function listExtractLines(
  deps: KernelDeps,
  input: { tenantId: string; documentId: string },
) {
  const [doc] = await deps.db
    .select()
    .from(ingestDocuments)
    .where(
      and(eq(ingestDocuments.id, input.documentId), eq(ingestDocuments.tenantId, input.tenantId)),
    )
    .limit(1);
  if (!doc) throw new DomainError("not_found", "Documento não encontrado", 404);

  const lines = await deps.db
    .select()
    .from(extractLines)
    .where(eq(extractLines.documentId, doc.id))
    .orderBy(asc(extractLines.lineNo));

  return { document: doc, lines };
}

export async function confirmFracaoLines(
  deps: KernelDeps,
  input: {
    tenantId: string;
    documentId: string;
    confirmations: Array<{
      lineId: string;
      payload?: FracaoExtractPayload;
      reject?: boolean;
    }>;
    actor?: Actor;
  },
) {
  const { document, lines } = await listExtractLines(deps, input);
  if (document.kind !== INGEST_DOCUMENT_KINDS.regulamento) {
    throw new DomainError("wrong_kind", "Só regulamento confirma frações aqui", 400);
  }

  const now = kernelNow(deps);
  const batch: Array<{ lineId: string; payload: FracaoExtractPayload; excerpt: string }> = [];

  for (const c of input.confirmations) {
    const line = lines.find((l) => l.id === c.lineId);
    if (!line || line.tenantId !== input.tenantId) {
      throw new DomainError("line_not_found", `Linha ${c.lineId} não encontrada`, 404);
    }
    if (line.status === EXTRACT_LINE_STATUS.confirmed) continue;
    if (c.reject) {
      await deps.db
        .update(extractLines)
        .set({ status: EXTRACT_LINE_STATUS.rejected })
        .where(eq(extractLines.id, line.id));
      continue;
    }
    if (line.kind !== EXTRACT_LINE_KINDS.fracao) {
      throw new DomainError("wrong_line_kind", "Linha não é do tipo fracao", 400);
    }
    const raw =
      (c.payload as unknown as Record<string, unknown> | undefined) ??
      (JSON.parse(line.editedPayloadJson ?? line.payloadJson) as Record<string, unknown>);
    const payload = asFracaoPayload(raw);
    if (!line.sourceExcerpt?.trim()) {
      throw new DomainError("missing_excerpt", "Linha sem excerto de origem", 400);
    }
    batch.push({ lineId: line.id, payload, excerpt: line.sourceExcerpt });
  }

  const sum = batch.reduce((acc, x) => acc + x.payload.permilagem, 0);
  if (batch.length > 0 && sum !== PERMILAGEM_TOTAL) {
    throw new DomainError(
      "permilagem_sum",
      `Σ permilagens do lote = ${sum}‰; tem de ser exactamente ${PERMILAGEM_TOTAL}‰`,
      400,
    );
  }

  const created = [];
  for (const item of batch) {
    const [fracao] = await deps.db
      .insert(constitutionFracoes)
      .values({
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        codigo: item.payload.codigo,
        tipo: item.payload.tipo ?? "fracao",
        permilagem: item.payload.permilagem,
        sourceDocumentId: document.id,
        sourceLineId: item.lineId,
        sourceExcerpt: item.excerpt,
        status: "confirmed",
        createdAt: now,
        confirmedAt: now,
        confirmedByPersonId: input.actor?.personId ?? null,
      })
      .returning();

    await deps.db
      .update(extractLines)
      .set({
        status: EXTRACT_LINE_STATUS.confirmed,
        editedPayloadJson: JSON.stringify(item.payload),
        confirmedAt: now,
        confirmedByPersonId: input.actor?.personId ?? null,
      })
      .where(eq(extractLines.id, item.lineId));

    created.push(fracao!);
  }

  const pending = await deps.db
    .select()
    .from(extractLines)
    .where(
      and(
        eq(extractLines.documentId, document.id),
        eq(extractLines.status, EXTRACT_LINE_STATUS.pendingReview),
      ),
    );

  await deps.db
    .update(ingestDocuments)
    .set({
      status:
        pending.length === 0
          ? INGEST_DOCUMENT_STATUS.confirmed
          : INGEST_DOCUMENT_STATUS.partiallyConfirmed,
    })
    .where(eq(ingestDocuments.id, document.id));

  await writeAudit(deps, {
    tenantId: input.tenantId,
    type: "constitution.fracoes_confirmed",
    entityType: "ingest_document",
    entityId: document.id,
    actor: input.actor,
    after: {
      created: created.map((f) => ({ id: f.id, codigo: f.codigo, permilagem: f.permilagem })),
      sum,
    },
  });

  await publishDomainEvent(deps, {
    tenantId: input.tenantId,
    type: "ConstitutionFracoesConfirmed",
    aggregateType: "ingest_document",
    aggregateId: document.id,
    payload: { count: created.length, sum },
    correlationId: input.actor?.requestId ?? null,
  });

  return { fracoes: created, permilagemSum: sum };
}

export async function confirmContactLines(
  deps: KernelDeps,
  input: {
    tenantId: string;
    documentId: string;
    confirmations: Array<{
      lineId: string;
      payload?: ContactExtractPayload;
      reject?: boolean;
    }>;
    actor?: Actor;
  },
) {
  const { document, lines } = await listExtractLines(deps, input);
  const now = kernelNow(deps);
  const drafts = [];

  for (const c of input.confirmations) {
    const line = lines.find((l) => l.id === c.lineId);
    if (!line) throw new DomainError("line_not_found", `Linha ${c.lineId} não encontrada`, 404);
    if (c.reject) {
      await deps.db
        .update(extractLines)
        .set({ status: EXTRACT_LINE_STATUS.rejected })
        .where(eq(extractLines.id, line.id));
      continue;
    }
    const raw =
      (c.payload as unknown as Record<string, unknown> | undefined) ??
      (JSON.parse(line.editedPayloadJson ?? line.payloadJson) as Record<string, unknown>);
    const payload = asContactPayload(raw);
    const [draft] = await deps.db
      .insert(ownerContactDrafts)
      .values({
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        documentId: document.id,
        fracaoCodigo: payload.fracaoCodigo,
        personName: payload.personName,
        email: payload.email ?? null,
        phone: payload.phone ?? null,
        nif: payload.nif ?? null,
        sourceExcerpt: line.sourceExcerpt,
        status: "confirmed",
        confirmedAt: now,
        confirmedByPersonId: input.actor?.personId ?? null,
        createdAt: now,
      })
      .returning();

    await deps.db
      .update(extractLines)
      .set({
        status: EXTRACT_LINE_STATUS.confirmed,
        editedPayloadJson: JSON.stringify(payload),
        confirmedAt: now,
        confirmedByPersonId: input.actor?.personId ?? null,
      })
      .where(eq(extractLines.id, line.id));

    drafts.push(draft!);
  }

  await writeAudit(deps, {
    tenantId: input.tenantId,
    type: "constitution.contacts_confirmed",
    entityType: "ingest_document",
    entityId: document.id,
    actor: input.actor,
    after: { count: drafts.length },
    reason: "Confirmação humana — nunca dispara convites automaticamente",
  });

  return { contacts: drafts };
}

export async function registerIbanProof(
  deps: KernelDeps,
  input: {
    tenantId: string;
    documentId: string;
    iban: string;
    actor?: Actor;
  },
) {
  const [doc] = await deps.db
    .select()
    .from(ingestDocuments)
    .where(
      and(eq(ingestDocuments.id, input.documentId), eq(ingestDocuments.tenantId, input.tenantId)),
    )
    .limit(1);
  if (!doc) throw new DomainError("not_found", "Documento não encontrado", 404);

  const iban = input.iban.replace(/\s+/g, "").toUpperCase();
  if (!/^PT\d{23}$/i.test(iban) && !/^[A-Z]{2}\d{13,32}$/.test(iban)) {
    throw new DomainError("invalid_iban", "IBAN inválido", 400);
  }

  const now = kernelNow(deps);
  const [proof] = await deps.db
    .insert(condoIbanProofs)
    .values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      documentId: doc.id,
      iban,
      retentionClass: RETENTION_CLASS.personalDocument,
      status: "registered",
      createdAt: now,
      createdByPersonId: input.actor?.personId ?? null,
    })
    .returning();

  await writeAudit(deps, {
    tenantId: input.tenantId,
    type: "constitution.iban_proof_registered",
    entityType: "condo_iban_proof",
    entityId: proof!.id,
    actor: input.actor,
    after: {
      ibanLast4: iban.slice(-4),
      retentionClass: RETENTION_CLASS.personalDocument,
    },
  });

  return proof!;
}

export async function createAnnualBudget(
  deps: KernelDeps,
  input: {
    tenantId: string;
    year: number;
    title: string;
    lines: Array<{ kind: string; label: string; amountCents: number }>;
    actor?: Actor;
  },
) {
  if (!Number.isInteger(input.year) || input.year < 2000) {
    throw new DomainError("invalid_year", "Ano inválido", 400);
  }
  if (!input.lines.length) {
    throw new DomainError("empty_budget", "Orçamento sem linhas", 400);
  }

  const allowedKinds = Object.values(BUDGET_LINE_KINDS) as string[];
  for (const line of input.lines) {
    if (!allowedKinds.includes(line.kind)) {
      throw new DomainError("invalid_budget_line", `kind inválido: ${line.kind}`, 400);
    }
    if (!Number.isInteger(line.amountCents) || line.amountCents < 0) {
      throw new DomainError("invalid_amount", "amountCents inválido", 400);
    }
  }

  const quota = input.lines
    .filter((l) => l.kind === BUDGET_LINE_KINDS.quotaCorrente)
    .reduce((a, l) => a + l.amountCents, 0);
  const fcr = input.lines
    .filter((l) => l.kind === BUDGET_LINE_KINDS.fcr)
    .reduce((a, l) => a + l.amountCents, 0);
  if (quota > 0 && fcr < Math.ceil(quota * 0.1)) {
    throw new DomainError(
      "fcr_too_low",
      "FCR tem de ser ≥ 10% da quota corrente (DL 268/94 art. 4.º)",
      400,
    );
  }

  const now = kernelNow(deps);
  const budgetId = crypto.randomUUID();
  const [budget] = await deps.db
    .insert(annualBudgets)
    .values({
      id: budgetId,
      tenantId: input.tenantId,
      year: input.year,
      status: "draft",
      title: input.title.trim() || `Orçamento ${input.year}`,
      createdAt: now,
      createdByPersonId: input.actor?.personId ?? null,
    })
    .returning();

  const createdLines = [];
  for (const line of input.lines) {
    const [row] = await deps.db
      .insert(annualBudgetLines)
      .values({
        id: crypto.randomUUID(),
        budgetId,
        tenantId: input.tenantId,
        kind: line.kind,
        label: line.label,
        amountCents: line.amountCents,
        createdAt: now,
      })
      .returning();
    createdLines.push(row!);
  }

  await writeAudit(deps, {
    tenantId: input.tenantId,
    type: "constitution.budget_created",
    entityType: "annual_budget",
    entityId: budgetId,
    actor: input.actor,
    after: { year: input.year, lines: createdLines.length },
  });

  return { budget: budget!, lines: createdLines };
}

export async function approveBudgetAndCreateObligations(
  deps: KernelDeps,
  input: { tenantId: string; budgetId: string; actor?: Actor },
) {
  const [budget] = await deps.db
    .select()
    .from(annualBudgets)
    .where(and(eq(annualBudgets.id, input.budgetId), eq(annualBudgets.tenantId, input.tenantId)))
    .limit(1);
  if (!budget) throw new DomainError("not_found", "Orçamento não encontrado", 404);

  if (budget.status === "approved") {
    const existing = await deps.db
      .select()
      .from(obligations)
      .where(eq(obligations.budgetId, budget.id));
    return { budget, obligations: existing, idempotent: true };
  }

  const fracoes = await deps.db
    .select()
    .from(constitutionFracoes)
    .where(eq(constitutionFracoes.tenantId, input.tenantId));
  if (fracoes.length === 0) {
    throw new DomainError("no_fracoes", "Confirme frações antes de aprovar o orçamento", 400);
  }

  const sum = fracoes.reduce((a, f) => a + f.permilagem, 0);
  if (sum !== PERMILAGEM_TOTAL) {
    throw new DomainError(
      "permilagem_sum",
      `Σ permilagens do tenant = ${sum}‰; tem de ser ${PERMILAGEM_TOTAL}‰`,
      400,
    );
  }

  const lines = await deps.db
    .select()
    .from(annualBudgetLines)
    .where(eq(annualBudgetLines.budgetId, budget.id));

  const now = kernelNow(deps);
  const created = [];
  for (const line of lines) {
    let allocated = 0;
    for (let i = 0; i < fracoes.length; i++) {
      const fracao = fracoes[i]!;
      const isLast = i === fracoes.length - 1;
      const amount = isLast
        ? line.amountCents - allocated
        : Math.floor((line.amountCents * fracao.permilagem) / PERMILAGEM_TOTAL);
      allocated += amount;
      const [row] = await deps.db
        .insert(obligations)
        .values({
          id: crypto.randomUUID(),
          tenantId: input.tenantId,
          fracaoId: fracao.id,
          budgetId: budget.id,
          budgetLineId: line.id,
          kind: line.kind,
          periodYear: budget.year,
          amountCents: amount,
          openAmountCents: amount,
          status: OBLIGATION_STATUS.open,
          legalBasis:
            line.kind === BUDGET_LINE_KINDS.fcr
              ? "DL 268/94 art. 4.º — FCR ≥10% da quota-parte"
              : "Orçamento anual aprovado",
          createdAt: now,
        })
        .returning();
      created.push(row!);
    }
  }

  await deps.db
    .update(annualBudgets)
    .set({
      status: "approved",
      approvedAt: now,
      approvedByPersonId: input.actor?.personId ?? null,
    })
    .where(eq(annualBudgets.id, budget.id));

  const [updated] = await deps.db
    .select()
    .from(annualBudgets)
    .where(eq(annualBudgets.id, budget.id))
    .limit(1);

  await writeAudit(deps, {
    tenantId: input.tenantId,
    type: "constitution.budget_approved",
    entityType: "annual_budget",
    entityId: budget.id,
    actor: input.actor,
    after: { obligations: created.length, year: budget.year },
  });

  await publishDomainEvent(deps, {
    tenantId: input.tenantId,
    type: "BudgetApproved",
    aggregateType: "annual_budget",
    aggregateId: budget.id,
    payload: { obligations: created.length },
    correlationId: input.actor?.requestId ?? null,
  });

  return { budget: updated!, obligations: created, idempotent: false };
}

export async function listConstitutionFracoes(
  deps: KernelDeps,
  input: { tenantId: string },
) {
  return deps.db
    .select()
    .from(constitutionFracoes)
    .where(eq(constitutionFracoes.tenantId, input.tenantId))
    .orderBy(asc(constitutionFracoes.codigo));
}
