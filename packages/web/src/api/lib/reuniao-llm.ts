import { CONDOMINIO } from "./condominio";
import { GROQ_CHAT_MODEL } from "./groq-models";
import {
  groqChat,
  mapTranscriptionToSyntheses,
  prepareFonteForReduce,
} from "./llm";

/**
 * Meeting type detection and structured summary generation.
 *
 * The system identifies meeting type from audio participants:
 * - If only condominium administrators are present → "interna"
 * - If external people (fornecedores) are detected → "fornecedor"
 *
 * Detection strategy (future-proof):
 * 1. LLM analyses transcription for participant names/roles
 * 2. Cross-references with known admin users from the app (future: DB query)
 * 3. Falls back to heuristic: if anyone NOT in the admin list is present → fornecedor
 */

export type ReuniaoTipo = "interna" | "fornecedor";

export type ReuniaoInternaContent = {
  tipo: "interna";
  abertura: string;
  presencas: string[];
  aprovacaoAtaAnterior: string;
  objetivosReuniao: string;
  situacaoFinanceira: {
    contasCondominio: string;
    pagamentosAtraso: string;
    despesas: string;
    orcamento: string;
  };
  manutencaoProblemas: {
    problemasIdentificados: string[];
    obrasNecessarias: string[];
    situacoesUrgentes: string[];
    reclamacoesCondominos: string[];
  };
  fornecedores: {
    avaliacaoServicos: string;
    contratosExistentes: string;
    problemas: string[];
    novosOrcamentos: string;
    renovacoesRescisoes: string;
  };
  decisoesAdministracao: Array<{
    decisao: string;
    responsavel: string;
    prazo: string;
  }>;
  preparacaoReunioesFornecedores: {
    questionar: string[];
    negociar: string[];
    documentacaoNecessaria: string;
    objetivos: string[];
  };
  outrosAssuntos: string[];
  conclusoesProximasAcoes: string[];
};

export type ReuniaoFornecedorContent = {
  tipo: "fornecedor";
  fornecedorNome: string;
  apresentacao: {
    participantes: string[];
    servicoPrestado: string;
    objetivoReuniao: string;
  };
  balancoServico: {
    funciona: string[];
    naoFunciona: string[];
    ocorrencias: string[];
    cumprimentoContrato: string;
  };
  problemasAdministracao: string[];
  posicaoFornecedor: {
    explicacao: string;
    causas: string;
    solucoesPropostas: string[];
  };
  necessidadesCondominio: {
    melhorias: string[];
    alteracoesServico: string[];
    novasNecessidades: string[];
  };
  questoesFinanceiras: {
    precos: string;
    orcamentos: string;
    contrato: string;
    condicoes: string;
    prazos: string;
  };
  planoAcao: Array<{
    acao: string;
    responsavel: string;
    prazo: string;
  }>;
  conclusao: {
    decisoesTomadas: string[];
    pontosPendentes: string[];
    dataAcompanhamento: string;
  };
};

export type ReuniaoStructuredContent = ReuniaoInternaContent | ReuniaoFornecedorContent;

export type ReuniaoLlmResult = {
  tipo: ReuniaoTipo;
  fornecedorNome: string | null;
  content: ReuniaoStructuredContent;
  resumoTexto: string;
};

const MAP_INSTRUCTIONS =
  "Extrai APENAS os pontos críticos, deliberações, votações e valores monetários num máximo de 350 palavras. Omite saudações, introduções e conversas acessórias.";

const REUNIAO_FINAL_SYSTEM =
  "Respondes apenas com JSON válido para documentar reuniões de condomínio em PT-PT.";

