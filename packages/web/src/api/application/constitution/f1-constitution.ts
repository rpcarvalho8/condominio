import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
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
  RETENTION_CLASS,
  type ContactExtractPayload,
  type FracaoExtractPayload,
  type StructuredExtraction,
} from "../../domain/constitution";
import { DomainError } from "../../domain/errors";
import {
  PERMILAGEM_CENTESIMAS_TOTAL,
  centesimasFromStoredPayload,
  formatPermilagemCentesimas,
  legacyIntegerPermilagem,
  positiveSafeInteger,
  type PermilagemCentesimasRead,
} from "../../domain/permilagem-centesimas";
import { assertSha256ContentHash } from "../../infra/content-blob-store";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { publishDomainEvent } from "../events/emit";
import { UNIT_SHARE_PROFILE_ID, type IngestPipelineSummary } from "./ingest/contracts";

type Actor = {
  personId?: string | null;
  userId?: string | null;
  requestId?: string | null;
};

type StoredFracaoPayload = {
  codigo: string;
  tipo: string;
  permilagem: number | null;
  permilagem_centesimas: number;
};

/** Centésimas: Number.isSafeInteger e ≤ 100000. Não aceita float. */
function positiveInteger(value: unknown): number | null {
  return positiveSafeInteger(value, PERMILAGEM_CENTESIMAS_TOTAL);
}

const REEXTRACT_MESSAGE =
  "A permilagem inteira não recupera as centésimas. Re-extraia o regulamento para ler o token original; não se converte um inteiro arredondado.";

function classifyPermilagem(raw: Record<string, unknown>): PermilagemCentesimasRead {
  const directField = raw.permilagem_centesimas ?? raw.permilagemCentesimas;
  if (directField != null) {
    const direct = positiveInteger(directField);
    return direct == null ? { ok: false, reason: "missing" } : { ok: true, centesimas: direct };
  }
  return centesimasFromStoredPayload(raw);
}

/** Lê centésimas do payload. Inteiro ‰ exacto (sem casas) vale ×100 só sem evidência de arredondamento. */
export function readPermilagemCentesimas(raw: Record<string, unknown>): number | null {
  const read = classifyPermilagem(raw);
  return read.ok ? read.centesimas : null;
}

