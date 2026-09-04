/**
 * Cliente Groq Chat + utilitários Map-Reduce para transcrições longas.
 */
import {
  GROQ_CHAT_MODEL,
  GROQ_CHAT_MODEL_FALLBACK,
  GROQ_CHAT_MODEL_FAST,
} from "./groq-models";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

/** Acima deste tamanho aplica-se Map-Reduce (chars ≈ tokens*4). */
export const MAP_REDUCE_THRESHOLD_CHARS = 15_000;

/** Tamanho alvo de cada bloco no passo Map. */
export const MAP_CHUNK_CHARS = 12_000;

/** Sobreposição entre blocos para não perder contexto nas juntas. */
export const MAP_CHUNK_OVERLAP_CHARS = 500;

/** Delay entre sínteses Map (respeitar TPM). */
export const MAP_INTER_CALL_DELAY_MS = 1_000;

/** Pausa após Map antes do Reduce (regenerar bucket TPM). */
export const REDUCE_PRE_DELAY_MS = 10_000;

/** Máximo de chars das sínteses Map antes de compressão. */
export const REDUCE_SYNTHESIS_MAX_CHARS = 12_000;

/** Teto de tokens de entrada no Reduce (system + user, excl. max_tokens de saída). */
export const REDUCE_INPUT_MAX_TOKENS = 5_000;

/** Estimativa conservadora: ~4 chars por token. */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export type MapReduceOptions = {
  domainHint?: string;
  /** Instruções extra para cada fatia Map */
  mapInstructions?: string;
};

export type GroqChatOptions = {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** Usa modelo rápido (síntese Map). */
  preferFast?: boolean;
  /** Força o modelo principal (Reduce / ata-final). */
  preferPrimary?: boolean;
  /** Label para logs. */
  label?: string;
};

type GroqChatError = Error & {
  status?: number;
  body?: string;
  rateLimited?: boolean;
  modelUnavailable?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimited(status: number, body: string): boolean {
  if (status === 429 || status === 413) return true;
  const lower = body.toLowerCase();
  return (
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("tpm") ||
    lower.includes("tokens per minute") ||
    lower.includes("too many requests")
  );
}

function isModelUnavailable(status: number, body: string): boolean {
  if (status === 404) return true;
  const lower = body.toLowerCase();
  return (
    lower.includes("model_not_found") ||
    lower.includes("model_decommissioned") ||
    lower.includes("does not exist") ||
    lower.includes("do not have access")
  );
}

/**
 * Divide texto em blocos com sobreposição.
 * Ex.: 37824 chars → ~3–4 blocos de ~12k com overlap 500.
 */
export function splitTranscription(
  text: string,
  chunkSize = MAP_CHUNK_CHARS,
  overlap = MAP_CHUNK_OVERLAP_CHARS,
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= chunkSize) return [trimmed];

  const step = Math.max(1, chunkSize - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < trimmed.length; start += step) {
    const end = Math.min(trimmed.length, start + chunkSize);
    chunks.push(trimmed.slice(start, end));
    if (end >= trimmed.length) break;
  }
  return chunks;
}

type ChatAttempt = {
  model: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
};

async function chatOnce(apiKey: string, attempt: ChatAttempt): Promise<string> {
  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: attempt.model,
      temperature: attempt.temperature,
      max_tokens: attempt.maxTokens,
      messages: [
        { role: "system", content: attempt.system },
        { role: "user", content: attempt.user },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    const err = new Error(`Groq chat ${response.status}: ${body}`) as GroqChatError;
    err.status = response.status;
    err.body = body;
    err.rateLimited = isRateLimited(response.status, body);
    err.modelUnavailable = isModelUnavailable(response.status, body);
    throw err;
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("LLM devolveu resposta vazia.");
  return content;
}

function uniqueModels(list: string[]): string[] {
  const out: string[] = [];
  for (const m of list) {
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * Chat Groq com:
 * - modelo principal (gpt-oss-120b) ou fast (gpt-oss-20b)
 * - fallback em 400/404/model_decommissioned (sem repetir modelos já falhados)
 * - retry + exponential backoff em 413/429/rate_limit
 */
export async function groqChat(opts: GroqChatOptions): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY não configurada no servidor.");

  const preferred = opts.preferPrimary
    ? GROQ_CHAT_MODEL
    : opts.preferFast
      ? GROQ_CHAT_MODEL_FAST
      : GROQ_CHAT_MODEL;
  // Ordem: preferido → principal → fallback (sem duplicados)
  const models = uniqueModels([
    preferred,
    GROQ_CHAT_MODEL,
    GROQ_CHAT_MODEL_FALLBACK,
  ]);

  const temperature = opts.temperature ?? 0.2;
  const maxTokens = opts.maxTokens ?? 4500;
  const label = opts.label ?? "chat";
  let lastError: Error | null = null;

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi]!;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1 || mi > 0) {
          console.log(`[LLM] ${label}: tentativa ${attempt}/${maxAttempts} modelo=${model}`);
        }
        return await chatOnce(apiKey, {
          model,
          system: opts.system,
          user: opts.user,
          temperature,
          maxTokens,
        });
      } catch (e: any) {
        lastError = e;
        const rateLimited = Boolean(e?.rateLimited);
        const modelMissing = Boolean(e?.modelUnavailable);

        // 400/404 / model_decommissioned → fallback imediato (só se houver próximo modelo)
        if (modelMissing) {
          const next = models[mi + 1];
          if (next) {
            if (opts.preferFast && model === GROQ_CHAT_MODEL_FAST) {
              console.warn(
                `[LLM] Modelo rápido indisponível. A usar ${next} no bloco Map...`,
              );
            } else {
              console.warn(
                `[LLM] Modelo ${model} indisponível (${e?.status ?? "?"}). A tentar fallback com ${next}...`,
              );
            }
            break;
          }
          throw e;
        }

        if (rateLimited && attempt < maxAttempts) {
          const waitMs = Math.round(3000 * Math.pow(1.6, attempt - 1) + Math.random() * 800);
          console.warn(
            `[LLM] ${label}: rate limit (TPM) no modelo ${model}. A aguardar ${waitMs}ms…`,
          );
          await sleep(waitMs);
          continue;
        }

        if (mi < models.length - 1) {
          console.warn(
            `[LLM] ${label}: erro em ${model}, a tentar fallback:`,
            String(e?.message ?? e).slice(0, 200),
          );
          break;
        }
        throw e;
      }
    }
  }

  throw lastError ?? new Error(`Falha LLM (${label}).`);
}

