import { GROQ_CHAT_MODEL, GROQ_CHAT_MODEL_FAST } from "./groq-models";
import { CONDOMINIO } from "./condominio";

export type TicketTriage = {
  categoria: "manutencao" | "ruido" | "financeiro" | "juridico" | "administrativo" | "outro";
  urgencia: "baixa" | "normal" | "alta" | "urgente";
  resumo: string;
  /** Resposta elaborada para o condómino (PT-PT) */
  sugestaoResposta: string;
  /** Notas só para a administração (checklist, riscos, próximos passos) */
  notasInternas: string;
};

const CATEGORIAS = new Set(["manutencao", "ruido", "financeiro", "juridico", "administrativo", "outro"]);
const URGENCIAS = new Set(["baixa", "normal", "alta", "urgente"]);

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const raw = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(raw);
}

function fallbackTriage(titulo: string, descricao: string): TicketTriage {
  return {
    categoria: "outro",
    urgencia: "normal",
    resumo: descricao.slice(0, 200),
    sugestaoResposta:
      `Exmo/a Sr/a.,\n\n` +
      `Confirmamos a receção do seu pedido relativo a «${titulo}».\n\n` +
      `A administração do ${CONDOMINIO.nome} irá analisar a situação e, se necessário, solicitará informação adicional ou marcará uma visita técnica.\n\n` +
      `Manteremos o acompanhamento neste pedido no portal.\n\n` +
      `Com os melhores cumprimentos,\nA Administração`,
    notasInternas: "Sem triagem LLM disponível. Verificar pedido manualmente.",
  };
}

export async function triarPedidoTicket(input: {
  titulo: string;
  descricao: string;
  historico?: string;
  anexosCount?: number;
  /** Casos semelhantes / feedback passado (para aprendizagem futura) */
  exemplosArea?: string;
}): Promise<TicketTriage> {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) return fallbackTriage(input.titulo, input.descricao);

  const prompt = `És o assistente especializado da administração do ${CONDOMINIO.nome} (${CONDOMINIO.morada}, ${CONDOMINIO.localidade}).
Analisa o pedido do condómino e devolve APENAS JSON válido:
{
  "categoria": "manutencao|ruido|financeiro|juridico|administrativo|outro",
  "urgencia": "baixa|normal|alta|urgente",
  "resumo": "2-4 frases objectivas do problema e contexto",
  "sugestaoResposta": "carta/email elaborada em PT-PT (8-14 linhas) para a administração enviar ao condómino: confirma receção, resume o entendimento do problema, indica próximos passos realistas (visita, contacto fornecedor, análise documental), pede dados em falta se necessário, NÃO promete prazos irreais nem admite responsabilidade jurídica",
  "notasInternas": "bullet points só para admin: hipóteses, checklist, riscos, fornecedor típico, se precisa foto/vídeo adicional"
}

Regras de categoria:
- lâmpada/elevador/água/infiltração/obras/partes comuns → manutencao
- barulho/vizinhos → ruido
- quotas/recibos/pagamentos/IBAN → financeiro
- regulamento/assembleia/advogado/acções → juridico
- documentação/geral → administrativo

Urgência alta/urgente só com risco, inundação, falta de elevador, segurança ou impacto imediato em várias frações.
${input.anexosCount ? `O pedido inclui ${input.anexosCount} anexo(s) multimédia.` : "Sem anexos multimédia."}
${input.exemplosArea ? `\nMemória / casos semelhantes desta área:\n${input.exemplosArea}\n` : ""}

Título: ${input.titulo}
Descrição: ${input.descricao}
${input.historico ? `Histórico recente:\n${input.historico}` : ""}`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_CHAT_MODEL,
      temperature: 0.35,
      max_tokens: 1800,
      messages: [
        {
          role: "system",
          content:
            "Especialista em administração de condomínios em Portugal. Respondes apenas com JSON válido. A sugestão de resposta deve ser elaborada e útil, nunca genérica de uma linha.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    // fallback para modelo rápido
    const fast = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_CHAT_MODEL_FAST,
        temperature: 0.3,
        max_tokens: 1200,
        messages: [
          { role: "system", content: "Respondes apenas com JSON válido para triagem de pedidos." },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!fast.ok) {
      const body = await response.text();
      throw new Error(`Falha na triagem LLM: ${response.status} ${body}`);
    }
    const dataFast = await fast.json() as { choices?: Array<{ message?: { content?: string } }> };
    const contentFast = dataFast.choices?.[0]?.message?.content?.trim();
    if (!contentFast) return fallbackTriage(input.titulo, input.descricao);
    return parseTriage(contentFast, input.titulo, input.descricao);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) return fallbackTriage(input.titulo, input.descricao);
  return parseTriage(content, input.titulo, input.descricao);
}

function parseTriage(content: string, titulo: string, descricao: string): TicketTriage {
  try {
    const parsed = extractJson(content) as Partial<TicketTriage>;
    const categoria = CATEGORIAS.has(String(parsed.categoria))
      ? (parsed.categoria as TicketTriage["categoria"])
      : "outro";
    const urgencia = URGENCIAS.has(String(parsed.urgencia))
      ? (parsed.urgencia as TicketTriage["urgencia"])
      : "normal";
    const sugestao = String(parsed.sugestaoResposta ?? "").trim();
    return {
      categoria,
      urgencia,
      resumo: String(parsed.resumo ?? "").trim() || descricao.slice(0, 200),
      sugestaoResposta: sugestao.length > 80 ? sugestao : fallbackTriage(titulo, descricao).sugestaoResposta,
      notasInternas: String(parsed.notasInternas ?? "").trim() || "Sem notas internas.",
    };
  } catch {
    return fallbackTriage(titulo, descricao);
  }
}