function asFracaoPayload(raw: Record<string, unknown>): StoredFracaoPayload {
  const codigo = String(raw.codigo ?? "").trim();
  if (!codigo) throw new DomainError("invalid_fracao", "código de fração obrigatório", 400);
  const read = classifyPermilagem(raw);
  if (!read.ok) {
    throw new DomainError(
      read.reason === "reextract" ? "permilagem_reextract" : "invalid_permilagem",
      read.reason === "reextract"
        ? REEXTRACT_MESSAGE
        : "permilagem_centesimas em falta ou com mais de 2 casas decimais no ‰",
      400,
    );
  }
  const centesimas = read.centesimas;
  return {
    codigo,
    tipo: raw.tipo ? String(raw.tipo) : "fracao",
    permilagem: legacyIntegerPermilagem(centesimas),
    permilagem_centesimas: centesimas,
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
    before?: Record<string, unknown> | null;
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
    before: input.before ?? null,
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

  const rawHash = input.contentHash == null ? "" : String(input.contentHash).trim();
  const contentHash = rawHash ? assertSha256ContentHash(rawHash) : null;

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
      contentHash,
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

function lineReviewStatus(status: string | undefined): string {
  return status === EXTRACT_LINE_STATUS.needsHumanReview
    ? EXTRACT_LINE_STATUS.needsHumanReview
    : EXTRACT_LINE_STATUS.pendingReview;
}

async function refreshFracaoReviewState(deps: KernelDeps, documentId: string) {
  const lines = await deps.db
    .select()
    .from(extractLines)
    .where(eq(extractLines.documentId, documentId));
  const open = lines.filter(
    (line) =>
      line.kind === EXTRACT_LINE_KINDS.fracao &&
      line.status !== EXTRACT_LINE_STATUS.confirmed &&
      line.status !== EXTRACT_LINE_STATUS.rejected,
  );
  const ambiguous = open.filter((line) => line.status === EXTRACT_LINE_STATUS.needsHumanReview);
  let sum = 0;
  for (const line of open) {
    if (line.status !== EXTRACT_LINE_STATUS.pendingReview) continue;
    const payload = JSON.parse(line.editedPayloadJson ?? line.payloadJson) as Record<string, unknown>;
    const value = readPermilagemCentesimas(payload);
    if (value != null) sum += value;
  }
  const blocking: Array<{ code: string; message: string }> = [];
  if (ambiguous.length > 0) {
    blocking.push({
      code: "needs_human_review",
      message: `${ambiguous.length} linha(s) precisam de decisão humana.`,
    });
  } else if (open.length > 0 && sum !== PERMILAGEM_CENTESIMAS_TOTAL) {
    blocking.push({
      code: "permilagem_sum",
      message: `Σ permilagem_centesimas = ${sum}; exige ${PERMILAGEM_CENTESIMAS_TOTAL}.`,
    });
  }
  const [doc] = await deps.db
    .select()
    .from(ingestDocuments)
    .where(eq(ingestDocuments.id, documentId))
    .limit(1);
  const previous = doc?.pipelineJson
    ? (JSON.parse(doc.pipelineJson) as IngestPipelineSummary)
    : null;
  const summary: IngestPipelineSummary = {
    profile: previous?.profile ?? UNIT_SHARE_PROFILE_ID,
    representation: previous?.representation ?? "unknown",
    informationPresent: previous?.informationPresent ?? [],
    readyForConfirmation: open.filter((line) => line.status === EXTRACT_LINE_STATUS.pendingReview).length,
    needsHumanDecision:
      ambiguous.length + (blocking.some((item) => item.code === "permilagem_sum") ? 1 : 0),
    blocking,
    checks: previous?.checks ?? [],
    llmUsed: previous?.llmUsed ?? false,
    llmHypothesis: previous?.llmHypothesis ?? null,
    stages: previous?.stages ?? [],
  };
  await deps.db
    .update(ingestDocuments)
    .set({
      status:
        blocking.length > 0
          ? INGEST_DOCUMENT_STATUS.needsHumanReview
          : INGEST_DOCUMENT_STATUS.pendingReview,
      pipelineJson: JSON.stringify(summary),
      error: null,
    })
    .where(eq(ingestDocuments.id, documentId));
}

export async function extractDocumentLines(
  deps: KernelDeps,
  input: {
    tenantId: string;
    documentId: string;
    extraction: StructuredExtraction;
    pipeline?: IngestPipelineSummary | null;
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
        status: lineReviewStatus(line.status),
        createdAt: now,
      })
      .returning();
    inserted.push(row!);
  }

  const blocked =
    inserted.some((row) => row.status === EXTRACT_LINE_STATUS.needsHumanReview) ||
    (input.pipeline?.blocking.length ?? 0) > 0;
  const documentStatus = blocked
    ? INGEST_DOCUMENT_STATUS.needsHumanReview
    : INGEST_DOCUMENT_STATUS.pendingReview;

  await deps.db
    .update(ingestDocuments)
    .set({
      status: documentStatus,
      processedAt: now,
      error: null,
      pipelineJson: input.pipeline ? JSON.stringify(input.pipeline) : null,
    })
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
    document: {
      ...doc,
      status: documentStatus,
      pipelineJson: input.pipeline ? JSON.stringify(input.pipeline) : null,
    },
    lines: inserted,
  };
}

