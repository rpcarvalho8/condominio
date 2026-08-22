/**
 * Modelos Groq (chat).
 * Override via .env: GROQ_CHAT_MODEL / GROQ_CHAT_MODEL_FAST
 *
 * Defaults: modelos de produção Groq (2026).
 * Llama 3.x foi descontinuado — usar gpt-oss ou override no .env.
 * @see https://console.groq.com/docs/models
 * @see https://console.groq.com/docs/deprecations
 */
export const GROQ_CHAT_MODEL =
  process.env.GROQ_CHAT_MODEL ?? "openai/gpt-oss-120b";

/** Respostas curtas / JSON — mais rápido e barato */
export const GROQ_CHAT_MODEL_FAST =
  process.env.GROQ_CHAT_MODEL_FAST ?? "openai/gpt-oss-20b";
