import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input, Textarea } from "../components/ui/Input";
import { getToken } from "../lib/auth";

type Reuniao = {
  id: string;
  titulo: string;
  data: string;
  participantes: string | null;
  transcricao: string | null;
  resumo: string | null;
  audioPath: string | null;
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

export default function ReunioesPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>("");
  const [titulo, setTitulo] = useState("");
  const [dataReuniao, setDataReuniao] = useState("");
  const [participantes, setParticipantes] = useState("");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editTitulo, setEditTitulo] = useState("");
  const [editData, setEditData] = useState("");
  const [editParticipantes, setEditParticipantes] = useState("");
  const [editTranscricao, setEditTranscricao] = useState("");
  const [editResumo, setEditResumo] = useState("");

  const { data: reunioes = [], isLoading } = useQuery<Reuniao[]>({
    queryKey: ["reunioes"],
    queryFn: () => apiFetch("/api/reunioes"),
  });

  const selected = reunioes.find((r) => r.id === selectedId) ?? null;

  const createMutation = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("titulo", titulo);
      form.append("data", dataReuniao);
      form.append("participantes", participantes);
      if (audioFile) form.append("file", audioFile);
      return apiFetch("/api/reunioes", { method: "POST", body: form });
    },
    onSuccess: async (created: Reuniao) => {
      setSuccess(audioFile ? "Reunião criada com transcrição automática." : "Reunião criada.");
      setError("");
      setTitulo("");
      setDataReuniao("");
      setParticipantes("");
      setAudioFile(null);
      setSelectedId(created.id);
      await queryClient.invalidateQueries({ queryKey: ["reunioes"] });
    },
    onError: (e: any) => { setError(e.message); setSuccess(""); },
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
    onSuccess: async () => {
      setSuccess("Notas atualizadas.");
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["reunioes"] });
    },
    onError: (e: any) => { setError(e.message); setSuccess(""); },
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiFetch(`/api/reunioes/${selectedId}`, { method: "DELETE" }),
    onSuccess: async () => {
      setSuccess("Reunião eliminada.");
      setError("");
      setSelectedId("");
      await queryClient.invalidateQueries({ queryKey: ["reunioes"] });
    },
    onError: (e: any) => { setError(e.message); setSuccess(""); },
  });

  async function startRecording() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const preferredMimeTypes = ["audio/mp4", "audio/aac", "audio/webm;codecs=opus", "audio/webm"];
      const chosenMimeType = preferredMimeTypes.find((mt) => (window as any).MediaRecorder?.isTypeSupported?.(mt)) ?? "";
      const recorder = new MediaRecorder(stream, {
        ...(chosenMimeType ? { mimeType: chosenMimeType } : {}),
        audioBitsPerSecond: 24000,
      });
      mediaRecorderRef.current = recorder;
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const mime = chosenMimeType || recorder.mimeType || "audio/webm";
        const ext = mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a") ? "m4a" : mime.includes("wav") ? "wav" : "webm";
        const blob = new Blob(recordedChunksRef.current, { type: mime });
        setAudioFile(new File([blob], `reuniao_${Date.now()}.${ext}`, { type: blob.type || mime }));
        stream.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        recordedChunksRef.current = [];
      };
      recorder.start();
      setIsRecording(true);
    } catch (e: any) {
      setIsRecording(false);
      setError(e?.message ?? "Erro ao iniciar gravação.");
    }
  }

  function stopRecording() {
    try {
      if (mediaRecorderRef.current?.state !== "inactive") mediaRecorderRef.current?.stop();
      setIsRecording(false);
    } catch (e: any) {
      setError(e?.message ?? "Erro ao parar gravação.");
    }
  }

  useEffect(() => {
    if (!selected) return;
    setEditTitulo(selected.titulo);
    setEditData(new Date(selected.data).toISOString().slice(0, 10));
    setEditParticipantes(selected.participantes ?? "");
    setEditTranscricao(selected.transcricao ?? "");
    setEditResumo(selected.resumo ?? "");
  }, [selected]);

  return (
    <>
      <PageHeader
        title="Notas de Reunião"
        subtitle="Gravação e transcrição de reuniões internas (admin)"
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

        <Card>
          <CardHeader><CardTitle>Nova reunião</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <Input label="Título" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Reunião com fornecedor X" />
            <Input label="Data" type="date" value={dataReuniao} onChange={(e) => setDataReuniao(e.target.value)} />
            <div className="md:col-span-2">
              <Input label="Participantes" value={participantes} onChange={(e) => setParticipantes(e.target.value)} placeholder="Admin, Fornecedor, etc." />
            </div>
            <div className="md:col-span-2 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                {!isRecording ? (
                  <Button onClick={startRecording} disabled={!titulo || !dataReuniao || !navigator.mediaDevices}>
                    Gravar áudio
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={stopRecording}>Parar gravação</Button>
                )}
                {audioFile ? (
                  <span className="text-xs text-gray-500">{audioFile.name}</span>
                ) : (
                  <span className="text-xs text-gray-500">Sem áudio (opcional)</span>
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
              <Button onClick={() => createMutation.mutate()} loading={createMutation.isPending} disabled={!titulo || !dataReuniao}>
                Criar reunião
              </Button>
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
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    className="w-full text-left rounded-lg border px-3 py-2 text-sm"
                    style={{
                      borderColor: selectedId === r.id ? "var(--blue-primary)" : "var(--border)",
                      background: "var(--bg-elevated)",
                    }}
                  >
                    <div className="font-semibold" style={{ color: "var(--text-primary)" }}>{r.titulo}</div>
                    <div style={{ color: "var(--text-muted)" }}>
                      {new Date(r.data).toLocaleDateString("pt-PT")}
                      {r.participantes && ` · ${r.participantes}`}
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
            <CardContent className="space-y-3">
              <Input label="Título" value={editTitulo} onChange={(e) => setEditTitulo(e.target.value)} />
              <Input label="Data" type="date" value={editData} onChange={(e) => setEditData(e.target.value)} />
              <Input label="Participantes" value={editParticipantes} onChange={(e) => setEditParticipantes(e.target.value)} />
              <Textarea label="Resumo" value={editResumo} onChange={(e) => setEditResumo(e.target.value)} rows={6} />
              <Textarea label="Transcrição completa" value={editTranscricao} onChange={(e) => setEditTranscricao(e.target.value)} rows={14} />
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => updateMutation.mutate()} loading={updateMutation.isPending}>
                  Guardar alterações
                </Button>
                <Button
                  variant="secondary"
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
    </>
  );
}
