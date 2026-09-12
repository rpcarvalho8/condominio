import { parseContentLengthHeader } from "../constitution/f1-upload-guard";
import { DomainError } from "../../domain/errors";
import { TICKET_PHOTO_MAX_BYTES, TICKET_PHOTO_MAX_FILES } from "../../domain/ticket";

/** Multipart fields (titulo/descrição/categoria) + boundaries on top of photo bytes. */
const TICKET_UPLOAD_FORM_OVERHEAD_BYTES = 64 * 1024;

/** Early Content-Length ceiling: max files × max bytes/file + form overhead. */
export const TICKET_UPLOAD_MAX_CONTENT_LENGTH =
  TICKET_PHOTO_MAX_BYTES * TICKET_PHOTO_MAX_FILES + TICKET_UPLOAD_FORM_OVERHEAD_BYTES;

function maxUploadMessage(): string {
  return `Foto demasiado grande. Máximo: ${Math.round(TICKET_PHOTO_MAX_BYTES / (1024 * 1024))}MB por ficheiro, ${TICKET_PHOTO_MAX_FILES} ficheiros.`;
}

/** Reject oversized ticket photo requests before parseBody / arrayBuffer. */
export function assertTicketUploadContentLength(header: string | undefined): void {
  const n = parseContentLengthHeader(header);
  if (n != null && n > TICKET_UPLOAD_MAX_CONTENT_LENGTH) {
    throw new DomainError("upload_too_large", maxUploadMessage(), 413);
  }
}

export function assertTicketUploadFileCount(count: number): void {
  if (count > TICKET_PHOTO_MAX_FILES) {
    throw new DomainError(
      "too_many_photos",
      `Máximo de ${TICKET_PHOTO_MAX_FILES} fotos por pedido`,
      400,
    );
  }
}
