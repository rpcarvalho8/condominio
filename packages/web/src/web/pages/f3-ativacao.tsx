import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { getToken } from "../lib/auth";

type InvitationView = {
  id: string;
  fracaoId: string;
  canal: string;
  contactoMasked: string;
  personName: string | null;
  roleCode: string;
  status: string;
  loteId: string | null;
  contactVerified: boolean;
  expiresAt: string;
};

type PreviewRow = {
  contactDraftId: string;
  fracaoId: string | null;
  fracaoCodigo: string;
  personName: string;
  canal: string;
  contactoMasked: string;
  alreadyInvited: boolean;
};

type ActivationPanel = {
  invited: number;
  pending: number;
  accepted: number;
  revoked: number;
  expired: number;
  accounts: number;
  portalOpen: number | null;
  documentsSeen: number | null;
  preview: PreviewRow[];
};

async function f3Fetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api/f3${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

function statusTone(status: string): "green" | "amber" | "red" | "muted" {
  if (status === "accepted") return "green";
  if (status === "pending") return "amber";
  if (status === "revoked" || status === "expired") return "red";
  return "muted";
}

export default function F3AtivacaoPage() {
  const qc = useQueryClient();
  const [fracaoId, setFracaoId] = useState("");
  const [contacto, setContacto] = useState("");
  const [personName, setPersonName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const panel = useQuery({
    queryKey: ["f3-activation"],
    queryFn: () => f3Fetch<ActivationPanel>("/activation"),
  });
  const invitations = useQuery({
    queryKey: ["f3-invitations"],
    queryFn: () => f3Fetch<{ invitations: InvitationView[] }>("/invitations"),
  });

  const createOne = useMutation({
    mutationFn: () =>
      f3Fetch("/invitations", {
        method: "POST",
        body: JSON.stringify({ fracaoId, contacto, personName }),
      }),
    onSuccess: () => {
      setContacto("");
      setPersonName("");
      qc.invalidateQueries({ queryKey: ["f3-activation"] });
      qc.invalidateQueries({ queryKey: ["f3-invitations"] });
    },
  });
  const sendLote = useMutation({
    mutationFn: () =>
      f3Fetch("/invitations/lote", {
        method: "POST",
        body: JSON.stringify({ contactDraftIds: selected }),
      }),
    onSuccess: () => {
      setSelected([]);
      qc.invalidateQueries({ queryKey: ["f3-activation"] });
      qc.invalidateQueries({ queryKey: ["f3-invitations"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      f3Fetch(`/invitations/${id}/revoke`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["f3-activation"] });
      qc.invalidateQueries({ queryKey: ["f3-invitations"] });
    },
  });

  const eligible = useMemo(
    () => (panel.data?.preview ?? []).filter((row) => row.fracaoId && !row.alreadyInvited),
    [panel.data],
  );

  return (
    <div>
      <PageHeader
        title="Ativação da comunidade"
        subtitle="Convites individuais ou em lote — nunca automáticos a partir de OCR. Sem QR físico."
      />
      <div className="p-6 space-y-4 max-w-5xl">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            ["Convidados", panel.data?.invited ?? 0],
            ["Pendentes", panel.data?.pending ?? 0],
            ["Contas", panel.data?.accounts ?? 0],
            ["Portal / docs", "follow-up"],
          ].map(([label, value]) => (
            <Card key={String(label)}>
              <CardContent className="p-4">
                <p className="text-xs text-[var(--text-secondary)]">{label}</p>
                <p className="text-2xl font-semibold">{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Pré-visualização (fração ↔ pessoa ↔ contacto)</CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-3">
            <p className="text-sm text-[var(--text-secondary)]">
              Contactos confirmados em F1. O envio só acontece com o botão explícito.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[var(--text-secondary)]">
                    <th className="py-2"></th>
                    <th>Fração</th>
                    <th>Pessoa</th>
                    <th>Contacto</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {(panel.data?.preview ?? []).map((row) => (
                    <tr key={row.contactDraftId} className="border-t" style={{ borderColor: "var(--border)" }}>
                      <td className="py-2">
                        <input
                          type="checkbox"
                          disabled={!row.fracaoId || row.alreadyInvited}
                          checked={selected.includes(row.contactDraftId)}
                          onChange={(e) =>
                            setSelected((cur) =>
                              e.target.checked
                                ? [...cur, row.contactDraftId]
                                : cur.filter((id) => id !== row.contactDraftId),
                            )
                          }
                        />
                      </td>
                      <td>{row.fracaoCodigo}</td>
                      <td>{row.personName}</td>
                      <td>{row.contactoMasked}</td>
                      <td>{row.alreadyInvited ? "já convidado" : row.fracaoId ? "pronto" : "sem fração"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button
              onClick={() => sendLote.mutate()}
              disabled={selected.length === 0 || sendLote.isPending}
            >
              Enviar {selected.length || eligible.length} convites
            </Button>
            {sendLote.error && (
              <p className="text-sm text-[var(--red)]">{(sendLote.error as Error).message}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Convite individual</CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-3">
            <input
              className="w-full border rounded-lg px-3 py-2 text-sm"
              style={{ borderColor: "var(--border)" }}
              placeholder="ID da fração (constitution)"
              value={fracaoId}
              onChange={(e) => setFracaoId(e.target.value)}
            />
            <input
              className="w-full border rounded-lg px-3 py-2 text-sm"
              style={{ borderColor: "var(--border)" }}
              placeholder="Nome"
              value={personName}
              onChange={(e) => setPersonName(e.target.value)}
            />
            <input
              className="w-full border rounded-lg px-3 py-2 text-sm"
              style={{ borderColor: "var(--border)" }}
              placeholder="Email de contacto"
              value={contacto}
              onChange={(e) => setContacto(e.target.value)}
            />
            <Button
              onClick={() => createOne.mutate()}
              disabled={!fracaoId || !contacto || createOne.isPending}
            >
              Criar convite
            </Button>
            {createOne.error && (
              <p className="text-sm text-[var(--red)]">{(createOne.error as Error).message}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Convites emitidos</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <div className="space-y-2">
              {(invitations.data?.invitations ?? []).map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between gap-3 border-b py-2"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div>
                    <p className="text-sm font-medium">
                      {inv.personName ?? "—"} · {inv.contactoMasked}
                    </p>
                    <p className="text-xs text-[var(--text-secondary)]">
                      {inv.roleCode} · lote {inv.loteId ? inv.loteId.slice(0, 8) : "—"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={statusTone(inv.status)}>{inv.status}</Badge>
                    {inv.status === "pending" && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => revoke.mutate(inv.id)}
                        disabled={revoke.isPending}
                      >
                        Revogar
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
