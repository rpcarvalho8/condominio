/**
 * Upload resumível de áudio — chunks em disco, assemble no complete.
 * POST /api/uploads → PUT .../chunks/:seq → POST .../complete
 */
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { requireAdmin } from "../middleware/auth";

const UPLOADS_ROOT = path.join(process.cwd(), "data", "uploads");
fs.mkdirSync(UPLOADS_ROOT, { recursive: true });

const MAX_TOTAL_BYTES = 120 * 1024 * 1024;
const MAX_CHUNK_BYTES = 6 * 1024 * 1024;
const ALLOWED_TARGETS = new Set(["reuniao", "ata"]);

type UploadMeta = {
  uploadId: string;
  target: "reuniao" | "ata";
  mimeType: string;
  filename: string;
  status: "uploading" | "completed" | "aborted";
  receivedSeqs: number[];
  byteSize: number;
  createdAt: number;
  finalPath?: string;
  finalRelativePath?: string;
};

function metaPath(uploadId: string) {
  return path.join(UPLOADS_ROOT, uploadId, "meta.json");
}

function chunkPath(uploadId: string, seq: number) {
  return path.join(UPLOADS_ROOT, uploadId, `${String(seq).padStart(6, "0")}.part`);
}

function readMeta(uploadId: string): UploadMeta | null {
  const p = metaPath(uploadId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as UploadMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: UploadMeta) {
  const dir = path.join(UPLOADS_ROOT, meta.uploadId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metaPath(meta.uploadId), JSON.stringify(meta, null, 2));
}

function safeUploadId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{8,80}$/.test(id);
}

export const uploadsRoutes = new Hono()
  .use(requireAdmin)

  .post("/", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const target = String(body.target ?? "reuniao");
    if (!ALLOWED_TARGETS.has(target)) {
      return c.json({ message: "target inválido (reuniao|ata)." }, 400);
    }
    const uploadId = String(body.uploadId || `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    if (!safeUploadId(uploadId)) {
      return c.json({ message: "uploadId inválido." }, 400);
    }
    if (readMeta(uploadId)) {
      const existing = readMeta(uploadId)!;
      return c.json(existing, 200);
    }
    const meta: UploadMeta = {
      uploadId,
      target: target as "reuniao" | "ata",
      mimeType: String(body.mimeType || "audio/webm"),
      filename: String(body.filename || `audio_${uploadId}.webm`),
      status: "uploading",
      receivedSeqs: [],
      byteSize: 0,
      createdAt: Date.now(),
    };
    writeMeta(meta);
    return c.json(meta, 201);
  })

  .get("/:uploadId", async (c) => {
    const uploadId = c.req.param("uploadId");
    const meta = readMeta(uploadId);
    if (!meta) return c.json({ message: "Upload não encontrado." }, 404);
    return c.json(meta);
  })

  .put("/:uploadId/chunks/:seq", async (c) => {
    const uploadId = c.req.param("uploadId");
    const seq = Number(c.req.param("seq"));
    if (!Number.isInteger(seq) || seq < 0) {
      return c.json({ message: "seq inválido." }, 400);
    }
    const meta = readMeta(uploadId);
    if (!meta) return c.json({ message: "Upload não encontrado." }, 404);
    if (meta.status !== "uploading") {
      return c.json({ message: "Upload já concluído ou abortado." }, 409);
    }

    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length === 0) return c.json({ message: "Chunk vazio." }, 400);
    if (buf.length > MAX_CHUNK_BYTES) {
      return c.json({ message: `Chunk > ${MAX_CHUNK_BYTES} bytes.` }, 413);
    }

    const already = meta.receivedSeqs.includes(seq);
    const prevSize = already
      ? (fs.existsSync(chunkPath(uploadId, seq)) ? fs.statSync(chunkPath(uploadId, seq)).size : 0)
      : 0;
    const nextTotal = meta.byteSize - prevSize + buf.length;
    if (nextTotal > MAX_TOTAL_BYTES) {
      return c.json({ message: "Limite total de 120MB excedido." }, 413);
    }

    fs.writeFileSync(chunkPath(uploadId, seq), buf);
    if (!already) meta.receivedSeqs.push(seq);
    meta.receivedSeqs.sort((a, b) => a - b);
    meta.byteSize = nextTotal;
    writeMeta(meta);

    return c.json({
      uploadId,
      seq,
      received: true,
      receivedSeqs: meta.receivedSeqs,
      byteSize: meta.byteSize,
    });
  })

  .post("/:uploadId/complete", async (c) => {
    const uploadId = c.req.param("uploadId");
    const meta = readMeta(uploadId);
    if (!meta) return c.json({ message: "Upload não encontrado." }, 404);
    if (meta.status === "completed" && meta.finalRelativePath) {
      return c.json({
        uploadId,
        audioPath: meta.finalRelativePath,
        filename: path.basename(meta.finalRelativePath),
        byteSize: meta.byteSize,
        alreadyCompleted: true,
      });
    }
    if (meta.receivedSeqs.length === 0) {
      return c.json({ message: "Nenhum chunk recebido." }, 400);
    }

    const destDir =
      meta.target === "ata"
        ? path.join(process.cwd(), "data", "assembleias")
        : path.join(process.cwd(), "data", "reunioes");
    fs.mkdirSync(destDir, { recursive: true });

    const ext = path.extname(meta.filename) || ".webm";
    const filename = `${Date.now()}_${uploadId}${ext}`;
    const absolutePath = path.join(destDir, filename);
    const relativePath = path.join(
      "data",
      meta.target === "ata" ? "assembleias" : "reunioes",
      filename,
    ).replace(/\\/g, "/");

    const outParts: Buffer[] = [];
    for (const seq of meta.receivedSeqs) {
      const part = chunkPath(uploadId, seq);
      if (!fs.existsSync(part)) {
        return c.json({ message: `Chunk em falta: ${seq}` }, 400);
      }
      outParts.push(fs.readFileSync(part));
    }
    fs.writeFileSync(absolutePath, Buffer.concat(outParts));

    meta.status = "completed";
    meta.finalPath = absolutePath;
    meta.finalRelativePath = relativePath;
    writeMeta(meta);

    return c.json({
      uploadId,
      audioPath: relativePath,
      filename,
      byteSize: meta.byteSize,
    });
  })

  .delete("/:uploadId", async (c) => {
    const uploadId = c.req.param("uploadId");
    const dir = path.join(UPLOADS_ROOT, uploadId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return c.json({ ok: true });
  });

/** Resolve caminho absoluto a partir de audioPath relativo (após complete). */
export function resolveUploadedAudioPath(relativePath: string): string | null {
  if (!relativePath || relativePath.includes("..")) return null;
  const abs = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(process.cwd(), relativePath);
  if (!fs.existsSync(abs)) return null;
  return abs;
}
