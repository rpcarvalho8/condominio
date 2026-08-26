import { useEffect, useMemo, useRef, useState } from "react";
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
import { apiFetch as sharedApiFetch, humanizeNetworkError } from "../lib/api-client";
import {
  type AtaConteudo,
  type AtaPonto,
  conteudoToTextoFormal,
  defaultVotos,
  emptyConteudo,
  normalizeConteudo,
  resolveConteudo,
} from "../../api/lib/ata-conteudo";

type Ata = {
  id: string;
  titulo: string;
  dataReuniao: string;
  status:
    | "rascunho"
    | "processando_audio"
    | "erro_audio"
    | "em_revisao"
    | "pdf_definitiva"
    | "aguardando_votos"
    | "aprovada"
    | "rejeitada";
  ataTexto: string;
  conteudoJson: string | object | null;
  resumoDeliberacoes: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  pdfUrl: string | null;
  pdfFinalizedAt: string | null;
  approvalDeadlineAt: string | null;
  audioAvailableUntil: string | null;
  hasAudio?: boolean;
  processing?: boolean;
  createdAt: string;
  updatedAt: string;
};

async function apiFetch(path: string, init?: RequestInit) {
  const token = getToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

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
    if (err?.name === "AbortError") {
      throw new Error("Pedido expirou. Verifique a ligação e tente novamente.");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function safeIsoDate(value: unknown): string {
  try {
    const d = value instanceof Date ? value : new Date(String(value ?? ""));
    if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function loadEditState(ata: Ata): {
  titulo: string;
  data: string;
  resumo: string;
  conteudo: AtaConteudo;
} {
  const dataReuniao = (() => {
    try {
      const d = new Date(ata.dataReuniao);
      return Number.isNaN(d.getTime()) ? new Date() : d;
    } catch {
      return new Date();
    }
  })();

  let conteudo: AtaConteudo;
  try {
    conteudo = resolveConteudo(ata.conteudoJson, ata.ataTexto, dataReuniao);
  } catch (e) {
    console.error("[atas] resolveConteudo falhou:", e);
    conteudo = emptyConteudo(dataReuniao);
  }

  return {
    titulo: String(ata.titulo ?? ""),
    data: safeIsoDate(dataReuniao),
    resumo: typeof ata.resumoDeliberacoes === "string" ? ata.resumoDeliberacoes : "",
    conteudo,
  };
}

type EditState = ReturnType<typeof loadEditState>;

function cloneEditState(state: EditState): EditState {
  return { ...state, conteudo: structuredClone(state.conteudo) };
}

export default function AtasPage() {
  const queryClient = useQueryClient();
  const [selectedAtaId, setSelectedAtaId] = useState<string>("");
  const [titulo, setTitulo] = useState("");
  const [dataReuniao, setDataReuniao] = useState("");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const loadedAtaIdRef = useRef<string>("");
  const prevStatusRef = useRef<string>("");
  const baselineRef = useRef<EditState | null>(null);
  const [error, setError] = useState<string>("");
  const [success, setSuccess] = useState<string>("");
  const [editTitulo, setEditTitulo] = useState("");
  const [editData, setEditData] = useState("");
  const [editResumo, setEditResumo] = useState("");
  const [editConteudo, setEditConteudo] = useState<AtaConteudo>(() => emptyConteudo(new Date()));
  const [showPreview, setShowPreview] = useState(true);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [editHydrated, setEditHydrated] = useState(false);

  const recording = useRecording();
  const isThisRecording = recording.target === "ata" && recording.status !== "idle";
  const isAnyRecording = recording.status !== "idle";
  const hasPendingSession = recording.sessionTarget === "ata";

  const createDraft = useDraftAutosave({
    scope: "ata:create",
    value: { titulo, dataReuniao },
    onRestore: (d) => {
      setTitulo(d.titulo || "");
      setDataReuniao(d.dataReuniao || "");
    },
    isEmpty: (d) => !d.titulo?.trim() && !d.dataReuniao,
  });

  const { data: atas = [], isLoading } = useQuery<Ata[]>({
    queryKey: ["atas"],
    queryFn: () => apiFetch("/api/atas"),
    refetchInterval: (query) => {
      const rows = query.state.data as Ata[] | undefined;
      return rows?.some((r) => r.status === "processando_audio") ? 2_500 : false;
    },
  });

  const selectedAta = useMemo(
    () => atas.find((ata) => ata.id === selectedAtaId) ?? null,
    [atas, selectedAtaId],
  );
  const isProcessing = selectedAta?.status === "processando_audio";
  const isAudioError = selectedAta?.status === "erro_audio";
  const hasAudio = Boolean(selectedAta?.hasAudio);

  const editDraftValue = useMemo(
    () => ({ editTitulo, editData, editResumo, editConteudo }),
    [editTitulo, editData, editResumo, editConteudo],
  );

  const editDraft = useDraftAutosave({
    scope: selectedAtaId ? `ata:edit:${selectedAtaId}` : null,
    value: editDraftValue,
    enabled: Boolean(selectedAtaId) && editHydrated && selectedAta?.status !== "processando_audio",
    isServerHydrated: editHydrated,
    onRestore: (d) => {
      // Não restaurar draft local se o servidor já tem conteúdo gerado pela IA
      if (selectedAta?.conteudoJson || (selectedAta?.ataTexto && selectedAta.status === "rascunho")) {
        return;
      }
      setEditTitulo(d.editTitulo || "");
      setEditData(d.editData || "");
      setEditResumo(d.editResumo || "");
      if (d.editConteudo) setEditConteudo(d.editConteudo);
    },
  });

  const previewTexto = useMemo(() => {
    try {
      return conteudoToTextoFormal(normalizeConteudo(editConteudo, new Date(editData || Date.now())));
    } catch (e) {
      console.error("[atas] previewTexto falhou:", e);
      return typeof editConteudo === "string" ? editConteudo : "";
    }
  }, [editConteudo, editData]);

  function patchAtaInCache(updated: Ata) {
    queryClient.setQueryData<Ata[]>(["atas"], (old) =>
      old?.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)) ?? old,
    );
  }

  function applyEditState(state: EditState) {
    setEditTitulo(state.titulo);
    setEditData(state.data);
    setEditResumo(state.resumo);
    setEditConteudo(cloneEditState(state).conteudo);
  }

  function setBaselineFromAta(ata: Ata) {
    try {
      const state = loadEditState(ata);
      baselineRef.current = cloneEditState(state);
      applyEditState(state);
    } catch (e) {
      console.error("[atas] setBaselineFromAta falhou:", e);
      const fallback = emptyConteudo(new Date());
      baselineRef.current = {
        titulo: String(ata?.titulo ?? ""),
        data: safeIsoDate(ata?.dataReuniao),
        resumo: "",
        conteudo: fallback,
      };
      applyEditState(baselineRef.current);
      setError("Não foi possível carregar a visualização deste rascunho.");
    }
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!audioFile) throw new Error("Selecione um ficheiro de áudio.");
      setUploadProgress("A enviar áudio…");
      const uploaded = await uploadFileResumable({
        file: audioFile,
        target: "ata",
        filename: audioFile.name,
        onProgress: (p) => {
          const pct = p.totalBytes ? Math.round((100 * p.sentBytes) / p.totalBytes) : 0;
          setUploadProgress(`A enviar áudio… ${pct}% (${p.sentChunks}/${p.totalChunks})`);
        },
      });
      setUploadProgress("A transcrever áudio e a gerar ata com IA…");
      const form = new FormData();
      form.append("uploadId", uploaded.uploadId);
      form.append("audioPath", uploaded.audioPath);
      form.append("titulo", titulo);
      form.append("dataReuniao", dataReuniao);
      return sharedApiFetch("/api/atas", {
        method: "POST",
        token: getToken(),
        body: form,
        timeoutMs: 300_000,
        retries: 0,
      });
    },
    onSuccess: (created: Ata) => {
      try {
        if (!created?.id) throw new Error("Resposta inválida do servidor.");
        setUploadProgress(null);
        const ready = created.status === "rascunho" && Boolean(created.conteudoJson || created.ataTexto);
        setSuccess(
          ready
            ? "Ata criada com transcrição e rascunho gerados pela IA."
            : created.status === "erro_audio"
              ? "Ata criada, mas a geração automática falhou. Pode tentar novamente."
              : "Ata criada.",
        );
        setError(
          created.status === "erro_audio"
            ? (typeof created.ataTexto === "string" ? created.ataTexto : "Falha ao gerar ata.")
            : "",
        );
        setTitulo("");
        setDataReuniao("");
        setAudioFile(null);
        createDraft.clear();
        recording.clearSession();
        queryClient.setQueryData<Ata[]>(["atas"], (old) => {
          const list = old ?? [];
          if (list.some((a) => a.id === created.id)) {
            return list.map((a) => (a.id === created.id ? { ...a, ...created } : a));
          }
          return [created, ...list];
        });
        setSelectedAtaId(created.id);
        loadedAtaIdRef.current = "";
        prevStatusRef.current = "";
        setEditHydrated(false);
        setBaselineFromAta(created);
        editDraft.clear();
        setTimeout(() => setEditHydrated(true), 0);
        void queryClient.invalidateQueries({ queryKey: ["atas"] });
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
    mutationFn: () =>
      sharedApiFetch(`/api/atas/${selectedAtaId}/reprocessar`, {
        method: "POST",
        token: getToken(),
        timeoutMs: 300_000,
        retries: 0,
      }),
    onSuccess: (updated: Ata) => {
      if (updated.status === "erro_audio") {
        setError(updated.ataTexto || "Falha ao regenerar a ata.");
        setSuccess("");
      } else {
        setSuccess("Transcrição e ata regeneradas a partir do áudio.");
        setError("");
      }
      patchAtaInCache(updated);
      loadedAtaIdRef.current = "";
      prevStatusRef.current = "";
      setBaselineFromAta(updated);
      editDraft.clear();
      void queryClient.invalidateQueries({ queryKey: ["atas"] });
    },
    onError: (e: any) => {
      setError(humanizeNetworkError(e));
      setSuccess("");
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!selectedAtaId) throw new Error("Selecione uma ata.");
      const conteudo = normalizeConteudo(editConteudo, new Date(editData));
      conteudo.cabecalho.dataReuniao = editData;
      return apiFetch(`/api/atas/${selectedAtaId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titulo: editTitulo,
          dataReuniao: editData,
          conteudoJson: conteudo,
          resumoDeliberacoes: editResumo || null,
        }),
      });
    },
    onSuccess: (updated: Ata) => {
      setSuccess("Rascunho atualizado.");
      setError("");
      editDraft.clear();
      patchAtaInCache(updated);
      setBaselineFromAta(updated);
    },
    onError: (e: any) => {
      setError(humanizeNetworkError(e));
      setSuccess("");
    },
  });

  const publicarMutation = useMutation({
    mutationFn: async () => {
      if (!selectedAtaId) throw new Error("Selecione uma ata.");
      return apiFetch(`/api/atas/${selectedAtaId}/publicar`, {
        method: "PATCH",
      });
    },
    onSuccess: (updated: Ata) => {
      setSuccess("PDF gerado e votação aberta no portal (30 min).");
      setError("");
      patchAtaInCache(updated);
      setBaselineFromAta(updated);
    },
    onError: (e: any) => {
      setError(e.message ?? "Erro ao publicar ata.");
      setSuccess("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (ataId: string) =>
      apiFetch(`/api/atas/${ataId}`, { method: "DELETE" }),
    onSuccess: (_data, ataId) => {
      queryClient.setQueryData<Ata[]>(["atas"], (old) => old?.filter((a) => a.id !== ataId));
      if (selectedAtaId === ataId) {
        setSelectedAtaId("");
        loadedAtaIdRef.current = "";
        baselineRef.current = null;
      }
      setSuccess("Ata eliminada.");
      setError("");
    },
    onError: (e: any) => {
      setError(e.message ?? "Erro ao eliminar ata.");
      setSuccess("");
    },
  });

  const closeVotingMutation = useMutation({
    mutationFn: () => apiFetch(`/api/atas/${selectedAtaId}/fechar-votacao`, { method: "PATCH" }),
    onSuccess: (updated: Ata) => {
      setSuccess("Votação encerrada e resultado publicado.");
      setError("");
      patchAtaInCache(updated);
      setBaselineFromAta(updated);
    },
    onError: (e: any) => {
      setError(e.message ?? "Erro ao fechar votação.");
      setSuccess("");
    },
  });

  function discardEdits() {
    if (!baselineRef.current) return;
    applyEditState(baselineRef.current);
    setSuccess("Alterações descartadas.");
    setError("");
  }

  function confirmDeleteAta(ata: Ata) {
    const label = `${ata.titulo} (${new Date(ata.dataReuniao).toLocaleDateString("pt-PT")})`;
    if (!window.confirm(`Eliminar permanentemente a ata «${label}»? Esta acção não pode ser desfeita.`)) {
      return;
    }
    deleteMutation.mutate(ata.id);
  }

  function updateCabecalho(field: keyof AtaConteudo["cabecalho"], value: string) {
    setEditConteudo((prev) => ({
      ...prev,
      cabecalho: { ...prev.cabecalho, [field]: value },
    }));
  }

  function updatePonto(index: number, patch: Partial<AtaPonto>) {
    setEditConteudo((prev) => ({
      ...prev,
      pontos: prev.pontos.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    }));
  }

  function updatePontoVotos(index: number, field: "favor" | "contra" | "abstencao", value: number) {
    setEditConteudo((prev) => ({
      ...prev,
      pontos: prev.pontos.map((p, i) =>
        i === index
          ? { ...p, votos: { ...p.votos, [field]: value, source: "manual" as const } }
          : p,
      ),
    }));
  }

  function addPonto() {
    setEditConteudo((prev) => ({
      ...prev,
      pontos: [
        ...prev.pontos,
        {
          id: crypto.randomUUID(),
          titulo: `Ponto ${prev.pontos.length + 1}`,
          texto: "",
          discussao: "",
          deliberacao: "",
          votos: defaultVotos(),
        },
      ],
    }));
  }

  function removePonto(index: number) {
    setEditConteudo((prev) => ({
      ...prev,
      pontos: prev.pontos.filter((_, i) => i !== index),
    }));
  }

  async function startRecording() {
    setError("");
    setSuccess("");
    try {
      await recording.start("ata", { titulo, data: dataReuniao });
    } catch (e: any) {
      setError(e?.message ?? "Erro ao iniciar gravação.");
    }
  }

  // Restaura título/data após navegar / terminar gravação noutro ecrã
  useEffect(() => {
    if (!hasPendingSession || !recording.draft) return;
    if (recording.draft.titulo) setTitulo(recording.draft.titulo);
    if (recording.draft.data) setDataReuniao(recording.draft.data);
  }, [hasPendingSession, recording.draft?.titulo, recording.draft?.data]);

  useEffect(() => {
    if (recording.completedTarget !== "ata" || !recording.completedFile) return;
    const file = recording.consumeCompletedFile("ata");
    if (file) {
      setAudioFile(file);
      if (recording.draft?.titulo) setTitulo(recording.draft.titulo);
      if (recording.draft?.data) setDataReuniao(recording.draft.data);
      setSuccess("Gravação terminada. Confirme os dados e crie o rascunho.");
    }
  }, [recording.completedTarget, recording.completedFile]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isThisRecording && !hasPendingSession) return;
    if (!titulo && !dataReuniao) return;
    recording.updateDraft({ titulo, data: dataReuniao });
  }, [titulo, dataReuniao, isThisRecording, hasPendingSession]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (recording.error && (isThisRecording || hasPendingSession)) setError(recording.error);
  }, [recording.error, isThisRecording, hasPendingSession]);

  useEffect(() => {
    if (!selectedAtaId) {
      loadedAtaIdRef.current = "";
      prevStatusRef.current = "";
      baselineRef.current = null;
      setEditHydrated(false);
      return;
    }
    if (!selectedAta) return;

    const idChanged = loadedAtaIdRef.current !== selectedAtaId;
    const finishedProcessing =
      prevStatusRef.current === "processando_audio" && selectedAta.status !== "processando_audio";
    prevStatusRef.current = selectedAta.status;

    if (!idChanged && !finishedProcessing) return;

    loadedAtaIdRef.current = selectedAtaId;
    setEditHydrated(false);
    setBaselineFromAta(selectedAta);
    if (finishedProcessing && selectedAta.status === "rascunho") {
      setSuccess("Transcrição e ata geradas. Pode rever e editar.");
      setError("");
      editDraft.clear();
    }
    if (finishedProcessing && selectedAta.status === "erro_audio") {
      setError(selectedAta.ataTexto || "Falha ao gerar a ata a partir do áudio.");
      setSuccess("");
    }
    const t = setTimeout(() => setEditHydrated(true), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hidrata só em mudança de id ou fim do processamento
  }, [
    selectedAtaId,
    selectedAta?.status,
    selectedAta?.conteudoJson,
    selectedAta?.ataTexto,
    selectedAta?.resumoDeliberacoes,
  ]);

  const canCreate = Boolean(titulo.trim() && dataReuniao && audioFile);

  const reloadSelectedDraft = () => {
    if (!selectedAta) return;
    loadedAtaIdRef.current = "";
    prevStatusRef.current = "";
    setBaselineFromAta(selectedAta);
    setEditHydrated(true);
    setError("");
  };

  return (
    <ErrorBoundary
      title="Não foi possível carregar a visualização deste rascunho"
      onReset={reloadSelectedDraft}
    >
      <PageHeader
        title="Atas de Assembleia"
        subtitle="Upload de áudio, rascunho automático e aprovação"
        breadcrumb={["Gestão Condomínio", "Administração", "Atas"]}
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
            A transcrever áudio e a gerar ata com IA… Isto pode demorar alguns minutos.
          </div>
        )}
        {isAudioError && hasAudio && (
          <div className="rounded-lg border px-4 py-3 text-sm flex flex-wrap items-center gap-3" style={{ borderColor: "var(--amber)", color: "var(--text-primary)", background: "var(--bg-secondary)" }}>
            <span>A geração automática falhou. O áudio está guardado.</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => reprocessMutation.mutate()}
              loading={reprocessMutation.isPending}
            >
              Tentar novamente gerar ata
            </Button>
          </div>
        )}
        {(createDraft.statusLabel || editDraft.statusLabel) && (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            {editDraft.statusLabel || createDraft.statusLabel}
          </p>
        )}

        <Card>
          <CardHeader><CardTitle>Nova ata (gravar ou upload áudio)</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <Input label="Título" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Assembleia Geral Ordinária" />
            <Input label="Data da reunião" type="date" value={dataReuniao} onChange={(e) => setDataReuniao(e.target.value)} />
            <div className="md:col-span-2 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                {!isThisRecording ? (
                  <Button
                    onClick={startRecording}
                    loading={createMutation.isPending}
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
                      : "Sem áudio selecionado"}
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
            </div>
            <div className="md:col-span-2">
              <Button
                onClick={() => createMutation.mutate()}
                loading={createMutation.isPending}
                disabled={!canCreate}
              >
                Criar rascunho
              </Button>
              {!canCreate && (
                <p className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>
                  {!audioFile
                    ? "É necessário áudio (gravação ou ficheiro)."
                    : "Preencha o título e a data para criar o rascunho."}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Atas existentes</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>A carregar…</p>
            ) : atas.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>Sem atas ainda.</p>
            ) : (
              <div className="space-y-2">
                {atas.map((ata) => (
                  <div
                    key={ata.id}
                    className="flex items-stretch gap-2"
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedAtaId(ata.id)}
                      className="flex-1 text-left rounded-lg border px-3 py-2 text-sm"
                      style={{
                        borderColor: selectedAtaId === ata.id ? "var(--blue-primary)" : "var(--border)",
                        background: "var(--bg-elevated)",
                      }}
                    >
                      <div className="font-semibold" style={{ color: "var(--text-primary)" }}>{ata.titulo}</div>
                      <div style={{ color: "var(--text-muted)" }}>
                        {new Date(ata.dataReuniao).toLocaleDateString("pt-PT")} · {ata.status}
                      </div>
                    </button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => confirmDeleteAta(ata)}
                      loading={deleteMutation.isPending && deleteMutation.variables === ata.id}
                      disabled={deleteMutation.isPending}
                      className="shrink-0 self-center"
                    >
                      Apagar
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {selectedAta && (() => {
          const editable = ["rascunho", "rejeitada", "erro_audio"].includes(selectedAta.status);
          const h = editConteudo?.cabecalho ?? emptyConteudo(new Date()).cabecalho;
          const pontos = Array.isArray(editConteudo?.pontos) ? editConteudo.pontos : [];
          return (
          <Card>
            <CardHeader><CardTitle>Revisão e aprovação</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {!editable && selectedAta.status !== "processando_audio" && (
                <div className="rounded-lg border px-4 py-2 text-xs" style={{ borderColor: "var(--border)", color: "var(--text-muted)", background: "var(--bg-secondary)" }}>
                  Edição bloqueada — estado actual: <strong>{selectedAta.status}</strong>
                </div>
              )}
              {selectedAta.status === "processando_audio" && (
                <div className="rounded-lg border px-4 py-2 text-xs" style={{ borderColor: "var(--blue-primary)", color: "var(--text-muted)", background: "var(--bg-secondary)" }}>
                  Edição temporariamente bloqueada enquanto o áudio é processado.
                </div>
              )}

              <Input label="Título" value={editTitulo} onChange={(e) => setEditTitulo(e.target.value)} disabled={!editable} />
              <Input label="Data da reunião" type="date" value={editData} onChange={(e) => setEditData(e.target.value)} disabled={!editable} />

              <div className="rounded-lg border p-4 space-y-3" style={{ borderColor: "var(--border)", background: "var(--bg-secondary)" }}>
                <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Cabeçalho</h3>
                <div className="grid gap-3 md:grid-cols-2">
                  <Input label="Condomínio" value={h.nomeCondominio} onChange={(e) => updateCabecalho("nomeCondominio", e.target.value)} disabled={!editable} />
                  <Input label="Designação formal" value={h.nomeCondominioFormal} onChange={(e) => updateCabecalho("nomeCondominioFormal", e.target.value)} disabled={!editable} />
                  <Input label="NIF" value={h.nif} onChange={(e) => updateCabecalho("nif", e.target.value)} disabled={!editable} />
                  <Input label="Morada" value={h.morada} onChange={(e) => updateCabecalho("morada", e.target.value)} disabled={!editable} />
                  <Input label="Freguesia" value={h.freguesia} onChange={(e) => updateCabecalho("freguesia", e.target.value)} disabled={!editable} />
                  <Input label="Concelho" value={h.concelho} onChange={(e) => updateCabecalho("concelho", e.target.value)} disabled={!editable} />
                  <Input label="Hora início" value={h.horaInicio} onChange={(e) => updateCabecalho("horaInicio", e.target.value)} disabled={!editable} placeholder="ex: 21:00" />
                  <Input label="Hora fim" value={h.horaFim} onChange={(e) => updateCabecalho("horaFim", e.target.value)} disabled={!editable} placeholder="ex: 22:30" />
                  <Input label="Local da reunião" value={h.localReuniao} onChange={(e) => updateCabecalho("localReuniao", e.target.value)} disabled={!editable} />
                  <Input label="Tipo de assembleia" value={h.tipoAssembleia} onChange={(e) => updateCabecalho("tipoAssembleia", e.target.value)} disabled={!editable} placeholder="Ordinária ou Extraordinária" />
                  <Input label="Data da convocatória" type="date" value={h.convocatoriaData?.slice(0, 10) ?? ""} onChange={(e) => updateCabecalho("convocatoriaData", e.target.value)} disabled={!editable} />
                  <Input label="Presidente" value={h.presidente} onChange={(e) => updateCabecalho("presidente", e.target.value)} disabled={!editable} />
                  <Input label="Secretário" value={h.secretario} onChange={(e) => updateCabecalho("secretario", e.target.value)} disabled={!editable} />
                </div>
                <Textarea label="Presentes" value={h.presentes} onChange={(e) => updateCabecalho("presentes", e.target.value)} rows={3} disabled={!editable} placeholder="Lista de condóminos presentes ou representados" />
              </div>

              <Textarea
                label="Resumo de deliberações"
                value={editResumo}
                onChange={(e) => setEditResumo(e.target.value)}
                rows={3}
                disabled={!editable}
              />

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Pontos a tratar</h3>
                  {editable && (
                    <Button variant="secondary" size="sm" onClick={addPonto}>
                      Adicionar ponto
                    </Button>
                  )}
                </div>

                {pontos.length === 0 ? (
                  <p className="text-sm" style={{ color: "var(--text-muted)" }}>Sem pontos. Adicione ou regenere o rascunho.</p>
                ) : (
                  pontos.map((ponto, index) => (
                    <div key={ponto.id} className="rounded-lg border p-4 space-y-3" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>Ponto {index + 1}</span>
                        {editable && pontos.length > 1 && (
                          <Button variant="ghost" size="sm" onClick={() => removePonto(index)}>
                            Remover
                          </Button>
                        )}
                      </div>
                      <Input
                        label="Ordem de trabalhos"
                        value={ponto.titulo}
                        onChange={(e) => updatePonto(index, { titulo: e.target.value })}
                        disabled={!editable}
                      />
                      <Textarea
                        label="Texto do ponto (narrativa formal)"
                        value={ponto.texto}
                        onChange={(e) => updatePonto(index, { texto: e.target.value })}
                        rows={6}
                        disabled={!editable}
                        placeholder="Ex.: O Administrador procedeu à apresentação do Relatório e Contas... Após discussão e votação, foi aprovado por unanimidade."
                      />
                      <div className="grid gap-3 sm:grid-cols-3">
                        <Input
                          label="Votos a favor"
                          type="number"
                          min={0}
                          value={String(ponto.votos?.favor ?? 0)}
                          onChange={(e) => updatePontoVotos(index, "favor", Number(e.target.value) || 0)}
                          disabled={!editable}
                        />
                        <Input
                          label="Votos contra"
                          type="number"
                          min={0}
                          value={String(ponto.votos?.contra ?? 0)}
                          onChange={(e) => updatePontoVotos(index, "contra", Number(e.target.value) || 0)}
                          disabled={!editable}
                        />
                        <Input
                          label="Abstenções"
                          type="number"
                          min={0}
                          value={String(ponto.votos?.abstencao ?? 0)}
                          onChange={(e) => updatePontoVotos(index, "abstencao", Number(e.target.value) || 0)}
                          disabled={!editable}
                        />
                      </div>
                      {ponto.votos?.source === "ata_votes" && (
                        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                          Votos preenchidos automaticamente (integração futura com votação no portal).
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>

              <div className="rounded-lg border p-4 space-y-2" style={{ borderColor: "var(--border)", background: "var(--bg-secondary)" }}>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Pré-visualização (formato legal)</h3>
                  <Button variant="ghost" size="sm" onClick={() => setShowPreview((v) => !v)}>
                    {showPreview ? "Ocultar" : "Mostrar"}
                  </Button>
                </div>
                {showPreview && (
                  <pre
                    className="text-xs whitespace-pre-wrap rounded p-3 overflow-auto max-h-96"
                    style={{ color: "var(--text-secondary)", background: "var(--bg-elevated)", fontFamily: "Georgia, 'Times New Roman', serif", lineHeight: 1.6 }}
                  >
                    {previewTexto}
                  </pre>
                )}
              </div>

              {selectedAta.pdfUrl && (
                <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  PDF gerado:{" "}
                  <a href={selectedAta.pdfUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--blue-primary)" }}>
                    {selectedAta.pdfUrl}
                  </a>
                </div>
              )}

              {selectedAta.status === "aguardando_votos" && selectedAta.approvalDeadlineAt && (
                <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  Votação termina em{" "}
                  {Math.max(0, Math.ceil((new Date(selectedAta.approvalDeadlineAt).getTime() - Date.now()) / 60000))} min
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {editable && (
                  <>
                    <Button onClick={() => updateMutation.mutate()} loading={updateMutation.isPending}>
                      Guardar edição
                    </Button>
                    <Button variant="secondary" onClick={discardEdits} disabled={updateMutation.isPending}>
                      Descartar edição
                    </Button>
                  </>
                )}

                {hasAudio && selectedAta.status !== "aprovada" && selectedAta.status !== "processando_audio" && (
                  <Button
                    variant="secondary"
                    onClick={() => reprocessMutation.mutate()}
                    loading={reprocessMutation.isPending}
                  >
                    {isAudioError ? "Tentar novamente gerar ata" : "Regenerar ata a partir do áudio"}
                  </Button>
                )}

                {(selectedAta.status === "rascunho" || selectedAta.status === "em_revisao" || selectedAta.status === "pdf_definitiva" || selectedAta.status === "rejeitada") && (
                  <Button
                    variant="secondary"
                    onClick={() => publicarMutation.mutate()}
                    loading={publicarMutation.isPending}
                    disabled={updateMutation.isPending || isProcessing}
                  >
                    {publicarMutation.isPending ? "A gerar PDF…" : "Publicar e abrir votação"}
                  </Button>
                )}

                <Button
                  variant="danger"
                  onClick={() => confirmDeleteAta(selectedAta)}
                  loading={deleteMutation.isPending}
                  disabled={updateMutation.isPending || publicarMutation.isPending}
                >
                  Eliminar ata
                </Button>

                {selectedAta.status === "aguardando_votos" && (
                  <Button
                    variant="secondary"
                    onClick={() => closeVotingMutation.mutate()}
                    loading={closeVotingMutation.isPending}
                  >
                    Fechar votação (manual)
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
          );
        })()}
      </div>
    </ErrorBoundary>
  );
}
