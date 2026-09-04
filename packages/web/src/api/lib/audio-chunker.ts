/**
 * Divisão de áudio para STT (Whisper limite ~25MB).
 * Usa ffmpeg do sistema ou o binário empacotado em `ffmpeg-static`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Limiar acima do qual fatiamos (margem abaixo dos 25MB do Groq). */
export const STT_CHUNK_THRESHOLD_BYTES = 20 * 1024 * 1024;

/** Duração alvo de cada fatia (10 minutos). A 24 kbps ≈ 1.8 MB/fatia. */
export const STT_SEGMENT_SECONDS = 600;

export type AudioSplitResult = {
  chunkPaths: string[];
  workDir: string;
  mb: number;
};

let cachedFfmpeg: string | null | undefined;

function trySystemFfmpeg(): string | null {
  try {
    const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    if (r.status === 0) return "ffmpeg";
  } catch {
    /* ignore */
  }
  return null;
}

function tryStaticFfmpeg(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("ffmpeg-static") as string | null;
    if (mod && typeof mod === "string" && fs.existsSync(mod)) return mod;
  } catch {
    /* pacote ausente */
  }
  return null;
}

/** Resolve caminho do binário ffmpeg (PATH ou ffmpeg-static). */
export function resolveFfmpegBin(): string | null {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg;
  cachedFfmpeg = trySystemFfmpeg() ?? tryStaticFfmpeg();
  return cachedFfmpeg;
}

export function hasFfmpeg(): boolean {
  return Boolean(resolveFfmpegBin());
}

function runFfmpeg(args: string[], label: string): void {
  const bin = resolveFfmpegBin();
  if (!bin) throw new Error("ffmpeg não disponível.");

  const r = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").slice(-800);
    throw new Error(`ffmpeg falhou (${label}): ${err || `exit ${r.status}`}`);
  }
}

function listChunkFiles(workDir: string): string[] {
  if (!fs.existsSync(workDir)) return [];
  return fs
    .readdirSync(workDir)
    .filter((f) => /^chunk_\d+\.(webm|ogg|m4a|mp3|wav)$/i.test(f))
    .sort()
    .map((f) => path.join(workDir, f))
    .filter((p) => {
      try {
        return fs.statSync(p).size > 0;
      } catch {
        return false;
      }
    });
}

/**
 * Divide áudio em fatias de ~10 minutos, re-codificadas em Opus mono 24 kbps
 * (compatível com Whisper e tipicamente << 20 MB por fatia).
 */
export function splitAudioForStt(
  inputPath: string,
  opts?: { segmentSeconds?: number; workDir?: string },
): AudioSplitResult {
  const bin = resolveFfmpegBin();
  if (!bin) {
    throw new Error(
      "ffmpeg não encontrado. Instale ffmpeg no servidor ou a dependência ffmpeg-static para processar áudios > 20MB.",
    );
  }

  const segmentSeconds = Math.max(60, opts?.segmentSeconds ?? STT_SEGMENT_SECONDS);
  const stat = fs.statSync(inputPath);
  const mb = Math.round((stat.size / (1024 * 1024)) * 10) / 10;

  const workDir = opts?.workDir ?? path.join(
    path.dirname(inputPath),
    `stt_chunks_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  );

  // Reutilizar fatias já existentes (checkpoint / retry)
  if (opts?.workDir && fs.existsSync(workDir)) {
    const existing = listChunkFiles(workDir);
    if (existing.length > 0) {
      console.log(`[STT] A reutilizar ${existing.length} fatia(s) de áudio em cache (${workDir})…`);
      return { chunkPaths: existing, workDir, mb };
    }
  }

  fs.mkdirSync(workDir, { recursive: true });

  const pattern = path.join(workDir, "chunk_%03d.webm");

  // Re-encode: garante fatias válidas + mono 24k (mesmo a partir de m4a/mp3/webm)
  try {
    runFfmpeg(
      [
        "-y",
        "-i", inputPath,
        "-vn",
        "-ac", "1",
        "-c:a", "libopus",
        "-b:a", "24k",
        "-f", "segment",
        "-segment_time", String(segmentSeconds),
        "-reset_timestamps", "1",
        pattern,
      ],
      "segment-opus",
    );
  } catch (e1) {
    // Fallback: segmentação com copy (mais rápida; pode falhar em alguns contentores)
    console.warn("[STT] Re-encode Opus falhou, a tentar -c copy…", String((e1 as Error)?.message ?? e1));
    runFfmpeg(
      [
        "-y",
        "-i", inputPath,
        "-vn",
        "-c", "copy",
        "-f", "segment",
        "-segment_time", String(segmentSeconds),
        "-reset_timestamps", "1",
        pattern,
      ],
      "segment-copy",
    );
  }

  let chunkPaths = listChunkFiles(workDir);

  // Se ainda assim alguma fatia ficar > limiar (raro), subdividir essa fatia
  const oversized = chunkPaths.filter((p) => fs.statSync(p).size > STT_CHUNK_THRESHOLD_BYTES);
  if (oversized.length > 0) {
    console.warn(`[STT] ${oversized.length} fatia(s) ainda > 20MB — a subdividir…`);
    const refined: string[] = [];
    let subIdx = 0;
    for (const chunk of chunkPaths) {
      if (fs.statSync(chunk).size <= STT_CHUNK_THRESHOLD_BYTES) {
        refined.push(chunk);
        continue;
      }
      const subPattern = path.join(workDir, `sub_${String(subIdx).padStart(3, "0")}_%03d.webm`);
      runFfmpeg(
        [
          "-y",
          "-i", chunk,
          "-vn",
          "-ac", "1",
          "-c:a", "libopus",
          "-b:a", "16k",
          "-f", "segment",
          "-segment_time", String(Math.max(120, Math.floor(segmentSeconds / 2))),
          "-reset_timestamps", "1",
          subPattern,
        ],
        "sub-segment",
      );
      try { fs.unlinkSync(chunk); } catch { /* ignore */ }
      const subs = fs
        .readdirSync(workDir)
        .filter((f) => f.startsWith(`sub_${String(subIdx).padStart(3, "0")}_`))
        .sort()
        .map((f) => path.join(workDir, f))
        .filter((p) => fs.existsSync(p) && fs.statSync(p).size > 0);
      refined.push(...subs);
      subIdx++;
    }
    chunkPaths = refined;
  }

  if (chunkPaths.length === 0) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error("Não foi possível dividir o áudio em fatias.");
  }

  console.log(
    `[STT] Áudio de ${mb}MB detetado. Dividido em ${chunkPaths.length} fatia(s) (~${segmentSeconds / 60} min)…`,
  );

  return { chunkPaths, workDir, mb };
}

/** Remove diretório temporário de fatias. */
export function cleanupAudioChunks(workDir: string | null | undefined): void {
  if (!workDir) return;
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