export async function listIngestDocuments(
  deps: KernelDeps,
  input: { tenantId: string },
) {
  return deps.db
    .select()
    .from(ingestDocuments)
    .where(eq(ingestDocuments.tenantId, input.tenantId))
    .orderBy(desc(ingestDocuments.createdAt));
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

export async function editExtractLine(
  deps: KernelDeps,
  input: {
    tenantId: string;
    documentId: string;
    lineId: string;
    payload: Record<string, unknown>;
    actor?: Actor;
  },
) {
  const { document, lines } = await listExtractLines(deps, input);
  const line = lines.find((l) => l.id === input.lineId);
  if (!line) throw new DomainError("line_not_found", `Linha ${input.lineId} não encontrada`, 404);
  if (
    line.status !== EXTRACT_LINE_STATUS.pendingReview &&
    line.status !== EXTRACT_LINE_STATUS.needsHumanReview
  ) {
    throw new DomainError("line_not_editable", "Só linhas em revisão podem ser editadas", 400);
  }

  let normalized: Record<string, unknown>;
  if (line.kind === EXTRACT_LINE_KINDS.fracao) {
    const previous = JSON.parse(line.payloadJson) as Record<string, unknown>;
    const fracao = asFracaoPayload(input.payload);
    const evidence = Array.isArray(previous.evidence) ? previous.evidence : [];
    normalized = {
      ...previous,
      codigo: fracao.codigo,
      tipo: fracao.tipo ?? "fracao",
      permilagem: fracao.permilagem,
      permilagem_centesimas: fracao.permilagem_centesimas,
      review: EXTRACT_LINE_STATUS.pendingReview,
      evidence: [
        ...evidence,
        {
          field: "permilagem",
          documentId: document.id,
          documentName: document.filename,
          page: null,
          line: line.lineNo,
          cell: null,
          region: null,
          originalText:
            fracao.permilagem == null
              ? formatPermilagemCentesimas(fracao.permilagem_centesimas)
              : String(fracao.permilagem),
          transform: "human_edit",
        },
      ],
    };
  } else if (line.kind === EXTRACT_LINE_KINDS.contacto) {
    normalized = asContactPayload(input.payload) as unknown as Record<string, unknown>;
  } else {
    normalized = input.payload;
  }

  const [updated] = await deps.db
    .update(extractLines)
    .set({
      editedPayloadJson: JSON.stringify(normalized),
      status:
        line.kind === EXTRACT_LINE_KINDS.fracao
          ? EXTRACT_LINE_STATUS.pendingReview
          : line.status,
    })
    .where(eq(extractLines.id, line.id))
    .returning();

  if (line.kind === EXTRACT_LINE_KINDS.fracao) {
    await refreshFracaoReviewState(deps, document.id);
  }

  await writeAudit(deps, {
    tenantId: input.tenantId,
    type: "ingest.line_edited",
    entityType: "extract_line",
    entityId: line.id,
    actor: input.actor,
    after: { documentId: document.id, kind: line.kind, payload: normalized },
    reason: "Edição humana antes da confirmação — sem auto-envio",
  });

  return { document, line: updated! };
}

/**
 * Drizzle embrulha o libSQL em DrizzleQueryError ("Failed query: insert into …").
 * UNIQUE / SQLITE_CONSTRAINT ficam em `cause` (code, extendedCode, rawCode).
 * NOT NULL (SQLITE_CONSTRAINT_NOTNULL / 1299) não é conflito de código.
 */
export function isUniqueCodigoConstraint(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current != null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const anyErr = current as {
      message?: unknown;
      code?: unknown;
      extendedCode?: unknown;
      rawCode?: unknown;
      cause?: unknown;
    };
    const codes = [anyErr.code, anyErr.extendedCode, anyErr.rawCode]
      .filter((value) => value != null)
      .map((value) => String(value).toUpperCase());
    const msg = String(anyErr.message ?? "").toLowerCase();
    if (codes.some((code) => code.includes("SQLITE_CONSTRAINT_UNIQUE") || code === "2067")) {
      return true;
    }
    const bareConstraint = codes.some((code) => code === "SQLITE_CONSTRAINT" || code === "19");
    if (bareConstraint && msg.includes("unique")) return true;
    if (msg.includes("unique") && (msg.includes("codigo") || msg.includes("constitution_fracoes"))) {
      return true;
    }
    current = anyErr.cause;
  }
  return false;
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
  const batch: Array<{ lineId: string; payload: StoredFracaoPayload; excerpt: string }> = [];
  const rejectedLineIds: string[] = [];
  const rejectedIds = new Set(
    input.confirmations.filter((item) => item.reject).map((item) => item.lineId),
  );
  const unresolved = lines.filter(
    (line) =>
      line.kind === EXTRACT_LINE_KINDS.fracao &&
      line.status === EXTRACT_LINE_STATUS.needsHumanReview &&
      !rejectedIds.has(line.id),
  );
  if (unresolved.length > 0) {
    throw new DomainError(
      "needs_human_review",
      `Há ${unresolved.length} linha(s) com ambiguidade por resolver. Nada foi confirmado (ADR-017).`,
      400,
    );
  }

  for (const c of input.confirmations) {
    const line = lines.find((l) => l.id === c.lineId);
    if (!line || line.tenantId !== input.tenantId) {
      throw new DomainError("line_not_found", `Linha ${c.lineId} não encontrada`, 404);
    }
    if (line.status === EXTRACT_LINE_STATUS.confirmed) continue;
    if (line.status === EXTRACT_LINE_STATUS.needsHumanReview && !c.reject) {
      throw new DomainError(
        "needs_human_review",
        "Linha ambígua não pode ser confirmada sem decisão humana (ADR-017).",
        400,
      );
    }
    if (c.reject) {
      rejectedLineIds.push(line.id);
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

  const sum = batch.reduce((acc, x) => acc + x.payload.permilagem_centesimas, 0);
  const codes = batch.map((item) => item.payload.codigo.trim().toUpperCase());
  const duplicate = codes.find((code, index) => codes.indexOf(code) !== index);
  if (duplicate) {
    throw new DomainError(
      "duplicate_codigo",
      `Código ${duplicate} repetido no lote. Nada foi confirmado.`,
      400,
    );
  }
  if (batch.length > 0 && sum !== PERMILAGEM_CENTESIMAS_TOTAL) {
    throw new DomainError(
      "permilagem_sum",
      `Σ permilagem_centesimas do lote = ${sum}; tem de ser exactamente ${PERMILAGEM_CENTESIMAS_TOTAL}. Nenhum valor foi alterado.`,
      400,
    );
  }

  for (const lineId of rejectedLineIds) {
    await deps.db
      .update(extractLines)
      .set({ status: EXTRACT_LINE_STATUS.rejected })
      .where(eq(extractLines.id, lineId));
  }

  const rows = [];
  const existingRows = await deps.db
    .select()
    .from(constitutionFracoes)
    .where(eq(constitutionFracoes.tenantId, input.tenantId));
  const existingByCodigo = new Map(existingRows.map((row) => [row.codigo, row]));
  for (const item of batch) {
    const existing = existingByCodigo.get(item.payload.codigo);
    if (existing && existing.permilagemCentesimas != null) {
      throw new DomainError(
        "duplicate_codigo",
        `O código ${item.payload.codigo} já está confirmado com permilagem em centésimas. Não crie outra fração com o mesmo código.`,
        409,
      );
    }
  }

  for (const item of batch) {
    const existing = existingByCodigo.get(item.payload.codigo);
    const permilagem = item.payload.permilagem;
    let fracao;
    if (existing && existing.permilagemCentesimas == null) {
      const [updated] = await deps.db
        .update(constitutionFracoes)
        .set({
          permilagem,
          permilagemCentesimas: item.payload.permilagem_centesimas,
          confirmedAt: now,
          confirmedByPersonId: input.actor?.personId ?? null,
        })
        .where(
          and(
            eq(constitutionFracoes.id, existing.id),
            eq(constitutionFracoes.tenantId, input.tenantId),
            isNull(constitutionFracoes.permilagemCentesimas),
          ),
        )
        .returning();
      if (!updated) {
        throw new DomainError(
          "reconfirm_conflict",
          `O código ${item.payload.codigo} já não tem centésimas vazias. O valor pedido não foi escrito nesta fração.`,
          409,
        );
      }
      fracao = updated;
      await writeAudit(deps, {
          tenantId: input.tenantId,
          type: "constitution.fracao_centesimas_completed",
          entityType: "constitution_fracao",
          entityId: existing.id,
          actor: input.actor,
          before: {
            id: existing.id,
            codigo: existing.codigo,
            permilagem: existing.permilagem,
            permilagem_centesimas: null,
          },
          after: {
            id: existing.id,
            codigo: existing.codigo,
            permilagem,
            permilagem_centesimas: item.payload.permilagem_centesimas,
            sourceDocumentId: document.id,
            sourceLineId: item.lineId,
          },
          reason:
            "Reconfirmação do regulamento: centésimas gravadas na fração existente. O id mantém-se para as obligations.",
        });
      } else {
        try {
          const [inserted] = await deps.db
            .insert(constitutionFracoes)
            .values({
              id: crypto.randomUUID(),
              tenantId: input.tenantId,
              codigo: item.payload.codigo,
              tipo: item.payload.tipo ?? "fracao",
              permilagem,
              permilagemCentesimas: item.payload.permilagem_centesimas,
              sourceDocumentId: document.id,
              sourceLineId: item.lineId,
              sourceExcerpt: item.excerpt,
              status: "confirmed",
              createdAt: now,
              confirmedAt: now,
              confirmedByPersonId: input.actor?.personId ?? null,
            })
            .returning();
          fracao = inserted!;
        } catch (err) {
          if (isUniqueCodigoConstraint(err)) {
            throw new DomainError(
              "duplicate_codigo",
              `O código ${item.payload.codigo} já existe neste condomínio. Não crie outra fração com o mesmo código. Se a constituição é anterior a 0011 e as centésimas estão vazias, reconfirme o regulamento sobre a fração existente.`,
              409,
            );
          }
          throw err;
        }
      }

      await deps.db
        .update(extractLines)
        .set({
          status: EXTRACT_LINE_STATUS.confirmed,
          editedPayloadJson: JSON.stringify(item.payload),
          confirmedAt: now,
          confirmedByPersonId: input.actor?.personId ?? null,
        })
        .where(eq(extractLines.id, item.lineId));

      rows.push(fracao);
    }

    const pending = await deps.db
      .select()
      .from(extractLines)
      .where(
        and(
          eq(extractLines.documentId, document.id),
          inArray(extractLines.status, [
            EXTRACT_LINE_STATUS.pendingReview,
            EXTRACT_LINE_STATUS.needsHumanReview,
          ]),
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
        created: rows.map((f) => ({
          id: f.id,
          codigo: f.codigo,
          permilagem: f.permilagem,
          permilagemCentesimas: f.permilagemCentesimas,
        })),
        sum,
      },
    });

    await publishDomainEvent(deps, {
      tenantId: input.tenantId,
      type: "ConstitutionFracoesConfirmed",
      aggregateType: "ingest_document",
      aggregateId: document.id,
      payload: { count: rows.length, sum },
      correlationId: input.actor?.requestId ?? null,
    });

  return { fracoes: rows, permilagemSum: sum, permilagemCentesimasSum: sum };
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
    .where(eq(constitutionFracoes.tenantId, input.tenantId))
    .orderBy(asc(constitutionFracoes.codigo));
  if (fracoes.length === 0) {
    throw new DomainError("no_fracoes", "Confirme frações antes de aprovar o orçamento", 400);
  }

  const missing = fracoes.filter((f) => f.permilagemCentesimas == null);
  if (missing.length > 0) {
    const codigos = missing.map((f) => f.codigo).join(", ");
    throw new DomainError(
      "permilagem_centesimas_missing",
      `Faltam permilagem_centesimas nas frações ${codigos}. A constituição é anterior à migração 0011: reconfirme o regulamento para gravar as centésimas de ‰. Nada foi aprovado.`,
      400,
    );
  }
  const sum = fracoes.reduce((a, f) => a + (f.permilagemCentesimas ?? 0), 0);
  if (sum !== PERMILAGEM_CENTESIMAS_TOTAL) {
    throw new DomainError(
      "permilagem_sum",
      `Σ permilagem_centesimas do tenant = ${sum}; tem de ser ${PERMILAGEM_CENTESIMAS_TOTAL}.`,
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
      // Resto F2, determinístico: ORDER BY codigo ASC (já aplicado no SELECT).
      // Cada fracção excepto a última recebe floor(amountCents * permilagem_centesimas / 100000).
      // O resto inteiro de cêntimos vai todo para a última fracção. Não é largest-remainder.
      // A constituição não usa este resto: Σ ≠ 100000 falha antes, sem alterar valores.
      const isLast = i === fracoes.length - 1;
      const share = fracao.permilagemCentesimas ?? 0;
      const amount = isLast
        ? line.amountCents - allocated
        : Math.floor((line.amountCents * share) / PERMILAGEM_CENTESIMAS_TOTAL);
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
