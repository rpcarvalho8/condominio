/**
 * Persistência local de gravações de áudio (IndexedDB).
 * Chunks ~1s → recuperação após crash / fecho de aba / suspend iPad.
 */
export type PersistedRecordingStatus =
  | "recording"
  | "paused"
  | "completed"
  | "uploading"
  | "uploaded"
  | "discarded";

export type PersistedSession = {
  id: string;
  target: "ata" | "reuniao";
  draft: { titulo: string; data: string; participantes?: string };
  mimeType: string;
  status: PersistedRecordingStatus;
  startedAt: number;
  lastFlushAt: number;
  elapsedMs: number;
  nextSeq: number;
  byteSize: number;
};

export type PersistedChunk = {
  sessionId: string;
  seq: number;
  blob: Blob;
  byteSize: number;
  createdAt: number;
};

const DB_NAME = "condominio-recordings";
const DB_VERSION = 1;
const STORE_SESSIONS = "sessions";
const STORE_CHUNKS = "chunks";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        const chunks = db.createObjectStore(STORE_CHUNKS, { keyPath: ["sessionId", "seq"] });
        chunks.createIndex("bySession", "sessionId", { unique: false });
      }
    };
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function idbTxDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function newRecordingSessionId(): string {
  return `rec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function createRecordingSession(
  session: Omit<PersistedSession, "nextSeq" | "byteSize" | "lastFlushAt"> & {
    nextSeq?: number;
    byteSize?: number;
  },
): Promise<PersistedSession> {
  const full: PersistedSession = {
    ...session,
    nextSeq: session.nextSeq ?? 0,
    byteSize: session.byteSize ?? 0,
    lastFlushAt: Date.now(),
  };
  const db = await openDb();
  const tx = db.transaction(STORE_SESSIONS, "readwrite");
  tx.objectStore(STORE_SESSIONS).put(full);
  await idbTxDone(tx);
  db.close();
  return full;
}

export async function updateRecordingSession(
  id: string,
  patch: Partial<PersistedSession>,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_SESSIONS, "readwrite");
  const store = tx.objectStore(STORE_SESSIONS);
  const existing = await idbReq<PersistedSession | undefined>(store.get(id));
  if (existing) {
    store.put({ ...existing, ...patch, lastFlushAt: Date.now() });
  }
  await idbTxDone(tx);
  db.close();
}

/** Append chunk; returns updated nextSeq and total byteSize. */
export async function appendRecordingChunk(
  sessionId: string,
  blob: Blob,
): Promise<{ seq: number; byteSize: number } | null> {
  if (!blob.size) return null;
  const db = await openDb();
  const tx = db.transaction([STORE_SESSIONS, STORE_CHUNKS], "readwrite");
  const sessions = tx.objectStore(STORE_SESSIONS);
  const chunks = tx.objectStore(STORE_CHUNKS);
  const session = await idbReq<PersistedSession | undefined>(sessions.get(sessionId));
  if (!session) {
    db.close();
    return null;
  }
  const seq = session.nextSeq;
  const row: PersistedChunk = {
    sessionId,
    seq,
    blob,
    byteSize: blob.size,
    createdAt: Date.now(),
  };
  chunks.put(row);
  const byteSize = session.byteSize + blob.size;
  sessions.put({
    ...session,
    nextSeq: seq + 1,
    byteSize,
    lastFlushAt: Date.now(),
  });
  await idbTxDone(tx);
  db.close();
  return { seq, byteSize };
}

export async function listRecordingChunks(sessionId: string): Promise<PersistedChunk[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_CHUNKS, "readonly");
  const idx = tx.objectStore(STORE_CHUNKS).index("bySession");
  const rows = await idbReq<PersistedChunk[]>(idx.getAll(sessionId));
  await idbTxDone(tx);
  db.close();
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function assembleRecordingFile(
  session: PersistedSession,
): Promise<File | null> {
  const parts = await listRecordingChunks(session.id);
  if (parts.length === 0) return null;
  const mime = session.mimeType || "audio/webm";
  const blob = new Blob(
    parts.map((p) => p.blob),
    { type: mime },
  );
  const ext =
    mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a")
      ? "m4a"
      : mime.includes("wav")
        ? "wav"
        : "webm";
  const prefix = session.target === "ata" ? "ata" : "reuniao";
  return new File([blob], `${prefix}_recuperada_${session.startedAt}.${ext}`, {
    type: mime,
  });
}

export async function getRecordingSession(id: string): Promise<PersistedSession | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_SESSIONS, "readonly");
  const row = await idbReq<PersistedSession | undefined>(tx.objectStore(STORE_SESSIONS).get(id));
  await idbTxDone(tx);
  db.close();
  return row ?? null;
}

/** Sessões recuperáveis (não enviadas / não descartadas). */
export async function listRecoverableSessions(): Promise<PersistedSession[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_SESSIONS, "readonly");
  const all = await idbReq<PersistedSession[]>(tx.objectStore(STORE_SESSIONS).getAll());
  await idbTxDone(tx);
  db.close();
  return all
    .filter((s) =>
      s.status === "recording"
      || s.status === "paused"
      || s.status === "completed"
      || s.status === "uploading",
    )
    .filter((s) => s.byteSize > 0 || s.nextSeq > 0)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export async function deleteRecordingSession(sessionId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_SESSIONS, STORE_CHUNKS], "readwrite");
  const chunks = tx.objectStore(STORE_CHUNKS);
  const idx = chunks.index("bySession");
  const keys = await idbReq<IDBValidKey[]>(idx.getAllKeys(sessionId));
  for (const key of keys) chunks.delete(key);
  tx.objectStore(STORE_SESSIONS).delete(sessionId);
  await idbTxDone(tx);
  db.close();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
