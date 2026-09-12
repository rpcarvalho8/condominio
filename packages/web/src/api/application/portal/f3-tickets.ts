/**
 * F3 portal — tickets + foto.
 * Transplante do fluxo Fonte (criar/listar/anexar), com Membership + blob F1 + outbox.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { portalTicketPhotos, portalTickets } from "../../database/schema";
import { AUDIT_TYPES } from "../../domain/audit";
import { DOMAIN_EVENT_TYPES } from "../../domain/domain-event";
import { DomainError } from "../../domain/errors";
import type { Membership } from "../../domain/membership";
import { OUTBOX_JOB_TYPES } from "../../domain/outbox";
import {
  assertTicketPhotoFile,
  isTicketCategoria,
  isTicketUrgencia,
  normalizeTicketDescricao,
  normalizeTicketTitulo,
  TICKET_PHOTO_MAX_FILES,
} from "../../domain/ticket";
import { storeContentBlob } from "../../infra/content-blob-store";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { emitAndEnqueue } from "../events/emit";
import { registerContentUpload } from "../uploads/register-content-upload";
import {
  assertFracaoAuthorized,
  assertPortalMembership,
  assertPortalTenant,
  type PortalActor,
} from "./f3-portal";

export type PortalTicketPhotoView = {
  id: string;
  ticketId: string;
  contentHash: string;
  filename: string;
  mimeType: string;
  originalName: string;
  sizeBytes: number;
  createdAt: string;
};

export type PortalTicketView = {
  id: string;
  fracaoId: string;
  titulo: string;
  descricao: string;
  categoria: string;
  urgencia: string;
  status: string;
  origem: string;
  createdAt: string;
  updatedAt: string;
  photoCount: number;
  photos: PortalTicketPhotoView[];
};

export type PortalTicketPhotoBytes = {
  filename: string;
  contentType: string;
  body: Buffer;
};

function toPhotoView(row: typeof portalTicketPhotos.$inferSelect): PortalTicketPhotoView {
  return {
    id: row.id,
    ticketId: row.ticketId,
    contentHash: row.contentHash,
    filename: row.filename,
    mimeType: row.mimeType,
    originalName: row.originalName,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

function toTicketView(
  row: typeof portalTickets.$inferSelect,
  photos: PortalTicketPhotoView[],
): PortalTicketView {
  return {
    id: row.id,
    fracaoId: row.fracaoId,
    titulo: row.titulo,
    descricao: row.descricao,
    categoria: row.categoria,
    urgencia: row.urgencia,
    status: row.status,
    origem: row.origem,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    photoCount: photos.length,
    photos,
  };
}

async function loadPhotos(deps: KernelDeps, ticketIds: string[]): Promise<Map<string, PortalTicketPhotoView[]>> {
  const map = new Map<string, PortalTicketPhotoView[]>();
  if (ticketIds.length === 0) return map;
  const rows = await deps.db
    .select()
    .from(portalTicketPhotos)
    .where(inArray(portalTicketPhotos.ticketId, ticketIds));
  for (const row of rows) {
    const list = map.get(row.ticketId) ?? [];
    list.push(toPhotoView(row));
    map.set(row.ticketId, list);
  }
  return map;
}

async function attachPhotos(
  deps: KernelDeps,
  input: {
    tenantId: string;
    ticketId: string;
    actor: PortalActor;
    files: Array<{ filename: string; mimeType?: string | null; bytes: Uint8Array | Buffer }>;
  },
): Promise<PortalTicketPhotoView[]> {
  if (input.files.length > TICKET_PHOTO_MAX_FILES) {
    throw new DomainError(
      "too_many_photos",
      `Máximo de ${TICKET_PHOTO_MAX_FILES} fotos por pedido`,
      400,
    );
  }
  const now = kernelNow(deps);
  const saved: PortalTicketPhotoView[] = [];
  for (const file of input.files) {
    assertTicketPhotoFile({
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.bytes.byteLength,
    });
    const stored = await storeContentBlob({
      tenantId: input.tenantId,
      bytes: file.bytes,
    });
    await registerContentUpload(deps, {
      tenantId: input.tenantId,
      contentHash: stored.contentHash,
      filename: file.filename,
      byteSize: stored.byteSize,
      correlationId: input.actor.requestId ?? null,
    });
    const [row] = await deps.db
      .insert(portalTicketPhotos)
      .values({
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        ticketId: input.ticketId,
        contentHash: stored.contentHash,
        filename: `${stored.contentHash}${file.filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ".bin"}`,
        mimeType: (file.mimeType ?? "application/octet-stream").split(";")[0]!.trim() || "image/jpeg",
        originalName: file.filename.slice(0, 180),
        sizeBytes: stored.byteSize,
        createdAt: now,
        createdByPersonId: input.actor.personId,
      })
      .returning();
    saved.push(toPhotoView(row!));
  }
  return saved;
}

export async function createPortalTicket(
  deps: KernelDeps,
  input: {
    tenantId: string;
    memberships: Membership[];
    actor: PortalActor;
    fracaoId?: string | null;
    titulo: string;
    descricao: string;
    categoria?: string | null;
    urgencia?: string | null;
    files?: Array<{ filename: string; mimeType?: string | null; bytes: Uint8Array | Buffer }>;
  },
): Promise<PortalTicketView> {
  const tenantId = assertPortalTenant(input.tenantId);
  const fracaoIds = assertPortalMembership(input.memberships);
  const fracaoId = assertFracaoAuthorized(fracaoIds, input.fracaoId ?? fracaoIds[0]);
  const titulo = normalizeTicketTitulo(input.titulo);
  const descricao = normalizeTicketDescricao(input.descricao);
  const categoria = input.categoria && isTicketCategoria(input.categoria) ? input.categoria : "outro";
  const urgencia = input.urgencia && isTicketUrgencia(input.urgencia) ? input.urgencia : "normal";
  const now = kernelNow(deps);
  const id = crypto.randomUUID();

  const [row] = await deps.db
    .insert(portalTickets)
    .values({
      id,
      tenantId,
      fracaoId,
      createdByPersonId: input.actor.personId,
      createdByUserId: input.actor.userId ?? null,
      titulo,
      descricao,
      categoria,
      urgencia,
      status: "aberto",
      origem: "portal",
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const photos = await attachPhotos(deps, {
    tenantId,
    ticketId: id,
    actor: input.actor,
    files: input.files ?? [],
  });

  await createAuditEventRepo(deps.db).append({
    tenantId,
    type: AUDIT_TYPES.ticketCreated,
    entityType: "ticket",
    entityId: id,
    actorPersonId: input.actor.personId,
    actorUserId: input.actor.userId ?? null,
    requestId: input.actor.requestId ?? null,
    after: {
      fracaoId,
      titulo,
      categoria,
      urgencia,
      photoCount: photos.length,
      contentHashes: photos.map((p) => p.contentHash),
    },
    source: "f3-portal",
    reason: "create_portal_ticket",
  });

  await emitAndEnqueue(
    deps,
    {
      tenantId,
      type: DOMAIN_EVENT_TYPES.ticketCreated,
      aggregateType: "ticket",
      aggregateId: id,
      payload: { fracaoId, photoCount: photos.length },
      correlationId: input.actor.requestId ?? null,
    },
    {
      tenantId,
      jobType: OUTBOX_JOB_TYPES.notifyTicketCreated,
      idempotencyKey: `notify:ticket:${id}:created`,
      payload: {
        ticketId: id,
        fracaoId,
        titulo,
        photoCount: photos.length,
      },
      correlationId: input.actor.requestId ?? null,
    },
    { drain: true },
  );

  return toTicketView(row!, photos);
}

export async function listPortalTickets(
  deps: KernelDeps,
  input: {
    tenantId: string;
    memberships: Membership[];
    actor: PortalActor;
  },
): Promise<{ tickets: PortalTicketView[] }> {
  const tenantId = assertPortalTenant(input.tenantId);
  const fracaoIds = assertPortalMembership(input.memberships);
  const rows = await deps.db
    .select()
    .from(portalTickets)
    .where(and(eq(portalTickets.tenantId, tenantId), inArray(portalTickets.fracaoId, fracaoIds)))
    .orderBy(desc(portalTickets.updatedAt));
  const photos = await loadPhotos(
    deps,
    rows.map((r) => r.id),
  );
  return { tickets: rows.map((row) => toTicketView(row, photos.get(row.id) ?? [])) };
}

export async function getPortalTicket(
  deps: KernelDeps,
  input: {
    tenantId: string;
    ticketId: string;
    memberships: Membership[];
    actor: PortalActor;
  },
): Promise<PortalTicketView> {
  const tenantId = assertPortalTenant(input.tenantId);
  const fracaoIds = assertPortalMembership(input.memberships);
  const [row] = await deps.db
    .select()
    .from(portalTickets)
    .where(and(eq(portalTickets.id, input.ticketId), eq(portalTickets.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new DomainError("ticket_not_found", "Pedido não encontrado", 404);
  assertFracaoAuthorized(fracaoIds, row.fracaoId);
  const photos = await loadPhotos(deps, [row.id]);
  return toTicketView(row, photos.get(row.id) ?? []);
}

export async function downloadPortalTicketPhoto(
  deps: KernelDeps,
  input: {
    tenantId: string;
    ticketId: string;
    photoId: string;
    memberships: Membership[];
    actor: PortalActor;
  },
): Promise<PortalTicketPhotoBytes> {
  const ticket = await getPortalTicket(deps, input);
  const photo = ticket.photos.find((p) => p.id === input.photoId);
  if (!photo) throw new DomainError("photo_not_found", "Foto não encontrada", 404);
  const { readContentBlob } = await import("../../infra/content-blob-store");
  const body = readContentBlob({
    tenantId: assertPortalTenant(input.tenantId),
    contentHash: photo.contentHash,
  });
  return {
    filename: photo.originalName,
    contentType: photo.mimeType,
    body,
  };
}
