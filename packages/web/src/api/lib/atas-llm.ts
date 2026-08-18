const GROQ_CHAT_MODEL = "llama-3.3-70b-versatile";

function buildPrompt(transcricao: string, dataReuniaoISO: string) {
  return `És um assistente para redigir atas de assembleias de condomínio em português europeu.

Data da reunião: ${dataReuniaoISO}

Com base na transcrição abaixo, gera um rascunho de ata estruturada em Markdown com estas secções:
1) Título
2) Data e Local
3) Presenças
4) Ordem de Trabalhos
5) Deliberações (lista numerada, objetiva)
6) Tarefas e Responsáveis
7) Encerramento

Regras:
- Não inventes factos. Se algo não estiver claro, escreve "Não identificado na transcrição".
- Linguagem formal, clara e curta.
- Mantém o texto pronto para revisão humana.

TRANSCRIÇÃO:
${transcricao}`;
}

export async function gerarRascunhoAta(transcricao: string, dataReuniao: Date): Promise<string> {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    throw new Error("GROQ_API_KEY não configurada no servidor.");
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_CHAT_MODEL,
      temperature: 0.2,
      max_tokens: 1800,
      messages: [
        { role: "system", content: "Rediges atas de condomínio em PT-PT." },
        { role: "user", content: buildPrompt(transcricao, dataReuniao.toISOString().slice(0, 10)) },
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
  return content;
}
