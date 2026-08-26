import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/Layout";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input, Textarea } from "../components/ui/Input";
import { getToken } from "../lib/auth";
import { formatElapsed, useRecording } from "../lib/RecordingContext";
import { useDraftAutosave } from "../hooks/useDraftAutosave";
import { uploadFileResumable } from "../lib/resumable-upload";
import { humanizeNetworkError } from "../lib/api-client";

type Reuniao = {
  id: string;
  titulo: string;
  data: string;
  tipo: "interna" | "fornecedor";
  fornecedorNome: string | null;
  participantes: string | null;
  transcricao: string | null;
  resumoJson: string | object | null;
  resumo: string | null;
  status: "rascunho" | "processando_audio" | "erro_audio" | "aprovada";
  pdfUrl: string | null;
  approvedAt: string | null;
  audioPath: string | null;
  createdAt: string;
  updatedAt: string;
  processing?: boolean;
  warning?: string;
};

async function apiFetch(path: string, init?: RequestInit, timeoutMs = 60_000) {
  const token = getToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message ?? response.statusText);
    return data;
  } catch (err: any) {
    if (err?.name === "AbortError") throw new Error("Pedido expirou. A transcrição pode demorar — tente novamente.");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{title}</h4>
      <div className="text-sm" style={{ color: "var(--text-primary)" }}>{children}</div>
    </div>
  );
}

