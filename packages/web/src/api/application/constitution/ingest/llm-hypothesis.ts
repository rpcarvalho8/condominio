/**
 * Hipótese opcional de estrutura. Desligada salvo F1_LLM_EXTRACT=1.
 * O resultado não preenche permilagem nem entra na confiança.
 */
import { GROQ_CHAT_MODEL } from "../../../lib/groq-models";
import type { LlmHypothesis } from "./contracts";

export function isLlmExtractEnabled(): boolean {
  return String(process.env.F1_LLM_EXTRACT ?? "0").trim() === "1";
}

export async function readLlmHypothesis(input: {
  text: string;
  fetchImpl?: typeof fetch;
}): Promise<LlmHypothesis | null> {
  if (!isLlmExtractEnabled()) return null;
  const apiKey = String(process.env.GROQ_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_CHAT_MODEL,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Devolve só uma hipótese de estrutura do documento em JSON {\"note\": string}. Não confirmes permilagens.",
          },
          { role: "user", content: input.text.slice(0, 4000) },
        ],
      }),
    });
    if (!response.ok) {
      return { authoritative: false, note: "llm_unavailable", raw: null };
    }
    const raw = (await response.json()) as unknown;
    return { authoritative: false, note: "llm_hypothesis_not_authority", raw };
  } catch {
    return { authoritative: false, note: "llm_unavailable", raw: null };
  }
}
