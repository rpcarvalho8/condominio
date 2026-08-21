import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input, Textarea } from "../components/ui/Input";
import { getToken } from "../lib/auth";
import { formatElapsed, useRecording } from "../lib/RecordingContext";
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
  status: "rascunho" | "em_revisao" | "pdf_definitiva" | "aguardando_votos" | "aprovada" | "rejeitada";
  ataTexto: string;
  conteudoJson: string | null;
  resumoDeliberacoes: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  pdfUrl: string | null;
  pdfFinalizedAt: string | null;
  approvalDeadlineAt: string | null;
  audioAvailableUntil: string | null;
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

function loadEditState(ata: Ata) {
  const dataReuniao = new Date(ata.dataReuniao);
  return {
    titulo: ata.titulo,
    data: dataReuniao.toISOString().slice(0, 10),
    resumo: ata.resumoDeliberacoes ?? "",
    conteudo: resolveConteudo(ata.conteudoJson, ata.ataTexto, dataReuniao),
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
  const baselineRef = useRef<EditState | null>(null);
  const [error, setError] = useState<string>("");
  const [success, setSuccess] = useState<string>("");
  const [editTitulo, setEditTitulo] = useState("");
  const [editData, setEditData] = useState("");
  const [editResumo, setEditResumo] = useState("");
  const [editConteudo, setEditConteudo] = useState<AtaConteudo>(() => emptyConteudo(new Date()));
  const [showPreview, setShowPreview] = useState(true);

  const recording = useRecording();
  const isThisRecording = recording.target === "ata" && recording.status !== "idle";
  const isAnyRecording = recording.status !== "idle";
  const hasPendingSession = recording.sessionTarget === "ata";

  const previewTexto = useMemo(
    () => conteudoToTextoFormal(normalizeConteudo(editConteudo, new Date(editData || Date.now()))),
    [editConteudo, editData],
  );

  const { data: atas = [], isLoading } = useQuery<Ata[]>({
    queryKey: ["atas"],
    queryFn: () => apiFetch("/api/atas"),
  });

  const selectedAta = useMemo(
    () => atas.find((ata) => ata.id === selectedAtaId) ?? null,
    [atas, selectedAtaId],
  );

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
    const state = loadEditState(ata);
    baselineRef.current = cloneEditState(state);
    applyEditState(state);
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!audioFile) throw new Error("Selecione um ficheiro de áudio.");
      const form = new FormData();
      form.append("file", audioFile);
      form.append("titulo", titulo);
      form.append("dataReuniao", dataReuniao);
      return apiFetch("/api/atas", { method: "POST", body: form });
    },
    onSuccess: async (created: Ata) => {
      setSuccess("Ata criada em rascunho com transcrição e texto inicial.");
      setError("");
      setTitulo("");
      setDataReuniao("");
      setAudioFile(null);
      recording.clearSession();
      setSelectedAtaId(created.id);
      void queryClient.invalidateQueries({ queryKey: ["atas"] });
    },
    onError: (e: any) => {
      setError(e.message ?? "Erro ao criar ata.");
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
      patchAtaInCache(updated);
      setBaselineFromAta(updated);
    },
    onError: (e: any) => {
      setError(e.message ?? "Erro ao guardar alterações.");
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
      baselineRef.current = null;
      return;
    }
    if (!selectedAta) return;
    if (loadedAtaIdRef.current === selectedAtaId) return;
    loadedAtaIdRef.current = selectedAtaId;
    setBaselineFromAta(selectedAta);
  }, [selectedAtaId, selectedAta]);

  const canCreate = Boolean(titulo.trim() && dataReuniao && audioFile);

  return (
    <>
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
          const editable = ["rascunho", "rejeitada"].includes(selectedAta.status);
          const h = editConteudo.cabecalho;
          return (
          <Card>
            <CardHeader><CardTitle>Revisão e aprovação</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {!editable && (
                <div className="rounded-lg border px-4 py-2 text-xs" style={{ borderColor: "var(--border)", color: "var(--text-muted)", background: "var(--bg-secondary)" }}>
                  Edição bloqueada — estado actual: <strong>{selectedAta.status}</strong>
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

                {editConteudo.pontos.length === 0 ? (
                  <p className="text-sm" style={{ color: "var(--text-muted)" }}>Sem pontos. Adicione ou regenere o rascunho.</p>
                ) : (
                  editConteudo.pontos.map((ponto, index) => (
                    <div key={ponto.id} className="rounded-lg border p-4 space-y-3" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>Ponto {index + 1}</span>
                        {editable && editConteudo.pontos.length > 1 && (
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
                          value={String(ponto.votos.favor)}
                          onChange={(e) => updatePontoVotos(index, "favor", Number(e.target.value) || 0)}
                          disabled={!editable}
                        />
                        <Input
                          label="Votos contra"
                          type="number"
                          min={0}
                          value={String(ponto.votos.contra)}
                          onChange={(e) => updatePontoVotos(index, "contra", Number(e.target.value) || 0)}
                          disabled={!editable}
                        />
                        <Input
                          label="Abstenções"
                          type="number"
                          min={0}
                          value={String(ponto.votos.abstencao)}
                          onChange={(e) => updatePontoVotos(index, "abstencao", Number(e.target.value) || 0)}
                          disabled={!editable}
                        />
                      </div>
                      {ponto.votos.source === "ata_votes" && (
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

                {(selectedAta.status === "rascunho" || selectedAta.status === "em_revisao" || selectedAta.status === "pdf_definitiva" || selectedAta.status === "rejeitada") && (
                  <Button
                    variant="secondary"
                    onClick={() => publicarMutation.mutate()}
                    loading={publicarMutation.isPending}
                    disabled={updateMutation.isPending}
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
    </>
  );
}