function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function ListItems({ items }: { items: unknown }) {
  const list = Array.isArray(items) ? items.map(asText).filter(Boolean) : [];
  if (list.length === 0) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  return (
    <ul className="list-disc pl-5 space-y-0.5">
      {list.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  );
}

function ActionTable({ actions }: { actions: unknown }) {
  const rows = Array.isArray(actions) ? actions : [];
  if (rows.length === 0) return <span style={{ color: "var(--text-muted)" }}>Sem ações registadas.</span>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr>
            <th className="text-left p-1 border-b" style={{ borderColor: "var(--border)" }}>Ação</th>
            <th className="text-left p-1 border-b" style={{ borderColor: "var(--border)" }}>Responsável</th>
            <th className="text-left p-1 border-b" style={{ borderColor: "var(--border)" }}>Prazo</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((raw, i) => {
            const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
            return (
              <tr key={i}>
                <td className="p-1 border-b" style={{ borderColor: "var(--border)" }}>{asText(a.acao || a.decisao) || "—"}</td>
                <td className="p-1 border-b" style={{ borderColor: "var(--border)" }}>{asText(a.responsavel) || "—"}</td>
                <td className="p-1 border-b" style={{ borderColor: "var(--border)" }}>{asText(a.prazo) || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReuniaoInternaView({ content }: { content: any }) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--bg-secondary)" }}>
        <span className="text-xs font-bold uppercase" style={{ color: "var(--blue-primary)" }}>Reunião da Administração</span>
      </div>

      {content.abertura && <Section title="Abertura"><p>{content.abertura}</p></Section>}
      {content.presencas?.length > 0 && <Section title="Presenças"><p>{content.presencas.join(", ")}</p></Section>}
      {content.aprovacaoAtaAnterior && <Section title="Aprovação da ata anterior"><p>{content.aprovacaoAtaAnterior}</p></Section>}
      {content.objetivosReuniao && <Section title="Objetivos da reunião"><p>{content.objetivosReuniao}</p></Section>}

      {content.situacaoFinanceira && (content.situacaoFinanceira.contasCondominio || content.situacaoFinanceira.pagamentosAtraso || content.situacaoFinanceira.despesas || content.situacaoFinanceira.orcamento) && (
        <Section title="Situação financeira">
          <div className="space-y-1 text-sm">
            {content.situacaoFinanceira.contasCondominio && <p><strong>Contas:</strong> {content.situacaoFinanceira.contasCondominio}</p>}
            {content.situacaoFinanceira.pagamentosAtraso && <p><strong>Pagamentos em atraso:</strong> {content.situacaoFinanceira.pagamentosAtraso}</p>}
            {content.situacaoFinanceira.despesas && <p><strong>Despesas:</strong> {content.situacaoFinanceira.despesas}</p>}
            {content.situacaoFinanceira.orcamento && <p><strong>Orçamento:</strong> {content.situacaoFinanceira.orcamento}</p>}
          </div>
        </Section>
      )}

      {content.manutencaoProblemas && (
        (content.manutencaoProblemas.problemasIdentificados?.length > 0 ||
         content.manutencaoProblemas.obrasNecessarias?.length > 0 ||
         content.manutencaoProblemas.situacoesUrgentes?.length > 0 ||
         content.manutencaoProblemas.reclamacoesCondominos?.length > 0) && (
          <Section title="Manutenção e problemas">
            <div className="space-y-2">
              {content.manutencaoProblemas.problemasIdentificados?.length > 0 && <><strong className="text-xs">Problemas:</strong><ListItems items={content.manutencaoProblemas.problemasIdentificados} /></>}
              {content.manutencaoProblemas.obrasNecessarias?.length > 0 && <><strong className="text-xs">Obras necessárias:</strong><ListItems items={content.manutencaoProblemas.obrasNecessarias} /></>}
              {content.manutencaoProblemas.situacoesUrgentes?.length > 0 && <><strong className="text-xs">Urgentes:</strong><ListItems items={content.manutencaoProblemas.situacoesUrgentes} /></>}
              {content.manutencaoProblemas.reclamacoesCondominos?.length > 0 && <><strong className="text-xs">Reclamações:</strong><ListItems items={content.manutencaoProblemas.reclamacoesCondominos} /></>}
            </div>
          </Section>
        )
      )}

      {content.fornecedores && (content.fornecedores.avaliacaoServicos || content.fornecedores.problemas?.length > 0) && (
        <Section title="Fornecedores">
          <div className="space-y-1">
            {content.fornecedores.avaliacaoServicos && <p><strong>Avaliação:</strong> {content.fornecedores.avaliacaoServicos}</p>}
            {content.fornecedores.contratosExistentes && <p><strong>Contratos:</strong> {content.fornecedores.contratosExistentes}</p>}
            {content.fornecedores.problemas?.length > 0 && <ListItems items={content.fornecedores.problemas} />}
            {content.fornecedores.novosOrcamentos && <p><strong>Novos orçamentos:</strong> {content.fornecedores.novosOrcamentos}</p>}
            {content.fornecedores.renovacoesRescisoes && <p><strong>Renovações/Rescisões:</strong> {content.fornecedores.renovacoesRescisoes}</p>}
          </div>
        </Section>
      )}

      {content.decisoesAdministracao?.length > 0 && (
        <Section title="Decisões da administração">
          <ActionTable actions={content.decisoesAdministracao} />
        </Section>
      )}

      {content.preparacaoReunioesFornecedores && (content.preparacaoReunioesFornecedores.questionar?.length > 0 || content.preparacaoReunioesFornecedores.negociar?.length > 0) && (
        <Section title="Preparação de reuniões com fornecedores">
          <div className="space-y-1">
            {content.preparacaoReunioesFornecedores.questionar?.length > 0 && <><strong className="text-xs">Questionar:</strong><ListItems items={content.preparacaoReunioesFornecedores.questionar} /></>}
            {content.preparacaoReunioesFornecedores.negociar?.length > 0 && <><strong className="text-xs">Negociar:</strong><ListItems items={content.preparacaoReunioesFornecedores.negociar} /></>}
            {content.preparacaoReunioesFornecedores.documentacaoNecessaria && <p><strong>Documentação:</strong> {content.preparacaoReunioesFornecedores.documentacaoNecessaria}</p>}
            {content.preparacaoReunioesFornecedores.objetivos?.length > 0 && <><strong className="text-xs">Objetivos:</strong><ListItems items={content.preparacaoReunioesFornecedores.objetivos} /></>}
          </div>
        </Section>
      )}

      {content.outrosAssuntos?.length > 0 && <Section title="Outros assuntos"><ListItems items={content.outrosAssuntos} /></Section>}
      {content.conclusoesProximasAcoes?.length > 0 && <Section title="Conclusões e próximas ações"><ListItems items={content.conclusoesProximasAcoes} /></Section>}
    </div>
  );
}

function ReuniaoFornecedorView({ content }: { content: any }) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--bg-secondary)" }}>
        <span className="text-xs font-bold uppercase" style={{ color: "var(--orange, var(--text-primary))" }}>
          Reunião com Fornecedor — {content.fornecedorNome || "N/I"}
        </span>
      </div>

      {content.apresentacao && (
        <Section title="Apresentação">
          <div className="space-y-1">
            {content.apresentacao.participantes?.length > 0 && <p><strong>Participantes:</strong> {content.apresentacao.participantes.join(", ")}</p>}
            {content.apresentacao.servicoPrestado && <p><strong>Serviço:</strong> {content.apresentacao.servicoPrestado}</p>}
            {content.apresentacao.objetivoReuniao && <p><strong>Objetivo:</strong> {content.apresentacao.objetivoReuniao}</p>}
          </div>
        </Section>
      )}

      {content.balancoServico && (content.balancoServico.funciona?.length > 0 || content.balancoServico.naoFunciona?.length > 0) && (
        <Section title="Balanço do serviço">
          <div className="space-y-1">
            {content.balancoServico.funciona?.length > 0 && <><strong className="text-xs">Funciona:</strong><ListItems items={content.balancoServico.funciona} /></>}
            {content.balancoServico.naoFunciona?.length > 0 && <><strong className="text-xs">Não funciona:</strong><ListItems items={content.balancoServico.naoFunciona} /></>}
            {content.balancoServico.ocorrencias?.length > 0 && <><strong className="text-xs">Ocorrências:</strong><ListItems items={content.balancoServico.ocorrencias} /></>}
            {content.balancoServico.cumprimentoContrato && <p><strong>Cumprimento do contrato:</strong> {content.balancoServico.cumprimentoContrato}</p>}
          </div>
        </Section>
      )}

      {content.problemasAdministracao?.length > 0 && (
        <Section title="Problemas identificados pela administração">
          <ListItems items={content.problemasAdministracao} />
        </Section>
      )}

      {content.posicaoFornecedor && (content.posicaoFornecedor.explicacao || content.posicaoFornecedor.solucoesPropostas?.length > 0) && (
        <Section title="Posição do fornecedor">
          <div className="space-y-1">
            {content.posicaoFornecedor.explicacao && <p><strong>Explicação:</strong> {content.posicaoFornecedor.explicacao}</p>}
            {content.posicaoFornecedor.causas && <p><strong>Causas:</strong> {content.posicaoFornecedor.causas}</p>}
            {content.posicaoFornecedor.solucoesPropostas?.length > 0 && <><strong className="text-xs">Soluções propostas:</strong><ListItems items={content.posicaoFornecedor.solucoesPropostas} /></>}
          </div>
        </Section>
      )}

      {content.necessidadesCondominio && (content.necessidadesCondominio.melhorias?.length > 0 || content.necessidadesCondominio.alteracoesServico?.length > 0 || content.necessidadesCondominio.novasNecessidades?.length > 0) && (
        <Section title="Necessidades do condomínio">
          <div className="space-y-1">
            {content.necessidadesCondominio.melhorias?.length > 0 && <><strong className="text-xs">Melhorias:</strong><ListItems items={content.necessidadesCondominio.melhorias} /></>}
            {content.necessidadesCondominio.alteracoesServico?.length > 0 && <><strong className="text-xs">Alterações ao serviço:</strong><ListItems items={content.necessidadesCondominio.alteracoesServico} /></>}
            {content.necessidadesCondominio.novasNecessidades?.length > 0 && <><strong className="text-xs">Novas necessidades:</strong><ListItems items={content.necessidadesCondominio.novasNecessidades} /></>}
          </div>
        </Section>
      )}

      {content.questoesFinanceiras && (content.questoesFinanceiras.precos || content.questoesFinanceiras.orcamentos || content.questoesFinanceiras.contrato) && (
        <Section title="Questões financeiras/contratuais">
          <div className="space-y-1">
            {content.questoesFinanceiras.precos && <p><strong>Preços:</strong> {content.questoesFinanceiras.precos}</p>}
            {content.questoesFinanceiras.orcamentos && <p><strong>Orçamentos:</strong> {content.questoesFinanceiras.orcamentos}</p>}
            {content.questoesFinanceiras.contrato && <p><strong>Contrato:</strong> {content.questoesFinanceiras.contrato}</p>}
            {content.questoesFinanceiras.condicoes && <p><strong>Condições:</strong> {content.questoesFinanceiras.condicoes}</p>}
            {content.questoesFinanceiras.prazos && <p><strong>Prazos:</strong> {content.questoesFinanceiras.prazos}</p>}
          </div>
        </Section>
      )}

      {content.planoAcao?.length > 0 && (
        <Section title="Plano de ação acordado">
          <ActionTable actions={content.planoAcao} />
        </Section>
      )}

      {content.conclusao && (content.conclusao.decisoesTomadas?.length > 0 || content.conclusao.pontosPendentes?.length > 0) && (
        <Section title="Conclusão">
          <div className="space-y-1">
            {content.conclusao.decisoesTomadas?.length > 0 && <><strong className="text-xs">Decisões tomadas:</strong><ListItems items={content.conclusao.decisoesTomadas} /></>}
            {content.conclusao.pontosPendentes?.length > 0 && <><strong className="text-xs">Pontos pendentes:</strong><ListItems items={content.conclusao.pontosPendentes} /></>}
            {content.conclusao.dataAcompanhamento && <p><strong>Data de acompanhamento:</strong> {content.conclusao.dataAcompanhamento}</p>}
          </div>
        </Section>
      )}
    </div>
  );
}