function buildPrompt(fonte: string) {
  return `És um assistente para documentar reuniões de administração de condomínio em português europeu.

CONTEXTO DO CONDOMÍNIO:
- Nome: ${CONDOMINIO.nome}
- Morada: ${CONDOMINIO.morada}

TAREFA:
Analisa a fonte abaixo (transcrição completa OU sínteses Map-Reduce) e:
1. Identifica os participantes mencionados
2. Determina o TIPO de reunião:
   - "interna" → reunião apenas entre administradores/gestores do condomínio (discussão interna de gestão, finanças, manutenção, preparação de decisões)
   - "fornecedor" → reunião com uma empresa/pessoa externa que presta serviços ao condomínio (limpeza, manutenção, segurança, obras, etc.)

PISTA: Se a conversa envolve apenas gestão interna (contas, decisões, problemas do prédio, preparação) → "interna". Se há diálogo com alguém que presta um serviço ou vende algo ao condomínio → "fornecedor".

3. Gera um JSON estruturado conforme o tipo detectado.

FORMATO PARA TIPO "interna":
{
  "tipo": "interna",
  "abertura": "resumo breve da abertura",
  "presencas": ["Nome 1", "Nome 2"],
  "aprovacaoAtaAnterior": "texto ou vazio",
  "objetivosReuniao": "texto",
  "situacaoFinanceira": {
    "contasCondominio": "texto",
    "pagamentosAtraso": "texto",
    "despesas": "texto",
    "orcamento": "texto"
  },
  "manutencaoProblemas": {
    "problemasIdentificados": ["..."],
    "obrasNecessarias": ["..."],
    "situacoesUrgentes": ["..."],
    "reclamacoesCondominos": ["..."]
  },
  "fornecedores": {
    "avaliacaoServicos": "texto",
    "contratosExistentes": "texto",
    "problemas": ["..."],
    "novosOrcamentos": "texto",
    "renovacoesRescisoes": "texto"
  },
  "decisoesAdministracao": [
    { "decisao": "...", "responsavel": "...", "prazo": "..." }
  ],
  "preparacaoReunioesFornecedores": {
    "questionar": ["..."],
    "negociar": ["..."],
    "documentacaoNecessaria": "texto",
    "objetivos": ["..."]
  },
  "outrosAssuntos": ["..."],
  "conclusoesProximasAcoes": ["..."]
}

FORMATO PARA TIPO "fornecedor":
{
  "tipo": "fornecedor",
  "fornecedorNome": "Nome da Empresa",
  "apresentacao": {
    "participantes": ["Nome 1", "Nome 2"],
    "servicoPrestado": "tipo de serviço",
    "objetivoReuniao": "texto"
  },
  "balancoServico": {
    "funciona": ["..."],
    "naoFunciona": ["..."],
    "ocorrencias": ["..."],
    "cumprimentoContrato": "texto"
  },
  "problemasAdministracao": ["Problema 1", "Problema 2"],
  "posicaoFornecedor": {
    "explicacao": "texto",
    "causas": "texto",
    "solucoesPropostas": ["..."]
  },
  "necessidadesCondominio": {
    "melhorias": ["..."],
    "alteracoesServico": ["..."],
    "novasNecessidades": ["..."]
  },
  "questoesFinanceiras": {
    "precos": "texto",
    "orcamentos": "texto",
    "contrato": "texto",
    "condicoes": "texto",
    "prazos": "texto"
  },
  "planoAcao": [
    { "acao": "...", "responsavel": "...", "prazo": "..." }
  ],
  "conclusao": {
    "decisoesTomadas": ["..."],
    "pontosPendentes": ["..."],
    "dataAcompanhamento": ""
  }
}

REGRAS:
- Responde APENAS com JSON válido, sem markdown.
- Preenche cada secção com base no que foi dito na fonte.
- Secções sem informação: usa strings vazias "" ou arrays vazios [].
- NÃO inventes factos — apenas o que está na fonte.
- Arrays de string: se só houver 1 item, usa array com 1 elemento.
- Consolida informação repetida entre sínteses parciais (não dupliques).

FONTE (transcrição ou sínteses):
${fonte}`;
}

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const raw = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(raw);
}

