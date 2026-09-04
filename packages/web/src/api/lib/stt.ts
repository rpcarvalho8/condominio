/**
 * Speech-to-text via Groq Whisper.
 * Áudios > 20MB são fatiados com ffmpeg (10 min / Opus mono 24k) e transcritos em sequência.
 * Checkpoint por fatia em data/stt_cache — retries só processam o que falta.
 */
import fs from "node:fs";
import path from "node:path";
import {
  STT_CHUNK_THRESHOLD_BYTES,
  STT_SEGMENT_SECONDS,
  cleanupAudioChunks,
  hasFfmpeg,
  splitAudioForStt,
} from "./audio-chunker";

const GROQ_STT_MODEL_PRIMARY =
  process.env.GROQ_STT_MODEL ?? "whisper-large-v3-turbo";
const GROQ_STT_MODEL_FALLBACK =
  process.env.GROQ_STT_MODEL_FALLBACK ?? "whisper-large-v3";

const WHISPER_HARD_LIMIT_BYTES = 25 * 1024 * 1024;
const STT_CACHE_ROOT = path.join(process.cwd(), "data", "stt_cache");
const CHUNK_MAX_ATTEMPTS = 3;

export type TranscribeAudioOptions = {
  /** Ex.: `ata_<uuid>` ou `reuniao_<uuid>` — activa checkpoint por fatia */
  cacheKey?: string;
};

type SttCacheMeta = {
  audioSize: number;
  audioMtimeMs: number;
  segmentSeconds: number;
  chunkFiles: string[];
};

type SttApiError = Error & {
  status?: number;
  body?: string;
  retryAfterHeader?: string | null;
  rateLimited?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheRootForKey(cacheKey: string): string {
  const safe = cacheKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(STT_CACHE_ROOT, safe);
}

function cacheChunksDir(cacheKey: string): string {
  return path.join(cacheRootForKey(cacheKey), "chunks");
}

function cacheTextPath(cacheKey: string, index: number): string {
  return path.join(cacheRootForKey(cacheKey), "text", `chunk_${String(index).padStart(3, "0")}.txt`);
}

function cacheMetaPath(cacheKey: string): string {
  return path.join(cacheRootForKey(cacheKey), "meta.json");
}

function readCacheMeta(cacheKey: string): SttCacheMeta | null {
  const p = cacheMetaPath(cacheKey);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as SttCacheMeta;
  } catch {
    return null;
  }
}

function writeCacheMeta(cacheKey: string, meta: SttCacheMeta): void {
  const root = cacheRootForKey(cacheKey);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(cacheMetaPath(cacheKey), JSON.stringify(meta, null, 2));
}

function clearSttCache(cacheKey: string): void {
  const root = cacheRootForKey(cacheKey);
  try {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function audioFingerprint(absolutePath: string): { size: number; mtimeMs: number } {
  const stat = fs.statSync(absolutePath);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function cacheMatchesAudio(meta: SttCacheMeta, absolutePath: string): boolean {
  const fp = audioFingerprint(absolutePath);
  return meta.audioSize === fp.size && meta.audioMtimeMs === fp.mtimeMs;
}

function readCachedChunkText(cacheKey: string, index: number): string | null {
  const p = cacheTextPath(cacheKey, index);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, "utf8").trim();
  return text || null;
}

function writeCachedChunkText(cacheKey: string, index: number, text: string): void {
  const dir = path.join(cacheRootForKey(cacheKey), "text");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cacheTextPath(cacheKey, index), text, "utf8");
}

/** Copia fatias de áudio para cache persistente (retry sem re-ffmpeg). */
function persistAudioChunksToCache(
  cacheKey: string,
  chunkPaths: string[],
  absolutePath: string,
  segmentSeconds: number,
): string {
  const chunksDir = cacheChunksDir(cacheKey);
  fs.mkdirSync(chunksDir, { recursive: true });

  const chunkFiles: string[] = [];
  for (let i = 0; i < chunkPaths.length; i++) {
    const src = chunkPaths[i]!;
    const name = `chunk_${String(i).padStart(3, "0")}${path.extname(src) || ".webm"}`;
    const dest = path.join(chunksDir, name);
    if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
      fs.copyFileSync(src, dest);
    }
    chunkFiles.push(name);
  }

  const fp = audioFingerprint(absolutePath);
  writeCacheMeta(cacheKey, {
    audioSize: fp.size,
    audioMtimeMs: fp.mtimeMs,
    segmentSeconds,
    chunkFiles,
  });

  return chunksDir;
}

