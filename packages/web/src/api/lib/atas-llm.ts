import { GROQ_CHAT_MODEL } from "./groq-models";
import { CONDOMINIO } from "./condominio";
import {
  type AtaConteudo,
  conteudoToMarkdown,
  defaultCabecalho,
  defaultVotos,
  normalizeConteudo,
} from "./ata-conteudo";

const EXEMPLO_PONTO = `O Administrador procedeu à apresentação do Relatório e Contas do exercício de 2025. Após a sua discussão e consequente votação, o referido Relatório e Contas foi aprovado por unanimidade, ficando anexo à presente ata e dela fazendo parte integrante.`;

function buildPrompt(transcricao: string, dataReuniaoISO: string) {
  const cab = defaultCabecalho(new Date(`${dataReuniaoISO}T12:00:00`));

  return `És um assistente jurídico para redigir atas de assembleias de condomínio em português europeu (Portugal).

Data da reunião: ${dataReuniaoISO}

Com base na transcrição abaixo, gera um rascunho de ata em JSON (apenas JSON válido, sem markdown).

O texto final será formatado num modelo legal português. Preenche os campos de forma a permitir essa redacção formal.

MODELO LEGAL (referência — o sistema preenche automaticamente a estrutura; tu deves fornecer os dados em JSON):

"No dia [dia] de [mês] de [ano por extenso], pelas [hora] horas, reuniu na sala do condomínio, a Assembleia Geral [Ordinária/Extraordinária] de Condóminos do CONDOMÍNIO..., para deliberar sobre os assuntos da Ordem de Trabalhos:
1. [item ordem de trabalhos];
2. ...
Encontravam-se presentes: [lista]
Presidiu... [presidente]... secretário [nome]
PONTO 1 – [parágrafo narrativo formal sobre o que foi discutido e deliberado, incluindo votos se mencionados]
PONTO 2 – ...
Nada mais havendo a tratar, foram os trabalhos dados como concluídos..."

Estrutura JSON obrigatória:
{
  "version": 1,
  "cabecalho": {
    "nomeCondominio": "${CONDOMINIO.nome}",
    "nomeCondominioFormal": "${CONDOMINIO.nomeFormal}",
    "morada": "${CONDOMINIO.morada}",
    "localidade": "${CONDOMINIO.localidade}",
    "nif": "${CONDOMINIO.nif}",
    "freguesia": "${CONDOMINIO.freguesia}",
    "concelho": "${CONDOMINIO.concelho}",
    "dataReuniao": "${dataReuniaoISO}",
    "horaInicio": "",
    "horaFim": "",
    "localReuniao": "${CONDOMINIO.localReuniao}",
    "tipoAssembleia": "Ordinária",
    "convocatoriaData": "",
    "presidente": "",
    "secretario": "",
    "presentes": ""
  },
  "pontos": [
    {
      "id": "uuid",
      "titulo": "Apresentação, discussão e votação do Relatório e Contas do exercício de 2025",
      "texto": "${EXEMPLO_PONTO}",
      "discussao": "",
      "deliberacao": "",
      "votos": { "favor": 0, "contra": 0, "abstencao": 0, "source": "manual" }
    }
  ]
}

Regras:
- Identifica cada item da ordem de trabalhos mencionado na transcrição como um elemento em "pontos".
- "titulo": texto curto do item na ordem de trabalhos (ex.: "Eleição da Administração para o exercício de 2026").
- "texto": parágrafo narrativo formal completo do PONTO (começa directamente com a acção, SEM prefixo "PONTO N –"). Usa linguagem jurídica como no exemplo: "O Administrador procedeu...", "Após discussão e consequente votação...", "foi aprovado por unanimidade/maioria de X votos...".
- Preenche horaInicio, horaFim, presidente, secretario, presentes, convocatoriaData, tipoAssembleia se mencionados na transcrição.
- Votos: usa números apenas se explicitamente mencionados; caso contrário 0.
- Não inventes factos. Lacunas: indica "Não identificado na transcrição" no campo adequado.
- Cria APENAS pontos que foram efectivamente mencionados ou discutidos na transcrição. NÃO inventes pontos genéricos. Se a transcrição mencionar apenas 1 assunto, gera apenas 1 ponto. Se não for possível identificar nenhum ponto concreto, gera um único ponto com titulo "Assuntos gerais" e texto indicando que não foram identificados pontos específicos na transcrição.

TRANSCRIÇÃO:
${transcricao}`;
}

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const raw = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(raw);
}

export type RascunhoAtaResult = {
  conteudo: AtaConteudo;
  ataTexto: string;
};

export async function gerarRascunhoAta(transcricao: string, dataReuniao: Date): Promise<RascunhoAtaResult> {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    throw new Error("GROQ_API_KEY não configurada no servidor.");
  }

  const dataISO = dataReuniao.toISOString().slice(0, 10);
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_CHAT_MODEL,
      temperature: 0.2,
      max_tokens: 4500,
      messages: [
        { role: "system", content: "Respondes apenas com JSON válido para atas de condomínio em PT-PT, seguindo o formato legal português." },
        { role: "user", content: buildPrompt(transcricao, dataISO) },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Falha ao gerar rascunho de ata: ${response.status} ${body}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("LLM devolveu rascunho vazio.");

  try {
    const parsed = extractJson(content);
    const conteudo = normalizeConteudo(parsed, dataReuniao);
    if (conteudo.pontos.length === 0) {
      conteudo.pontos.push({
        id: crypto.randomUUID(),
        titulo: "Assuntos gerais",
        texto: "Não foram identificados pontos específicos na transcrição.",
        discussao: "",
        deliberacao: "",
        votos: defaultVotos(),
      });
    }
    return { conteudo, ataTexto: conteudoToMarkdown(conteudo) };
  } catch {
    const fallback = normalizeConteudo({
      version: 1,
      cabecalho: defaultCabecalho(dataReuniao),
      pontos: [{
        id: crypto.randomUUID(),
        titulo: "Assuntos gerais",
        texto: content,
        discussao: "",
        deliberacao: "",
        votos: defaultVotos(),
      }],
    }, dataReuniao);
    return { conteudo: fallback, ataTexto: conteudoToMarkdown(fallback) };
  }
}
