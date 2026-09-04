/**
 * Modelos Groq (chat) para atas / reuniões / triagem.
 * Override via .env:
 *   GROQ_CHAT_MODEL   — modelo principal (Reduce / ata final)
 *   GROQ_FAST_MODEL   — modelo rápido (Map / sínteses)  [alias: GROQ_CHAT_MODEL_FAST]
 *   GROQ_CHAT_MODEL_FALLBACK — reserva (ex.: rate limit no principal)
 *
 * Migração Groq (Ago 2026): llama-3.3-70b-versatile e mixtral-8x7b-32768 descontinuados.
 * @see https://console.groq.com/docs/deprecations
 * @see https://console.groq.com/docs/models
 */
export const GROQ_CHAT_MODEL =
  process.env.GROQ_CHAT_MODEL ?? "openai/gpt-oss-120b";

/** Respostas curtas / síntese Map — substituto de llama-3.1-8b-instant / llama-3.2-3b */
export const GROQ_CHAT_MODEL_FAST =
  process.env.GROQ_FAST_MODEL ??
  process.env.GROQ_CHAT_MODEL_FAST ??
  "openai/gpt-oss-20b";

/** Alias explícito pedido pela configuração */
export const GROQ_FAST_MODEL = GROQ_CHAT_MODEL_FAST;

/**
 * Fallback genérico (ex.: rate limit no principal).
 * Em 400/404/model_decommissioned o cliente LLM salta para o próximo modelo da cadeia.
 */
export const GROQ_CHAT_MODEL_FALLBACK =
  process.env.GROQ_CHAT_MODEL_FALLBACK ?? "qwen/qwen3.6-27b";
