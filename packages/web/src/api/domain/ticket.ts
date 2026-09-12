/**
 * F3 portal Ticket — mínimo operacional do condómino (piloto Essencial).
 * Transplante do modelo Fonte (titulo/descrição/categoria/urgência/estado + foto),
 * sem triagem LLM (F4) e sem CRM.
 */
import { DomainError } from "./errors";

export const TICKET_CATEGORIAS = [
  "manutencao",
  "ruido",
  "financeiro",
  "juridico",
  "administrativo",
  "outro",
] as const;

export const TICKET_URGENCIAS = ["baixa", "normal", "alta", "urgente"] as const;

export const TICKET_STATUSES = [
  "aberto",
  "em_curso",
  "aguarda_condomino",
  "resolvido",
  "cancelado",
] as const;

export const TICKET_ORIGENS = ["portal"] as const;

export type TicketCategoria = (typeof TICKET_CATEGORIAS)[number];
export type TicketUrgencia = (typeof TICKET_URGENCIAS)[number];
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const TICKET_PHOTO_MAX_FILES = 5;
export const TICKET_PHOTO_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"] as const;
export const TICKET_PHOTO_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export const ADMIN_CONTACT_STATUSES = {
  queued: "queued",
  attempted: "attempted",
  skipped: "skipped",
  failed: "failed",
} as const;

export type AdminContactStatus =
  (typeof ADMIN_CONTACT_STATUSES)[keyof typeof ADMIN_CONTACT_STATUSES];

export const ADMIN_CONTACT_SUBJECT_MAX = 180;
export const ADMIN_CONTACT_BODY_MAX = 4000;
export const TICKET_TITULO_MAX = 180;
export const TICKET_DESCRICAO_MAX = 4000;

export function isTicketCategoria(value: string): value is TicketCategoria {
  return (TICKET_CATEGORIAS as readonly string[]).includes(value);
}

export function isTicketUrgencia(value: string): value is TicketUrgencia {
  return (TICKET_URGENCIAS as readonly string[]).includes(value);
}

export function ticketFileExtension(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function isTicketPhotoType(filename: string, mimeType?: string | null): boolean {
  const ext = ticketFileExtension(filename);
  if ((TICKET_PHOTO_EXTENSIONS as readonly string[]).includes(ext)) return true;
  const mime = String(mimeType ?? "")
    .trim()
    .toLowerCase()
    .split(";")[0]!
    .trim();
  return TICKET_PHOTO_MIME_TYPES.has(mime);
}

export function assertTicketPhotoFile(input: {
  filename: string;
  mimeType?: string | null;
  size: number;
}): void {
  if (!Number.isFinite(input.size) || input.size <= 0) {
    throw new DomainError("empty_file", "Ficheiro vazio", 400);
  }
  if (input.size > TICKET_PHOTO_MAX_BYTES) {
    throw new DomainError(
      "upload_too_large",
      `Foto demasiado grande. Máximo: ${Math.round(TICKET_PHOTO_MAX_BYTES / (1024 * 1024))}MB.`,
      400,
    );
  }
  if (!isTicketPhotoType(input.filename, input.mimeType)) {
    throw new DomainError(
      "unsupported_type",
      "Anexe uma foto (JPEG, PNG, WebP ou GIF). Vídeo fica fora deste slice.",
      400,
    );
  }
}

export function normalizeTicketTitulo(value: string): string {
  const titulo = value.trim();
  if (!titulo) throw new DomainError("titulo_required", "Título é obrigatório", 400);
  if (titulo.length > TICKET_TITULO_MAX) {
    throw new DomainError("titulo_too_long", `Título no máximo ${TICKET_TITULO_MAX} caracteres`, 400);
  }
  return titulo;
}

export function normalizeTicketDescricao(value: string): string {
  const descricao = value.trim();
  if (!descricao) throw new DomainError("descricao_required", "Descrição é obrigatória", 400);
  if (descricao.length > TICKET_DESCRICAO_MAX) {
    throw new DomainError(
      "descricao_too_long",
      `Descrição no máximo ${TICKET_DESCRICAO_MAX} caracteres`,
      400,
    );
  }
  return descricao;
}

export function normalizeAdminContactSubject(value: string): string {
  const subject = value.trim();
  if (!subject) throw new DomainError("subject_required", "Assunto é obrigatório", 400);
  if (subject.length > ADMIN_CONTACT_SUBJECT_MAX) {
    throw new DomainError(
      "subject_too_long",
      `Assunto no máximo ${ADMIN_CONTACT_SUBJECT_MAX} caracteres`,
      400,
    );
  }
  return subject;
}

export function normalizeAdminContactBody(value: string): string {
  const body = value.trim();
  if (!body) throw new DomainError("body_required", "Mensagem é obrigatória", 400);
  if (body.length > ADMIN_CONTACT_BODY_MAX) {
    throw new DomainError(
      "body_too_long",
      `Mensagem no máximo ${ADMIN_CONTACT_BODY_MAX} caracteres`,
      400,
    );
  }
  return body;
}