function loadCachedChunkPaths(cacheKey: string): string[] | null {
  const meta = readCacheMeta(cacheKey);
  if (!meta?.chunkFiles?.length) return null;
  const chunksDir = cacheChunksDir(cacheKey);
  const paths = meta.chunkFiles.map((f) => path.join(chunksDir, f));
  if (paths.every((p) => fs.existsSync(p) && fs.statSync(p).size > 0)) {
    return paths;
  }
  return null;
}

function isRateLimited(status: number, body: string): boolean {
  if (status === 429 || status === 413) return true;
  const lower = body.toLowerCase();
  return (
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("asph") ||
    lower.includes("too many requests")
  );
}

/**
 * Extrai segundos de espera de Retry-After ou corpo Groq ("Please try again in 2m46s").
 */
export function parseRetryWaitSeconds(
  status: number,
  body: string,
  retryAfterHeader: string | null,
  attempt: number,
): number {
  if (retryAfterHeader) {
    const secs = parseInt(retryAfterHeader, 10);
    if (!Number.isNaN(secs) && secs > 0) return secs;
  }

  const tryAgain = body.match(/try again in\s+(?:(\d+)\s*m)?\s*(\d+)\s*s/i);
  if (tryAgain) {
    const mins = tryAgain[1] ? parseInt(tryAgain[1], 10) : 0;
    const secs = parseInt(tryAgain[2]!, 10);
    if (!Number.isNaN(secs)) return mins * 60 + secs;
  }

  const compact = body.match(/(\d+)\s*m\s*(\d+)\s*s/i);
  if (compact) {
    const mins = parseInt(compact[1]!, 10);
    const secs = parseInt(compact[2]!, 10);
    if (!Number.isNaN(mins) && !Number.isNaN(secs)) return mins * 60 + secs;
  }

  const secondsOnly = body.match(/(?:in|after)\s+(\d+)\s*seconds?/i);
  if (secondsOnly) {
    const n = parseInt(secondsOnly[1]!, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }

  if (status === 429) {
    const backoff = [30, 60, 120];
    return backoff[Math.min(attempt - 1, backoff.length - 1)]!;
  }

  return 30;
}

async function transcribeChunkOnce(
  fileBlob: File | Blob,
  filename: string,
  model: string,
): Promise<string> {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) throw new Error("GROQ_API_KEY não configurada no servidor.");

  const form = new FormData();
  form.append("file", fileBlob, filename);
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("language", "pt");

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${groqApiKey}` },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text();
    const err = new Error(`Falha no STT (Groq Whisper): ${response.status} ${body}`) as SttApiError;
    err.status = response.status;
    err.body = body;
    err.retryAfterHeader = response.headers.get("retry-after");
    err.rateLimited = isRateLimited(response.status, body);
    throw err;
  }

  const data = await response.json() as { text?: string };
  return data.text?.trim() ?? "";
}

/** Transcreve uma fatia com até 3 tentativas, espera inteligente em 429 e fallback de modelo. */
async function transcribeChunkWithRetry(
  fileBlob: File | Blob,
  filename: string,
  label: string,
): Promise<string> {
  const models = [GROQ_STT_MODEL_PRIMARY];
  if (GROQ_STT_MODEL_FALLBACK && GROQ_STT_MODEL_FALLBACK !== GROQ_STT_MODEL_PRIMARY) {
    models.push(GROQ_STT_MODEL_FALLBACK);
  }

  let lastError: Error | null = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= CHUNK_MAX_ATTEMPTS; attempt++) {
      try {
        if (attempt > 1 || model !== GROQ_STT_MODEL_PRIMARY) {
          console.log(`[STT] ${label}: tentativa ${attempt}/${CHUNK_MAX_ATTEMPTS} modelo=${model}`);
        }
        return await transcribeChunkOnce(fileBlob, filename, model);
      } catch (e: any) {
        lastError = e;
        const rateLimited = Boolean(e?.rateLimited);
        const isLastAttempt = attempt >= CHUNK_MAX_ATTEMPTS;
        const isLastModel = model === models[models.length - 1];

        if (rateLimited && !isLastAttempt) {
          const waitSec = parseRetryWaitSeconds(
            e?.status ?? 429,
            String(e?.body ?? e?.message ?? ""),
            e?.retryAfterHeader ?? null,
            attempt,
          );
          console.warn(
            `[STT] Rate limit atingido na ${label}. A aguardar ${waitSec} segundos antes de tentar novamente...`,
          );
          await sleep(waitSec * 1000);
          continue;
        }

        if (rateLimited && !isLastModel) {
          console.warn(
            `[STT] Rate limit persistente em ${model}. A tentar fallback Whisper ${GROQ_STT_MODEL_FALLBACK}...`,
          );
          break; // próximo modelo
        }

        if (!isLastModel) {
          console.warn(`[STT] ${label} falhou em ${model}:`, String(e?.message ?? e).slice(0, 200));
          break;
        }

        throw e;
      }
    }
  }

  throw lastError ?? new Error(`Falha STT (${label}).`);
}

async function transcribePathList(
  chunkPaths: string[],
  opts?: { cacheKey?: string },
): Promise<string> {
  const parts: string[] = new Array(chunkPaths.length).fill("");
  const total = chunkPaths.length;
  let cachedCount = 0;

  for (let i = 0; i < total; i++) {
    const cacheKey = opts?.cacheKey;
    if (cacheKey) {
      const cached = readCachedChunkText(cacheKey, i);
      if (cached) {
        parts[i] = cached;
        cachedCount++;
        console.log(`[STT] Fatia ${i + 1}/${total} já em cache (${cached.length} chars) — a saltar.`);
        continue;
      }
    }

    const chunkPath = chunkPaths[i]!;
    const sizeMb = Math.round((fs.statSync(chunkPath).size / (1024 * 1024)) * 10) / 10;
    console.log(`[STT] Transcrevendo fatia ${i + 1}/${total} (${sizeMb}MB)…`);

    if (fs.statSync(chunkPath).size > WHISPER_HARD_LIMIT_BYTES) {
      throw new Error(
        `Fatia ${i + 1}/${total} ainda excede 25MB após divisão. Reduza o bitrate na gravação.`,
      );
    }

    const buf = fs.readFileSync(chunkPath);
    const mime = guessMimeFromName(chunkPath);
    const blob = new Blob([buf], { type: mime });
    const text = await transcribeChunkWithRetry(
      blob,
      path.basename(chunkPath),
      `fatia ${i + 1}/${total}`,
    );

    if (text) {
      parts[i] = text;
      if (cacheKey) writeCachedChunkText(cacheKey, i, text);
    }
  }

  if (cachedCount > 0) {
    console.log(`[STT] Checkpoint: ${cachedCount}/${total} fatia(s) reutilizadas do cache.`);
  }

  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

async function transcribeLargeFileFromDisk(
  absolutePath: string,
  displayName: string,
  opts?: TranscribeAudioOptions,
): Promise<string> {
  const size = fs.statSync(absolutePath).size;
  const mb = Math.round((size / (1024 * 1024)) * 10) / 10;
  const cacheKey = opts?.cacheKey;

  if (!hasFfmpeg()) {
    throw new Error(
      `Ficheiro de áudio demasiado grande (${mb}MB) para o limite de 25MB do Whisper. ` +
      `Instale ffmpeg (ou a dependência ffmpeg-static) para divisão automática em fatias.`,
    );
  }

  console.log(`[STT] Iniciando transcrição do áudio... (${displayName}, ${mb}MB)`);

  let chunkPaths: string[] = [];
  let ephemeralWorkDir: string | null = null;

  if (cacheKey) {
    const meta = readCacheMeta(cacheKey);
    if (meta && cacheMatchesAudio(meta, absolutePath)) {
      const cachedPaths = loadCachedChunkPaths(cacheKey);
      if (cachedPaths?.length) {
        chunkPaths = cachedPaths;
        console.log(
          `[STT] Cache STT válido (${cacheKey}): ${chunkPaths.length} fatia(s) de áudio, a retomar transcrição...`,
        );
      }
    } else if (meta) {
      console.log(`[STT] Cache STT inválido (áudio alterado) — a limpar ${cacheKey}`);
      clearSttCache(cacheKey);
    }
  }

  if (chunkPaths.length === 0) {
    const { chunkPaths: splitPaths, workDir, mb: splitMb } = splitAudioForStt(absolutePath);
    console.log(`[STT] Áudio de ${splitMb}MB detetado. Dividido em ${splitPaths.length} fatias...`);
    chunkPaths = splitPaths;
    ephemeralWorkDir = workDir;

    if (cacheKey) {
      persistAudioChunksToCache(cacheKey, chunkPaths, absolutePath, STT_SEGMENT_SECONDS);
      console.log(`[STT] Fatias de áudio persistidas em cache (${cacheKey}).`);
    }
  }

  try {
    const fullText = await transcribePathList(chunkPaths, { cacheKey });
    if (!fullText) throw new Error("Transcrição vazia devolvida pelo STT.");
    console.log(`[STT] Transcrição concluída (${fullText.length} chars, ${chunkPaths.length} fatias).`);

    if (cacheKey) {
      clearSttCache(cacheKey);
      console.log(`[STT] Cache STT limpo após sucesso (${cacheKey}).`);
    }

    return fullText;
  } finally {
    if (ephemeralWorkDir) cleanupAudioChunks(ephemeralWorkDir);
  }
}

export async function transcribeAudioWithGroq(
  file: File,
  opts?: TranscribeAudioOptions,
): Promise<string> {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) throw new Error("GROQ_API_KEY não configurada no servidor.");

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error("Ficheiro de áudio vazio — não é possível transcrever.");
  }

  const mime = file.type || guessMimeFromName(file.name);
  const safeName = file.name || `audio_${Date.now()}${extFromMime(mime)}`;
  const mb = Math.round((buffer.length / (1024 * 1024)) * 10) / 10;

  if (buffer.length <= STT_CHUNK_THRESHOLD_BYTES) {
    console.log(`[STT] Iniciando transcrição do áudio... (${safeName}, ${mb}MB, directo)`);
    const fileForApi = new File([buffer], safeName, { type: mime });
    const text = await transcribeChunkWithRetry(fileForApi, safeName, "áudio completo");
    if (!text) throw new Error("Transcrição vazia devolvida pelo STT.");
    console.log(`[STT] Transcrição concluída (${text.length} chars).`);
    return text;
  }

  const tmpDir = path.join(process.cwd(), "data", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(
    tmpDir,
    `stt_${Date.now()}_${safeName.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
  );
  fs.writeFileSync(tmpFile, buffer);

  try {
    return await transcribeLargeFileFromDisk(tmpFile, safeName, opts);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

/** Transcreve a partir de um path já gravado em disco (evita re-ler File consumido). */
export async function transcribeAudioFilePath(
  absolutePath: string,
  originalName?: string,
  opts?: TranscribeAudioOptions,
): Promise<string> {
  if (!fs.existsSync(absolutePath)) {
    throw new Error("Ficheiro de áudio não encontrado no servidor.");
  }
  const size = fs.statSync(absolutePath).size;
  if (size === 0) throw new Error("Ficheiro de áudio vazio — não é possível transcrever.");

  const name = originalName || path.basename(absolutePath);
  const mb = Math.round((size / (1024 * 1024)) * 10) / 10;

  if (size <= STT_CHUNK_THRESHOLD_BYTES) {
    console.log(`[STT] Iniciando transcrição do áudio... (${name}, ${mb}MB, directo)`);
    const buffer = fs.readFileSync(absolutePath);
    const mime = guessMimeFromName(name);
    const file = new File([buffer], name, { type: mime });
    const text = await transcribeChunkWithRetry(file, name, "áudio completo");
    if (!text) throw new Error("Transcrição vazia devolvida pelo STT.");
    console.log(`[STT] Transcrição concluída (${text.length} chars).`);
    return text;
  }

  return transcribeLargeFileFromDisk(absolutePath, name, opts);
}

function guessMimeFromName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".webm") return "audio/webm";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".m4a" || ext === ".mp4") return "audio/mp4";
  return "application/octet-stream";
}

function extFromMime(mime: string): string {
  if (mime.includes("mpeg") || mime.includes("mp3")) return ".mp3";
  if (mime.includes("wav")) return ".wav";
  if (mime.includes("ogg")) return ".ogg";
  if (mime.includes("webm")) return ".webm";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return ".m4a";
  return ".bin";
}