/**
 * Passo Map: síntese estruturada de um trecho.
 * Passo Reduce: o chamador junta as sínteses e invoca o prompt principal.
 */
export async function mapTranscriptionToSyntheses(
  transcricao: string,
  opts?: MapReduceOptions,
): Promise<string> {
  const text = transcricao.trim();
  if (text.length <= MAP_REDUCE_THRESHOLD_CHARS) {
    return text;
  }

  const chunks = splitTranscription(text);
  const domain = opts?.domainHint ?? "reunião de condomínio";
  const mapInstructions =
    opts?.mapInstructions ??
    "Extrai APENAS os pontos críticos, deliberações, votações e valores monetários num máximo de 350 palavras. Omite saudações, introduções e conversas acessórias.";

  console.log(
    `[LLM] Transcrição longa detetada (${text.length} chars). A aplicar pipeline Map-Reduce em ${chunks.length} partes...`,
  );
  console.log(
    `[LLM] Modelo Map: ${GROQ_CHAT_MODEL_FAST} (fallback: ${GROQ_CHAT_MODEL}, reserva: ${GROQ_CHAT_MODEL_FALLBACK})`,
  );

  const syntheses: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[LLM] Processando síntese da parte ${i + 1}/${chunks.length}...`);
    const chunk = chunks[i]!;
    const content = await groqChat({
      preferFast: true,
      temperature: 0.1,
      maxTokens: 550,
      label: `map-${i + 1}/${chunks.length}`,
      system:
        "Extrais factos de reuniões em português europeu. Responde de forma extremamente concisa (máx. 350 palavras), sem inventar.",
      user: `És um assistente para documentar uma ${domain}.

${mapInstructions}
Não inventes informação. Se algo não estiver claro, indica "não identificado".
Usa bullets curtos.

TRECHO (${i + 1}/${chunks.length}):
${chunk}`,
    });
    syntheses.push(`--- Síntese parte ${i + 1}/${chunks.length} ---\n${content.trim()}`);

    if (i < chunks.length - 1) {
      await sleep(MAP_INTER_CALL_DELAY_MS);
    }
  }

  console.log(
    "[LLM] Sínteses concluídas. A aguardar 10s para regenerar quota TPM antes da ata final...",
  );
  await sleep(REDUCE_PRE_DELAY_MS);

  return [
    "SÍNTESES PARCIAIS DA TRANSCRIÇÃO (Map-Reduce — usa isto como fonte factual completa):",
    "",
    ...syntheses,
  ].join("\n\n");
}

/**
 * Trunca ou comprime sínteses antes do Reduce para respeitar TPM (~8k/min).
 */
export async function prepareFonteForReduce(
  fonte: string,
  opts?: { domainHint?: string; promptOverheadChars?: number; systemPrompt?: string },
): Promise<string> {
  let prepared = fonte.trim();
  if (!prepared) return prepared;

  const domain = opts?.domainHint ?? "reunião de condomínio";

  if (prepared.length > REDUCE_SYNTHESIS_MAX_CHARS) {
    console.warn(
      `[LLM] Sínteses (${prepared.length} chars) excedem ${REDUCE_SYNTHESIS_MAX_CHARS}. A comprimir antes do Reduce...`,
    );
    try {
      prepared = await groqChat({
        preferFast: true,
        temperature: 0.1,
        maxTokens: 1600,
        label: "reduce-compress",
        system:
          "Condensas sínteses de reuniões em PT-PT. Mantém deliberações, votações e valores. Sem inventar.",
        user: `Condensa as sínteses abaixo num único texto estruturado (máx. 2.500 palavras).
Preserva deliberações, votações, valores monetários, nomes e datas.
Omite repetições e conversa acessória.

${prepared}`,
      });
    } catch (e) {
      console.warn("[LLM] Compressão falhou — a truncar sínteses:", String((e as Error)?.message ?? e));
      prepared = prepared.slice(0, REDUCE_SYNTHESIS_MAX_CHARS);
    }
  }

  const overheadChars =
    (opts?.promptOverheadChars ?? 0) + (opts?.systemPrompt ?? "").length;
  const maxFonteChars = Math.max(
    2_000,
    REDUCE_INPUT_MAX_TOKENS * 4 - overheadChars,
  );

  if (prepared.length > maxFonteChars) {
    console.warn(
      `[LLM] Fonte Reduce truncada ${prepared.length} → ${maxFonteChars} chars (~${REDUCE_INPUT_MAX_TOKENS} tokens máx. de entrada).`,
    );
    prepared =
      prepared.slice(0, maxFonteChars) +
      "\n\n[… texto truncado para respeitar limite TPM do Groq …]";
  }

  const estTokens = estimateTokenCount(
    prepared + (opts?.systemPrompt ?? "") + String(opts?.promptOverheadChars ?? 0),
  );
  console.log(
    `[LLM] Fonte Reduce preparada: ${prepared.length} chars (~${estTokens} tokens estimados de entrada).`,
  );

  return prepared;
}
