import { DomainError } from "../../domain/errors";

/** Hard cap for this F1 slice (CSV / Excel / texto). */
export const F1_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const F1_ALLOWED_EXTENSIONS = [".csv", ".xlsx", ".xls", ".txt"] as const;

export const F1_ALLOWED_MIME_TYPES = new Set([
  "text/csv",
  "text/plain",
  "text/comma-separated-values",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

function maxUploadMessage(): string {
  return `Ficheiro demasiado grande. Máximo: ${Math.round(F1_MAX_UPLOAD_BYTES / (1024 * 1024))}MB.`;
}

export function parseContentLengthHeader(header: string | undefined): number | null {
  if (header == null || String(header).trim() === "") return null;
  const n = Number(header);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/** Reject oversized requests before parseBody / arrayBuffer. */
export function assertF1UploadContentLength(header: string | undefined): void {
  const n = parseContentLengthHeader(header);
  if (n != null && n > F1_MAX_UPLOAD_BYTES) {
    throw new DomainError("upload_too_large", maxUploadMessage(), 400);
  }
}

export function f1FileExtension(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function isAllowedF1UploadType(filename: string, mimeType?: string | null): boolean {
  const ext = f1FileExtension(filename);
  if ((F1_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) return true;
  const mime = String(mimeType ?? "")
    .trim()
    .toLowerCase()
    .split(";")[0]!
    .trim();
  return F1_ALLOWED_MIME_TYPES.has(mime);
}

export function assertF1UploadFile(input: {
  filename: string;
  mimeType?: string | null;
  size: number;
}): void {
  if (!Number.isFinite(input.size) || input.size <= 0) {
    throw new DomainError("empty_file", "Ficheiro vazio", 400);
  }
  if (input.size > F1_MAX_UPLOAD_BYTES) {
    throw new DomainError("upload_too_large", maxUploadMessage(), 400);
  }
  if (!isAllowedF1UploadType(input.filename, input.mimeType)) {
    throw new DomainError(
      "unsupported_type",
      "Tipo não suportado neste slice — use CSV, Excel (.xlsx/.xls) ou texto (.txt)",
      400,
    );
  }
}
