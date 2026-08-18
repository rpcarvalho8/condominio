import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input, Textarea } from "../components/ui/Input";
import { getToken } from "../lib/auth";

type Ata = {
  id: string;
  titulo: string;
  dataReuniao: string;
  status: "rascunho" | "em_revisao" | "pdf_definitiva" | "aguardando_votos" | "aprovada" | "rejeitada";
  transcricaoRaw: string;
  ataTexto: string;
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
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? response.statusText);
  return data;
}

export default function AtasPage() {
  const queryClient = useQueryClient();
  const [selectedAtaId, setSelectedAtaId] = useState<string>("");
  const [titulo, setTitulo] = useState("");
  const [dataReuniao, setDataReuniao] = useState("");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [publishingPdf, setPublishingPdf] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [error, setError] = useState<string>("");
  const [success, setSuccess] = useState<string>("");
  const [editTitulo, setEditTitulo] = useState("");
  const [editData, setEditData] = useState("");
  const [editAtaTexto, setEditAtaTexto] = useState("");
  const [editResumo, setEditResumo] = useState("");

  const { data: atas = [], isLoading } = useQuery<Ata[]>({
    queryKey: ["atas"],
    queryFn: () => apiFetch("/api/atas"),
  });

  const selectedAta = useMemo(
    () => atas.find((ata) => ata.id === selectedAtaId) ?? null,
    [atas, selectedAtaId],
  );

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
      setSelectedAtaId(created.id);
      await queryClient.invalidateQueries({ queryKey: ["atas"] });
    },
    onError: (e: any) => {
      setError(e.message ?? "Erro ao criar ata.");
      setSuccess("");
    },
  });

  const updateMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/atas/${selectedAtaId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titulo: editTitulo,
          dataReuniao: editData,
          ataTexto: editAtaTexto,
          resumoDeliberacoes: editResumo || null,
        }),
      }),
    onSuccess: async () => {
      setSuccess("Rascunho atualizado.");
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["atas"] });
    },
    onError: (e: any) => {
      setError(e.message ?? "Erro ao guardar alterações.");
      setSuccess("");
    },
  });

  const approveMutation = useMutation({
    mutationFn: () => apiFetch(`/api/atas/${selectedAtaId}/aprovar`, { method: "PATCH" }),
    onSuccess: async () => {
      setSuccess("Ata aprovada e publicada no portal.");
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["atas"] });
    },
    onError: (e: any) => {
      setError(e.message ?? "Erro ao aprovar ata.");
      setSuccess("");
    },
  });

  const publicarMutation = useMutation({
    mutationFn: async () => {
      if (!selectedAtaId) throw new Error("Selecione uma ata.");
      setPublishingPdf(true);
      return apiFetch(`/api/atas/${selectedAtaId}/publicar`, {
        method: "PATCH",
      });
    },
    onSuccess: async () => {
      setSuccess("PDF gerado e votação aberta no portal (30 min).");
      setError("");
      setPublishingPdf(false);
      await queryClient.invalidateQueries({ queryKey: ["atas"] });
    },
    onError: (e: any) => {
      setError(e.message ?? "Erro ao publicar ata.");
      setSuccess("");
      setPublishingPdf(false);
    },
  });

  const closeVotingMutation = useMutation({
    mutationFn: () => apiFetch(`/api/atas/${selectedAtaId}/fechar-votacao`, { method: "PATCH" }),
    onSuccess: async () => {
      setSuccess("Votação encerrada e resultado publicado.");
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["atas"] });
    },
    onError: (e: any) => {
      setError(e.message ?? "Erro ao fechar votação.");
      setSuccess("");
    },
  });

  async function startRecording() {
    setError("");
    setSuccess("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // iOS Safari: audio/mp4 (não webm). Sem isto a gravação no iPad falha ou gera ficheiro inválido.
      const preferredMimeTypes = [
        "audio/mp4",
        "audio/aac",
        "audio/webm;codecs=opus",
        "audio/webm",
      ];
      const chosenMimeType =
        preferredMimeTypes.find((mt) => (window as any).MediaRecorder?.isTypeSupported?.(mt)) ?? "";

      const recorder = new MediaRecorder(stream, {
        ...(chosenMimeType ? { mimeType: chosenMimeType } : {}),
        audioBitsPerSecond: 24000,
      });
      mediaRecorderRef.current = recorder;
      recordedChunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) recordedChunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const mime = chosenMimeType || recorder.mimeType || "audio/webm";
        const ext = mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a") ? "m4a" : mime.includes("wav") ? "wav" : "webm";
        const blob = new Blob(recordedChunksRef.current, { type: mime });
        const fileName = `ata_${Date.now()}.${ext}`;
        const file = new File([blob], fileName, { type: blob.type || mime });
        setAudioFile(file);

        // Stop tracks
        stream.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        recordedChunksRef.current = [];
      };

      recorder.start();
      setIsRecording(true);
    } catch (e: any) {
      setIsRecording(false);
      setError(e?.message ?? "Erro ao iniciar gravação. Verifica permissões do microfone.");
    }
  }

  function stopRecording() {
    setError("");
    try {
      if (!mediaRecorderRef.current) return;
      if (mediaRecorderRef.current.state !== "inactive") mediaRecorderRef.current.stop();
      setIsRecording(false);
    } catch (e: any) {
      setError(e?.message ?? "Erro ao parar gravação.");
    }
  }

  useEffect(() => {
    if (!selectedAta) return;
    setEditTitulo(selectedAta.titulo);
    setEditData(new Date(selectedAta.dataReuniao).toISOString().slice(0, 10));
    setEditAtaTexto(selectedAta.ataTexto);
    setEditResumo(selectedAta.resumoDeliberacoes ?? "");
  }, [selectedAta]);

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
                {!isRecording ? (
                  <Button
                    onClick={startRecording}
                    loading={createMutation.isPending}
                    disabled={!titulo || !dataReuniao || !navigator.mediaDevices}
                  >
                    Gravar áudio
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={stopRecording}>
                    Parar gravação
                  </Button>
                )}
                {audioFile ? (
                  <span className="text-xs text-gray-500">{audioFile.name}</span>
                ) : (
                  <span className="text-xs text-gray-500">Sem áudio selecionado</span>
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
                disabled={!titulo || !dataReuniao || !audioFile}
              >
                Criar rascunho
              </Button>
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
                  <button
                    key={ata.id}
                    onClick={() => {
                      setSelectedAtaId(ata.id);
                    }}
                    className="w-full text-left rounded-lg border px-3 py-2 text-sm"
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
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {selectedAta && (() => {
          const editable = ["rascunho", "rejeitada"].includes(selectedAta.status);
          return (
          <Card>
            <CardHeader><CardTitle>Revisão e aprovação</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {!editable && (
                <div className="rounded-lg border px-4 py-2 text-xs" style={{ borderColor: "var(--border)", color: "var(--text-muted)", background: "var(--bg-secondary)" }}>
                  Edição bloqueada — estado atual: <strong>{selectedAta.status}</strong>
                </div>
              )}
              <Input label="Título" value={editTitulo} onChange={(e) => setEditTitulo(e.target.value)} disabled={!editable} />
              <Input label="Data da reunião" type="date" value={editData} onChange={(e) => setEditData(e.target.value)} disabled={!editable} />
              <Textarea
                label="Resumo de deliberações"
                value={editResumo}
                onChange={(e) => setEditResumo(e.target.value)}
                rows={4}
                disabled={!editable}
              />
              <Textarea
                label="Ata (texto)"
                value={editAtaTexto}
                onChange={(e) => setEditAtaTexto(e.target.value)}
                rows={18}
                disabled={!editable}
              />
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
                  <Button onClick={() => updateMutation.mutate()} loading={updateMutation.isPending}>
                    Guardar edição
                  </Button>
                )}

                {(selectedAta.status === "rascunho" || selectedAta.status === "em_revisao" || selectedAta.status === "pdf_definitiva" || selectedAta.status === "rejeitada") && (
                  <Button
                    variant="secondary"
                    onClick={() => publicarMutation.mutate()}
                    loading={publicarMutation.isPending || publishingPdf}
                  >
                    {publishingPdf ? "A gerar PDF…" : "Publicar e abrir votação"}
                  </Button>
                )}

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
