/**
 * Modelos Groq (chat). llama-3.3-70b-versatile foi descontinuado em 2026-08-16.
 * @see https://console.groq.com/docs/deprecations
 */
export const GROQ_CHAT_MODEL =
  process.env.GROQ_CHAT_MODEL ?? "openai/gpt-oss-120b";

/** Respostas curtas / JSON — mais rápido e barato */
export const GROQ_CHAT_MODEL_FAST =
  process.env.GROQ_CHAT_MODEL_FAST ?? "openai/gpt-oss-20b";