function contentToResumoTexto(content: ReuniaoStructuredContent): string {
  if (content.tipo === "interna") {
    const lines: string[] = [
      "REUNIÃO DA ADMINISTRAÇÃO DO CONDOMÍNIO",
      "",
      `Abertura: ${content.abertura || "—"}`,
      `Presenças: ${content.presencas.length > 0 ? content.presencas.join(", ") : "—"}`,
    ];

    if (content.aprovacaoAtaAnterior) {
      lines.push(`Aprovação da ata anterior: ${content.aprovacaoAtaAnterior}`);
    }
    lines.push(`Objetivos: ${content.objetivosReuniao || "—"}`, "");

    lines.push("SITUAÇÃO FINANCEIRA:");
    if (content.situacaoFinanceira.contasCondominio) lines.push(`  Contas: ${content.situacaoFinanceira.contasCondominio}`);
    if (content.situacaoFinanceira.pagamentosAtraso) lines.push(`  Pagamentos em atraso: ${content.situacaoFinanceira.pagamentosAtraso}`);
    if (content.situacaoFinanceira.despesas) lines.push(`  Despesas: ${content.situacaoFinanceira.despesas}`);
    if (content.situacaoFinanceira.orcamento) lines.push(`  Orçamento: ${content.situacaoFinanceira.orcamento}`);
    lines.push("");

    if (content.manutencaoProblemas.problemasIdentificados.length > 0 ||
        content.manutencaoProblemas.obrasNecessarias.length > 0 ||
        content.manutencaoProblemas.situacoesUrgentes.length > 0 ||
        content.manutencaoProblemas.reclamacoesCondominos.length > 0) {
      lines.push("MANUTENÇÃO E PROBLEMAS:");
      content.manutencaoProblemas.problemasIdentificados.forEach(p => lines.push(`  • ${p}`));
      content.manutencaoProblemas.obrasNecessarias.forEach(p => lines.push(`  • Obra: ${p}`));
      content.manutencaoProblemas.situacoesUrgentes.forEach(p => lines.push(`  ⚠ Urgente: ${p}`));
      content.manutencaoProblemas.reclamacoesCondominos.forEach(p => lines.push(`  • Reclamação: ${p}`));
      lines.push("");
    }

    if (content.decisoesAdministracao.length > 0) {
      lines.push("DECISÕES:");
      content.decisoesAdministracao.forEach(d =>
        lines.push(`  • ${d.decisao} → ${d.responsavel || "?"} (${d.prazo || "sem prazo"})`)
      );
      lines.push("");
    }

    if (content.conclusoesProximasAcoes.length > 0) {
      lines.push("PRÓXIMAS AÇÕES:");
      content.conclusoesProximasAcoes.forEach(a => lines.push(`  • ${a}`));
    }

    return lines.join("\n");
  }

  // fornecedor
  const lines: string[] = [
    `REUNIÃO COM FORNECEDOR — ${content.fornecedorNome}`,
    "",
    `Participantes: ${content.apresentacao.participantes.join(", ") || "—"}`,
    `Serviço: ${content.apresentacao.servicoPrestado || "—"}`,
    `Objetivo: ${content.apresentacao.objetivoReuniao || "—"}`,
    "",
  ];

  if (content.balancoServico.funciona.length > 0 || content.balancoServico.naoFunciona.length > 0) {
    lines.push("BALANÇO DO SERVIÇO:");
    content.balancoServico.funciona.forEach(i => lines.push(`  ✓ ${i}`));
    content.balancoServico.naoFunciona.forEach(i => lines.push(`  ✗ ${i}`));
    if (content.balancoServico.cumprimentoContrato) lines.push(`  Contrato: ${content.balancoServico.cumprimentoContrato}`);
    lines.push("");
  }

  if (content.problemasAdministracao.length > 0) {
    lines.push("PROBLEMAS IDENTIFICADOS:");
    content.problemasAdministracao.forEach(p => lines.push(`  • ${p}`));
    lines.push("");
  }

  if (content.planoAcao.length > 0) {
    lines.push("PLANO DE AÇÃO:");
    content.planoAcao.forEach(a =>
      lines.push(`  • ${a.acao} → ${a.responsavel || "?"} (${a.prazo || "sem prazo"})`)
    );
    lines.push("");
  }

  if (content.conclusao.decisoesTomadas.length > 0 || content.conclusao.pontosPendentes.length > 0) {
    lines.push("CONCLUSÃO:");
    content.conclusao.decisoesTomadas.forEach(d => lines.push(`  • Decisão: ${d}`));
    content.conclusao.pontosPendentes.forEach(p => lines.push(`  • Pendente: ${p}`));
    if (content.conclusao.dataAcompanhamento) lines.push(`  Acompanhamento: ${content.conclusao.dataAcompanhamento}`);
  }

  return lines.join("\n");
}

export async function gerarResumoReuniao(transcricao: string): Promise<ReuniaoLlmResult> {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY não configurada.");

  const fonteBruta = await mapTranscriptionToSyntheses(transcricao, {
    domainHint: "reunião de administração / fornecedor",
    mapInstructions: MAP_INSTRUCTIONS,
  });
  const fonte = await prepareFonteForReduce(fonteBruta, {
    domainHint: "reunião de administração / fornecedor",
    promptOverheadChars: buildPrompt("").length,
    systemPrompt: REUNIAO_FINAL_SYSTEM,
  });

  console.log(`[LLM] Reduce (reuniao-final) com modelo ${GROQ_CHAT_MODEL}...`);

  const content = await groqChat({
    label: "reuniao-final",
    preferPrimary: true,
    temperature: 0.2,
    maxTokens: 3000,
    system: REUNIAO_FINAL_SYSTEM,
    user: buildPrompt(fonte),
  });

  try {
    const parsed = extractJson(content) as ReuniaoStructuredContent;
    const tipo: ReuniaoTipo = parsed.tipo === "fornecedor" ? "fornecedor" : "interna";
    const fornecedorNome = tipo === "fornecedor" ? (parsed as ReuniaoFornecedorContent).fornecedorNome || null : null;

    return {
      tipo,
      fornecedorNome,
      content: parsed,
      resumoTexto: contentToResumoTexto(parsed),
    };
  } catch {
    return {
      tipo: "interna",
      fornecedorNome: null,
      content: {
        tipo: "interna",
        abertura: "",
        presencas: [],
        aprovacaoAtaAnterior: "",
        objetivosReuniao: "",
        situacaoFinanceira: { contasCondominio: "", pagamentosAtraso: "", despesas: "", orcamento: "" },
        manutencaoProblemas: { problemasIdentificados: [], obrasNecessarias: [], situacoesUrgentes: [], reclamacoesCondominos: [] },
        fornecedores: { avaliacaoServicos: "", contratosExistentes: "", problemas: [], novosOrcamentos: "", renovacoesRescisoes: "" },
        decisoesAdministracao: [],
        preparacaoReunioesFornecedores: { questionar: [], negociar: [], documentacaoNecessaria: "", objetivos: [] },
        outrosAssuntos: [content],
        conclusoesProximasAcoes: [],
      },
      resumoTexto: content,
    };
  }
}
