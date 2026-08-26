/**
 * Cliente de upload resumível — fatia ficheiro/IDB em ~5MB e retoma se a rede cair.
 */
import { getToken } from "./auth";
import { ApiError, apiFetch, humanizeNetworkError, isOnline } from "./api-client";

const CHUNK_BYTES = 5 * 1024 * 1024;

export type ResumableUploadProgress = {
  sentBytes: number;
  totalBytes: number;
  sentChunks: number;
  totalChunks: number;
};

export type ResumableUploadResult = {
  uploadId: string;
  audioPath: string;
  filename: string;
  byteSize: number;
};

async function putChunk(
  uploadId: string,
  seq: number,
  blob: Blob,
  token: string | null,
  retries = 4,
): Promise<void> {
  let attempt = 0;
  while (true) {
    if (!isOnline()) {
      throw new ApiError("Sem ligação — upload pausado. Voltará a tentar automaticamente.", 0);
    }
    try {
      const res = await fetch(`/api/uploads/${uploadId}/chunks/${seq}`, {
        method: "PUT",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/octet-stream",
        },
        body: blob,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new ApiError(String((data as any).message ?? res.statusText), res.status);
      }
      return;
    } catch (e) {
      attempt++;
      if (attempt > retries) throw e instanceof ApiError ? e : new ApiError(humanizeNetworkError(e), 0);
      await new Promise((r) => setTimeout(r, Math.min(8_000, 400 * 2 ** attempt)));
    }
  }
}

/**
 * Envia um File em chunks resumíveis. Se já existir uploadId, retoma seqs em falta.
 */
export async function uploadFileResumable(opts: {
  file: File | Blob;
  target: "reuniao" | "ata";
  filename?: string;
  uploadId?: string;
  onProgress?: (p: ResumableUploadProgress) => void;
}): Promise<ResumableUploadResult> {
  const token = getToken();
  const mimeType = opts.file.type || "audio/webm";
  const filename = opts.filename || (opts.file instanceof File ? opts.file.name : `audio.${mimeType.includes("mp4") ? "m4a" : "webm"}`);

  const created = await apiFetch<{
    uploadId: string;
    receivedSeqs: number[];
    byteSize: number;
    status: string;
  }>("/api/uploads", {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target: opts.target,
      mimeType,
      filename,
      uploadId: opts.uploadId,
    }),
    retries: 2,
  });

  const uploadId = created.uploadId;
  const status = await apiFetch<{
    uploadId: string;
    receivedSeqs: number[];
    status: string;
    finalRelativePath?: string;
    byteSize: number;
  }>(`/api/uploads/${uploadId}`, { token, retries: 2 });

  if (status.status === "completed" && (status as any).finalRelativePath) {
    return {
      uploadId,
      audioPath: (status as any).finalRelativePath,
      filename,
      byteSize: status.byteSize,
    };
  }

  const received = new Set(status.receivedSeqs ?? []);
  const totalBytes = opts.file.size;
  const totalChunks = Math.max(1, Math.ceil(totalBytes / CHUNK_BYTES));
  let sentBytes = 0;
  for (const seq of received) {
    // estimativa: chunks anteriores
    sentBytes += Math.min(CHUNK_BYTES, Math.max(0, totalBytes - seq * CHUNK_BYTES));
  }
  // recalcular sentBytes a partir dos seqs recebidos de forma mais precisa
  sentBytes = 0;
  for (let seq = 0; seq < totalChunks; seq++) {
    if (!received.has(seq)) continue;
    const start = seq * CHUNK_BYTES;
    const end = Math.min(start + CHUNK_BYTES, totalBytes);
    sentBytes += end - start;
  }

  for (let seq = 0; seq < totalChunks; seq++) {
    if (received.has(seq)) {
      opts.onProgress?.({
        sentBytes,
        totalBytes,
        sentChunks: received.size,
        totalChunks,
      });
      continue;
    }
    const start = seq * CHUNK_BYTES;
    const end = Math.min(start + CHUNK_BYTES, totalBytes);
    const slice = opts.file.slice(start, end);
    await putChunk(uploadId, seq, slice, token);
    received.add(seq);
    sentBytes += end - start;
    opts.onProgress?.({
      sentBytes,
      totalBytes,
      sentChunks: received.size,
      totalChunks,
    });
  }

  const done = await apiFetch<{
    uploadId: string;
    audioPath: string;
    filename: string;
    byteSize: number;
  }>(`/api/uploads/${uploadId}/complete`, {
    method: "POST",
    token,
    retries: 2,
    timeoutMs: 60_000,
  });

  return {
    uploadId: done.uploadId,
    audioPath: done.audioPath,
    filename: done.filename,
    byteSize: done.byteSize,
  };
}
