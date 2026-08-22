import { GROQ_CHAT_MODEL } from "./groq-models";
import { CONDOMINIO } from "./condominio";

export type EmailTriage = {
  categoria: "manutencao" | "ruido" | "financeiro" | "juridico" | "administrativo" | "fornecedor" | "spam" | "outro";
  urgencia: "baixa" | "normal" | "alta" | "urgente";
  resumo: string;
  sugestaoResposta: string;
  notasInternas: string;
  /** true se parecer spam/marketing irrelevante */
  isSpam: boolean;
};

const CATEGORIAS = new Set([
  "manutencao", "ruido", "financeiro", "juridico", "administrativo", "fornecedor", "spam", "outro",
]);
const URGENCIAS = new Set(["baixa", "normal", "alta", "urgente"]);

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const raw = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(raw);
}

function fallback(subject: string, body: string): EmailTriage {
  return {
    categoria: "outro",
    urgencia: "normal",
    resumo: `${subject} — ${(body || "").slice(0, 160)}`,
    sugestaoResposta:
      `Exmo/a Sr/a.,\n\n` +
      `Agradecemos o seu email. A administração do ${CONDOMINIO.nome} irá analisar o assunto e responderá em breve.\n\n` +
      `Com os melhores cumprimentos,\nA Administração\n${CONDOMINIO.email}`,
    notasInternas: "Triagem LLM indisponível — rever manualmente.",
    isSpam: false,
  };
}

export async function triarEmailInbox(input: {
  fromEmail: string;
  fromName?: string | null;
  subject: string;
  bodyText: string;
  fracaoNumero?: string | null;
}): Promise<EmailTriage> {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) return fallback(input.subject, input.bodyText);

  const prompt = `És o assistente da administração do ${CONDOMINIO.nome} (caixa ${CONDOMINIO.email}).
Classifica o email recebido e devolve APENAS JSON:
{
  "categoria": "manutencao|ruido|financeiro|juridico|administrativo|fornecedor|spam|outro",
  "urgencia": "baixa|normal|alta|urgente",
  "resumo": "2-4 frases",
  "sugestaoResposta": "rascunho elaborado PT-PT (8-14 linhas) para a administração enviar; formal; não prometas prazos irreais; se spam deixa sugestão vazia",
  "notasInternas": "bullet points só para admin",
  "isSpam": false
}

De: ${input.fromName ?? ""} <${input.fromEmail}>
${input.fracaoNumero ? `Fração provavelmente associada: ${input.fracaoNumero}` : "Fração: não identificada pelo email"}
Assunto: ${input.subject}
Corpo:
${(input.bodyText || "").slice(0, 6000)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_CHAT_MODEL,
        temperature: 0.3,
        max_tokens: 1800,
        messages: [
          { role: "system", content: "Especialista em administração de condomínios. Responde só com JSON válido." },
          { role: "user", content: prompt },
        ],
      }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return fallback(input.subject, input.bodyText);
  }
  clearTimeout(timer);

  if (!response.ok) return fallback(input.subject, input.bodyText);

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) return fallback(input.subject, input.bodyText);

  try {
    const parsed = extractJson(content) as Partial<EmailTriage>;
    const categoria = CATEGORIAS.has(String(parsed.categoria))
      ? (parsed.categoria as EmailTriage["categoria"])
      : "outro";
    const urgencia = URGENCIAS.has(String(parsed.urgencia))
      ? (parsed.urgencia as EmailTriage["urgencia"])
      : "normal";
    const isSpam = Boolean(parsed.isSpam) || categoria === "spam";
    return {
      categoria: isSpam ? "spam" : categoria,
      urgencia: isSpam ? "baixa" : urgencia,
      resumo: String(parsed.resumo ?? "").trim() || fallback(input.subject, input.bodyText).resumo,
      sugestaoResposta: isSpam
        ? ""
        : (String(parsed.sugestaoResposta ?? "").trim() || fallback(input.subject, input.bodyText).sugestaoResposta),
      notasInternas: String(parsed.notasInternas ?? "").trim() || "Sem notas.",
      isSpam,
    };
  } catch {
    return fallback(input.subject, input.bodyText);
  }
}