function StructuredView({ reuniao }: { reuniao: Reuniao }) {
  if (!reuniao.resumoJson) return null;
  try {
    const raw = reuniao.resumoJson;
    const content = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!content || typeof content !== "object") return null;
    if ((content as { tipo?: string }).tipo === "fornecedor") {
      return <ReuniaoFornecedorView content={content} />;
    }
    return <ReuniaoInternaView content={content} />;
  } catch {
    return (
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Não foi possível interpretar o resumo estruturado.
      </p>
    );
  }
}

export default function ReunioesPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>("");
  const [titulo, setTitulo] = useState("");
  const [dataReuniao, setDataReuniao] = useState("");
  const [participantes, setParticipantes] = useState("");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editTitulo, setEditTitulo] = useState("");
  const [editData, setEditData] = useState("");
  const [editParticipantes, setEditParticipantes] = useState("");
  const [editTranscricao, setEditTranscricao] = useState("");
  const [editResumo, setEditResumo] = useState("");
  const [showTranscricao, setShowTranscricao] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [editHydrated, setEditHydrated] = useState(false);

  const recording = useRecording();
  const isThisRecording = recording.target === "reuniao" && recording.status !== "idle";
  const isAnyRecording = recording.status !== "idle";
  const hasPendingSession = recording.sessionTarget === "reuniao";

  const createDraft = useDraftAutosave({
    scope: "reuniao:create",
    value: { titulo, dataReuniao, participantes },
    onRestore: (d) => {
      setTitulo(d.titulo || "");
      setDataReuniao(d.dataReuniao || "");
      setParticipantes(d.participantes || "");
    },
    isEmpty: (d) => !d.titulo?.trim() && !d.dataReuniao && !d.participantes?.trim(),
  });

  const { data: reunioes = [], isLoading } = useQuery<Reuniao[]>({
    queryKey: ["reunioes"],
    queryFn: () => apiFetch("/api/reunioes"),
    refetchInterval: (query) => {
      const rows = query.state.data as Reuniao[] | undefined;
      const busy = rows?.some((r) => r.status === "processando_audio");
      return busy ? 2_500 : false;
    },
  });

  const selected = reunioes.find((r) => r.id === selectedId) ?? null;
  const isProcessing = selected?.status === "processando_audio";
  const isAudioError = selected?.status === "erro_audio";

  const editDraft = useDraftAutosave({
    scope: selectedId ? `reuniao:edit:${selectedId}` : null,
    value: {
      editTitulo,
      editData,
      editParticipantes,
      editTranscricao,
      editResumo,
    },
    enabled: Boolean(selectedId) && editHydrated && selected?.status !== "processando_audio",
    isServerHydrated: editHydrated,
    onRestore: (d) => {
      if (selected?.transcricao && selected.status === "rascunho") return;
      setEditTitulo(d.editTitulo || "");
      setEditData(d.editData || "");
      setEditParticipantes(d.editParticipantes || "");
      setEditTranscricao(d.editTranscricao || "");
      setEditResumo(d.editResumo || "");
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      let uploadId: string | undefined;
      let audioPath: string | undefined;
      if (audioFile) {
        setUploadProgress("A enviar áudio…");
        const uploaded = await uploadFileResumable({
          file: audioFile,
          target: "reuniao",
          filename: audioFile.name,
          onProgress: (p) => {
            const pct = p.totalBytes ? Math.round((100 * p.sentBytes) / p.totalBytes) : 0;
            setUploadProgress(`A enviar áudio… ${pct}% (${p.sentChunks}/${p.totalChunks})`);
          },
        });
        uploadId = uploaded.uploadId;
        audioPath = uploaded.audioPath;
        setUploadProgress("A transcrever áudio e a gerar notas com IA…");
      }
      const form = new FormData();
      form.append("titulo", titulo);
      form.append("data", dataReuniao);
      form.append("participantes", participantes);
      if (uploadId) form.append("uploadId", uploadId);
      if (audioPath) form.append("audioPath", audioPath);
      return apiFetch("/api/reunioes", { method: "POST", body: form }, 300_000);
    },
    onSuccess: (created: Reuniao) => {
      try {
        if (!created?.id) throw new Error("Resposta inválida do servidor.");
        setUploadProgress(null);
        const ready = Boolean(created.transcricao) && created.status === "rascunho";
        setSuccess(
          ready
            ? "Reunião criada com transcrição e notas geradas pela IA."
            : created.status === "erro_audio"
              ? "Reunião criada, mas a geração automática falhou. Pode tentar novamente."
              : "Reunião criada.",
        );
        setError(
          created.status === "erro_audio"
            ? (typeof created.resumo === "string" ? created.resumo : "Falha ao gerar.")
            : "",
        );
        setTitulo("");
        setDataReuniao("");
        setParticipantes("");
        setAudioFile(null);
        createDraft.clear();
        recording.clearSession();
        queryClient.setQueryData<Reuniao[]>(["reunioes"], (old) => {
          const list = old ?? [];
          if (list.some((r) => r.id === created.id)) {
            return list.map((r) => (r.id === created.id ? { ...r, ...created } : r));
          }
          return [created, ...list];
        });
        setSelectedId(created.id);
        setShowTranscricao(Boolean(created.transcricao));
        setEditTitulo(String(created.titulo ?? ""));
        try {
          const d = new Date(created.data);
          setEditData(Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10));
        } catch {
          setEditData("");
        }
        setEditParticipantes(created.participantes ?? "");
        setEditTranscricao(typeof created.transcricao === "string" ? created.transcricao : "");
        setEditResumo(typeof created.resumo === "string" ? created.resumo : "");
        editDraft.clear();
        setEditHydrated(true);
        void queryClient.invalidateQueries({ queryKey: ["reunioes"] });
      } catch (e: any) {
        setUploadProgress(null);
        setError(e?.message ?? "Não foi possível carregar a visualização deste rascunho.");
        setSuccess("");
      }
    },
    onError: (e: any) => {
      setUploadProgress(null);
      setError(humanizeNetworkError(e));
      setSuccess("");
    },
  });

  const reprocessMutation = useMutation({
    mutationFn: () => apiFetch(`/api/reunioes/${selectedId}/reprocessar`, { method: "POST" }, 300_000),
    onSuccess: (updated: Reuniao & { warning?: string }) => {
      if (updated.status === "erro_audio" || updated.warning) {
        setError(updated.warning || updated.resumo || "Falha ao regenerar.");
        setSuccess("");
      } else {
        setSuccess("Transcrição e resumo regenerados a partir do áudio.");
        setError("");
      }
      setShowTranscricao(Boolean(updated.transcricao));
      setEditTranscricao(updated.transcricao ?? "");
      setEditResumo(updated.resumo ?? "");
      editDraft.clear();
      queryClient.setQueryData<Reuniao[]>(["reunioes"], (old) =>
        old?.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)) ?? old,
      );
      void queryClient.invalidateQueries({ queryKey: ["reunioes"] });
    },
    onError: (e: any) => {
      setError(humanizeNetworkError(e));
      setSuccess("");
    },
  });

  const updateMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/reunioes/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titulo: editTitulo,
          data: editData,
          participantes: editParticipantes || null,
          transcricao: editTranscricao,
          resumo: editResumo || null,
        }),
      }),
    onSuccess: () => {
      setSuccess("Notas atualizadas.");
      setError("");
      editDraft.clear();
      void queryClient.invalidateQueries({ queryKey: ["reunioes"] });
    },
    onError: (e: any) => { setError(humanizeNetworkError(e)); setSuccess(""); },
  });

  const approveMutation = useMutation({
    mutationFn: () => apiFetch(`/api/reunioes/${selectedId}/aprovar`, { method: "PATCH" }),
    onSuccess: () => {
      setSuccess("Reunião aprovada e PDF gerado.");
      setError("");
      void queryClient.invalidateQueries({ queryKey: ["reunioes"] });
    },
    onError: (e: any) => { setError(e.message); setSuccess(""); },
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiFetch(`/api/reunioes/${selectedId}`, { method: "DELETE" }),
    onSuccess: () => {
      setSuccess("Reunião eliminada.");
      setError("");
      setSelectedId("");
      void queryClient.invalidateQueries({ queryKey: ["reunioes"] });
    },
    onError: (e: any) => { setError(e.message); setSuccess(""); },
  });

  async function startRecording() {
    setError("");
    try {
      await recording.start("reuniao", { titulo, data: dataReuniao, participantes });
    } catch (e: any) {
      setError(e?.message ?? "Erro ao iniciar gravação.");
    }
  }

  // Restaura título/data/participantes da sessão de gravação (mesmo depois de terminar noutro ecrã)
  useEffect(() => {
    if (!hasPendingSession || !recording.draft) return;
    if (recording.draft.titulo) setTitulo(recording.draft.titulo);
    if (recording.draft.data) setDataReuniao(recording.draft.data);
    if (recording.draft.participantes) setParticipantes(recording.draft.participantes);
  }, [hasPendingSession, recording.draft?.titulo, recording.draft?.data, recording.draft?.participantes]);

  useEffect(() => {
    if (recording.completedTarget !== "reuniao" || !recording.completedFile) return;
    const file = recording.consumeCompletedFile("reuniao");
    if (file) {
      setAudioFile(file);
      if (recording.draft?.titulo) setTitulo(recording.draft.titulo);
      if (recording.draft?.data) setDataReuniao(recording.draft.data);
      if (recording.draft?.participantes) setParticipantes(recording.draft.participantes ?? "");
      setSuccess("Gravação terminada. Confirme os dados e crie a reunião.");
    }
  }, [recording.completedTarget, recording.completedFile]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isThisRecording && !hasPendingSession) return;
    if (!titulo && !dataReuniao && !participantes) return;
    recording.updateDraft({ titulo, data: dataReuniao, participantes });
  }, [titulo, dataReuniao, participantes, isThisRecording, hasPendingSession]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadedIdRef = useRef("");
  const prevStatusRef = useRef("");

  useEffect(() => {
    if (recording.error && (isThisRecording || hasPendingSession)) setError(recording.error);
  }, [recording.error, isThisRecording, hasPendingSession]);

  useEffect(() => {
    if (!selected) {
      loadedIdRef.current = "";
      prevStatusRef.current = "";
      setEditHydrated(false);
      return;
    }
    const idChanged = loadedIdRef.current !== selected.id;
    const finishedProcessing =
      prevStatusRef.current === "processando_audio" && selected.status !== "processando_audio";
    prevStatusRef.current = selected.status;

    if (!idChanged && !finishedProcessing) return;

    loadedIdRef.current = selected.id;
    setEditHydrated(false);
    setEditTitulo(selected.titulo);
    setEditData(new Date(selected.data).toISOString().slice(0, 10));
    setEditParticipantes(selected.participantes ?? "");
    setEditTranscricao(selected.transcricao ?? "");
    setEditResumo(selected.resumo ?? "");
    setShowTranscricao(Boolean(selected.transcricao) || finishedProcessing);
    if (finishedProcessing && selected.status === "rascunho") {
      setSuccess("Transcrição e notas geradas. Pode rever e editar.");
      setError("");
      editDraft.clear();
    }
    if (finishedProcessing && selected.status === "erro_audio") {
      setError(selected.resumo || "Falha ao gerar a transcrição.");
      setSuccess("");
    }
    const t = setTimeout(() => setEditHydrated(true), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só reage a id/status da reunião
  }, [selected?.id, selected?.status, selected?.transcricao, selected?.resumo, selected?.resumoJson]);

  const canCreate = Boolean(titulo.trim() && dataReuniao);

  return (
    <ErrorBoundary
      title="Não foi possível carregar a visualização deste rascunho"
      onReset={() => {
        if (!selected) return;
        setEditTitulo(String(selected.titulo ?? ""));
        try {
          const d = new Date(selected.data);
          setEditData(Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10));
        } catch {
          setEditData("");
        }
        setEditParticipantes(selected.participantes ?? "");
        setEditTranscricao(typeof selected.transcricao === "string" ? selected.transcricao : "");
        setEditResumo(typeof selected.resumo === "string" ? selected.resumo : "");
        setError("");
      }}
    >
      <PageHeader
        title="Notas de Reunião"
        subtitle="Gravação, transcrição e resumo estruturado automático (admin)"
        breadcrumb={["Gestão Condomínio", "Administração", "Reuniões"]}
      />
      <div className="p-6 space-y-6">
        {error && (
          <div className="rounded-lg border px-4 py-3 text-sm" style={{ borderColor: "var(--red)", color: "var(--red)", background: "var(--red-subtle)" }}>
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-lg border px-4 py-3 text-sm" style={{ borderColor: "var(--green)", color: "var(--green)", background: "var(--green-subtle)" }}>
            {success}
          </div>
        )}
        {uploadProgress && (
          <div className="rounded-lg border px-4 py-3 text-sm" style={{ borderColor: "var(--blue-primary)", color: "var(--text-primary)", background: "var(--bg-secondary)" }}>
            {uploadProgress}
          </div>
        )}
        {isProcessing && (
          <div className="rounded-lg border px-4 py-3 text-sm animate-pulse" style={{ borderColor: "var(--blue-primary)", color: "var(--text-primary)", background: "var(--bg-secondary)" }}>
            A transcrever áudio e a gerar notas com IA… Isto pode demorar alguns minutos.
          </div>
        )}
        {isAudioError && selected?.audioPath && (
          <div className="rounded-lg border px-4 py-3 text-sm flex flex-wrap items-center gap-3" style={{ borderColor: "var(--amber)", color: "var(--text-primary)", background: "var(--bg-secondary)" }}>
            <span>A geração automática falhou. O áudio está guardado.</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => reprocessMutation.mutate()}
              loading={reprocessMutation.isPending}
            >
              Tentar novamente gerar
            </Button>
          </div>
        )}
        {(createDraft.statusLabel || editDraft.statusLabel) && (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            {editDraft.statusLabel || createDraft.statusLabel}
          </p>
        )}

        <Card>
          <CardHeader><CardTitle>Nova reunião</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <Input label="Título" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Reunião com fornecedor X" />
            <Input label="Data" type="date" value={dataReuniao} onChange={(e) => setDataReuniao(e.target.value)} />
            <div className="md:col-span-2">
              <Input label="Participantes" value={participantes} onChange={(e) => setParticipantes(e.target.value)} placeholder="Rui, Catarina, Fornecedor X, etc." />
            </div>
            <div className="md:col-span-2 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                {!isThisRecording ? (
                  <Button
                    onClick={startRecording}
                    disabled={!titulo || !dataReuniao || !navigator.mediaDevices || isAnyRecording}
                  >
                    Gravar áudio
                  </Button>
                ) : (
                  <>
                    <span className="text-xs font-medium" style={{ color: "var(--red)" }}>
                      {recording.status === "paused" ? "Em pausa" : "A gravar"} · {formatElapsed(recording.elapsedMs)}
                    </span>
                    <Button variant="secondary" size="sm" onClick={() => recording.stop()}>
                      Terminar gravação
                    </Button>
                  </>
                )}
                {audioFile ? (
                  <span className="text-xs text-gray-500">{audioFile.name}</span>
                ) : (
                  <span className="text-xs text-gray-500">
                    {isThisRecording
                      ? "Pode navegar na app — a gravação continua (barra inferior)."
                      : "Sem áudio (opcional)"}
                  </span>
                )}
              </div>
              <div className="border rounded-lg p-3" style={{ background: "var(--bg-secondary)" }}>
                <Input
                  label="Alternativa: ficheiro de áudio (MP3, M4A, WAV, WEBM)"
                  type="file"
                  accept=".mp3,.m4a,.wav,.webm,audio/*"
                  onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
                />
              </div>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                O sistema detecta automaticamente se é uma reunião interna (administradores) ou com fornecedor, e aplica o layout adequado.
              </p>
            </div>
            <div className="md:col-span-2">
              <Button
                onClick={() => createMutation.mutate()}
                loading={createMutation.isPending}
                disabled={!canCreate}
              >
                Criar reunião
              </Button>
              {!canCreate && (
                <p className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>
                  Preencha o título e a data para criar a reunião
                  {audioFile ? " (áudio já associado)." : "."}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Reuniões existentes</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>A carregar…</p>
            ) : reunioes.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>Sem reuniões registadas.</p>
            ) : (
              <div className="space-y-2">
                {reunioes.map((r) => (
                  <button
                    type="button"
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    className="w-full text-left rounded-lg border px-3 py-2 text-sm"
                    style={{
                      borderColor: selectedId === r.id ? "var(--blue-primary)" : "var(--border)",
                      background: "var(--bg-elevated)",
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-semibold" style={{ color: "var(--text-primary)" }}>{r.titulo}</span>
                      <span className="text-xs rounded px-1.5 py-0.5" style={{
                        background: r.tipo === "fornecedor" ? "var(--orange-subtle, #fef3cd)" : "var(--blue-subtle, #d1ecf1)",
                        color: r.tipo === "fornecedor" ? "var(--orange, #856404)" : "var(--blue-primary, #0c5460)",
                      }}>
                        {r.tipo === "fornecedor" ? `Fornecedor${r.fornecedorNome ? `: ${r.fornecedorNome}` : ""}` : "Interna"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
                      <span>{new Date(r.data).toLocaleDateString("pt-PT")}</span>
                      {r.participantes && <span>· {r.participantes}</span>}
                      {r.status === "aprovada" && <span className="text-xs px-1 rounded" style={{ background: "var(--green-subtle, #d4edda)", color: "var(--green, #155724)" }}>Aprovada</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {selected && (
          <Card>
            <CardHeader><CardTitle>Detalhes da reunião</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <Input label="Título" value={editTitulo} onChange={(e) => setEditTitulo(e.target.value)} />
                <Input label="Data" type="date" value={editData} onChange={(e) => setEditData(e.target.value)} />
              </div>
              <Input label="Participantes" value={editParticipantes} onChange={(e) => setEditParticipantes(e.target.value)} />

              {selected.resumoJson && <StructuredView reuniao={selected} />}

              {!selected.resumoJson && selected.resumo && (
                <Section title="Resumo">
                  <pre className="whitespace-pre-wrap text-sm" style={{ color: "var(--text-primary)" }}>{selected.resumo}</pre>
                </Section>
              )}

              <Textarea label="Resumo (editável)" value={editResumo} onChange={(e) => setEditResumo(e.target.value)} rows={6} />

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h4 className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                    Transcrição {selected.transcricao ? `(${selected.transcricao.length} caracteres)` : "(vazia)"}
                  </h4>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setShowTranscricao(v => !v)}>
                      {showTranscricao ? "Ocultar" : "Mostrar"}
                    </Button>
                    {selected.audioPath && selected.status !== "aprovada" && selected.status !== "processando_audio" && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => reprocessMutation.mutate()}
                        loading={reprocessMutation.isPending}
                      >
                        {isAudioError ? "Tentar novamente gerar" : "Regenerar transcrição"}
                      </Button>
                    )}
                  </div>
                </div>
                {!selected.transcricao && (
                  <p className="text-xs" style={{ color: "var(--amber, #b45309)" }}>
                    Sem texto transcrito. Se existir áudio, use «Regenerar transcrição».
                  </p>
                )}
                {showTranscricao && (
                  <Textarea
                    label="Texto completo (Whisper)"
                    value={editTranscricao}
                    onChange={(e) => setEditTranscricao(e.target.value)}
                    rows={14}
                  />
                )}
              </div>

              {selected.pdfUrl && (
                <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  PDF:{" "}
                  <a href={selected.pdfUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--blue-primary)" }}>
                    Abrir PDF
                  </a>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {selected.status !== "aprovada" && selected.status !== "processando_audio" && (
                  <Button onClick={() => updateMutation.mutate()} loading={updateMutation.isPending}>
                    Guardar alterações
                  </Button>
                )}
                {selected.status !== "aprovada" && selected.status !== "processando_audio" && selected.status !== "erro_audio" && (
                  <Button
                    variant="secondary"
                    onClick={() => approveMutation.mutate()}
                    loading={approveMutation.isPending}
                    disabled={updateMutation.isPending || !selected.transcricao}
                  >
                    Aprovar e gerar PDF
                  </Button>
                )}
                <Button
                  variant="danger"
                  onClick={() => { if (confirm("Eliminar esta reunião?")) deleteMutation.mutate(); }}
                  loading={deleteMutation.isPending}
                >
                  Eliminar
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </ErrorBoundary>
  );
}
