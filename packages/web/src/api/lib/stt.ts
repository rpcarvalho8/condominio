import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GROQ_STT_MODEL = "whisper-large-v3-turbo";
const WHISPER_MAX_BYTES = 24 * 1024 * 1024; // 24MB safe margin for Groq's 25MB limit
const CHUNK_TARGET_BYTES = 20 * 1024 * 1024; // 20MB chunks

function hasFfmpeg(): boolean {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function transcribeChunk(fileBlob: File | Blob, filename: string): Promise<string> {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) throw new Error("GROQ_API_KEY não configurada no servidor.");

  const form = new FormData();
  form.append("file", fileBlob, filename);
  form.append("model", GROQ_STT_MODEL);
  form.append("response_format", "verbose_json");
  form.append("language", "pt");

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${groqApiKey}` },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Falha no STT (Groq Whisper): ${response.status} ${body}`);
  }

  const data = await response.json() as { text?: string };
  return data.text?.trim() ?? "";
}

function splitAudioWithFfmpeg(inputPath: string, chunkTargetBytes: number): string[] {
  const tmpDir = path.join(path.dirname(inputPath), `chunks_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const stat = fs.statSync(inputPath);
  const totalBytes = stat.size;
  const numChunks = Math.ceil(totalBytes / chunkTargetBytes);

  // Get duration via ffprobe
  let durationSec: number;
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`,
      { encoding: "utf-8" },
    ).trim();
    durationSec = parseFloat(out);
  } catch {
    durationSec = (totalBytes / chunkTargetBytes) * 600; // rough estimate
  }

  const chunkDuration = Math.floor(durationSec / numChunks);
  const chunkPaths: string[] = [];

  for (let i = 0; i < numChunks; i++) {
    const start = i * chunkDuration;
    const outFile = path.join(tmpDir, `chunk_${i}.webm`);
    execSync(
      `ffmpeg -y -i "${inputPath}" -ss ${start} -t ${chunkDuration} -c:a libopus -b:a 24k "${outFile}"`,
      { stdio: "ignore" },
    );
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
      chunkPaths.push(outFile);
    }
  }

  return chunkPaths;
}

export async function transcribeAudioWithGroq(file: File): Promise<string> {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) throw new Error("GROQ_API_KEY não configurada no servidor.");

  if (file.size <= WHISPER_MAX_BYTES) {
    const text = await transcribeChunk(file, file.name);
    if (!text) throw new Error("Transcrição vazia devolvida pelo STT.");
    return text;
  }

  // File too large — need chunking
  if (!hasFfmpeg()) {
    throw new Error(
      `Ficheiro de áudio demasiado grande (${Math.round(file.size / (1024 * 1024))}MB) para o limite de 25MB do Whisper. ` +
      `Instale ffmpeg no servidor para dividir automaticamente, ou faça upload de um ficheiro mais curto.`
    );
  }

  // Write to temp file
  const tmpDir = path.join(process.cwd(), "data", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `stt_${Date.now()}_${file.name}`);
  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(tmpFile, buffer);

  try {
    const chunkPaths = splitAudioWithFfmpeg(tmpFile, CHUNK_TARGET_BYTES);
    if (chunkPaths.length === 0) {
      throw new Error("Não foi possível dividir o áudio em chunks.");
    }

    const transcriptions: string[] = [];
    for (const chunkPath of chunkPaths) {
      const chunkBuffer = fs.readFileSync(chunkPath);
      const chunkBlob = new Blob([chunkBuffer], { type: "audio/webm" });
      const text = await transcribeChunk(chunkBlob, path.basename(chunkPath));
      if (text) transcriptions.push(text);
    }

    // Cleanup chunks
    for (const cp of chunkPaths) {
      try { fs.unlinkSync(cp); } catch {}
    }
    const chunksDir = path.dirname(chunkPaths[0]);
    try { fs.rmdirSync(chunksDir); } catch {}

    const fullText = transcriptions.join(" ");
    if (!fullText) throw new Error("Transcrição vazia devolvida pelo STT.");
    return fullText;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}
