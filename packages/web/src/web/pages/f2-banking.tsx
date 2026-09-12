import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { getToken } from "../lib/auth";

type PublicBankConnection = {
  id: string;
  aspsp: string | null;
  accountIban: string | null;
  consentStatus: string;
  consentValidUntil: string | null;
  consentScopes: string[];
  reauthorizationRequired: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  csvFallback: boolean;
  hasSession: boolean;
};

async function f2Fetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api/f2${path}`, {
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

function statusBadge(status: string): "green" | "amber" | "red" | "muted" {
  if (status === "authorized") return "green";
  if (status === "reauthorization_required" || status === "expired") return "amber";
  if (status === "revoked") return "red";
  return "muted";
}

const BANK_ERROR_FLASH: Record<string, string> = {
  consent_failed: "Consentimento ASPSP falhou. Ver last_error na ligação.",
  consent_denied: "Consentimento ASPSP recusado. Ver last_error na ligação.",
  no_code: "Callback sem código de autorização.",
  invalid_state: "Estado de consentimento inválido.",
  tenant_mismatch: "Consentimento não pertence a este condomínio.",
  account_mismatch: "Nenhuma conta ASPSP corresponde ao IBAN do condomínio.",
  account_iban_required: "IBAN da conta do condomínio é obrigatório.",
  not_configured: "Enable Banking não está configurado no servidor.",
};

export default function F2BankingPage() {
  const qc = useQueryClient();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [csvText, setCsvText] = useState("");
  const [accountIban, setAccountIban] = useState("");
  const errorCode = params.get("bank_error");
  const flash =
    params.get("bank_connected") === "1"
      ? "Consentimento ASPSP concluído."
      : errorCode
        ? (BANK_ERROR_FLASH[errorCode] ?? "Consentimento ASPSP falhou. Ver last_error na ligação.")
        : null;

  const { data } = useQuery({
    queryKey: ["f2-bank-connections"],
    queryFn: () => f2Fetch<{ connections: PublicBankConnection[] }>("/bank-connections"),
  });
  const connection = data?.connections[0] ?? null;
  const ibanToAuthorize = accountIban.trim() || connection?.accountIban || "";

  const authorize = useMutation({
    mutationFn: () => {
      if (!ibanToAuthorize) {
        throw new Error("IBAN da conta do condomínio é obrigatório");
      }
      return f2Fetch<{ authorizationUrl: string }>("/bank-connections/authorize", {
        method: "POST",
        body: JSON.stringify({ accountIban: ibanToAuthorize }),
      });
    },
    onSuccess: (body) => {
      window.location.href = body.authorizationUrl;
    },
  });
  const reauthorize = useMutation({
    mutationFn: () =>
      f2Fetch<{ authorizationUrl: string }>("/bank-connections/reauthorize", { method: "POST", body: "{}" }),
    onSuccess: (body) => {
      window.location.href = body.authorizationUrl;
    },
  });
  const sync = useMutation({
    mutationFn: () => f2Fetch("/bank-connections/sync", { method: "POST", body: "{}" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["f2-bank-connections"] }),
  });
  const csv = useMutation({
    mutationFn: () =>
      f2Fetch("/payments/candidates", { method: "POST", body: JSON.stringify({ csvText }) }),
    onSuccess: () => {
      setCsvText("");
      qc.invalidateQueries({ queryKey: ["f2-bank-connections"] });
    },
  });

  return (
    <div>
      <PageHeader
        title="Banking PSD2"
        subtitle="Enable Banking na conta do condomínio — mínimo para exercitar o kernel F2"
      />
      <div className="p-6 space-y-4 max-w-3xl">
        {flash && (
          <p className="text-sm" style={{ color: params.get("bank_error") ? "var(--red)" : "var(--green)" }}>
            {flash}
          </p>
        )}
        <Card>
          <CardHeader>
            <CardTitle>BankConnection</CardTitle>
            {connection && <Badge variant={statusBadge(connection.consentStatus)}>{connection.consentStatus}</Badge>}
          </CardHeader>
          <CardContent className="space-y-3 text-sm" style={{ color: "var(--text-secondary)" }}>
            <label className="block space-y-1">
              <span>IBAN da conta do condomínio (obrigatório na primeira autorização)</span>
              <input
                value={accountIban}
                onChange={(e) => setAccountIban(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm font-mono"
                style={{
                  background: "var(--bg-secondary)",
                  borderColor: "var(--border-strong)",
                  color: "var(--text-primary)",
                }}
                placeholder={connection?.accountIban ?? "PT50…"}
                autoComplete="off"
              />
            </label>
            {connection ? (
              <>
                <p>ASPSP: {connection.aspsp ?? "—"}</p>
                <p>IBAN do condomínio: {connection.accountIban ?? "—"}</p>
                <p>Scopes: {connection.consentScopes.join(", ") || "—"}</p>
                <p>Sessão: {connection.hasSession ? "presente" : "ausente"}</p>
                <p>Último sync: {connection.lastSyncAt ?? "—"}</p>
                {connection.lastError && (
                  <p style={{ color: "var(--red)" }}>last_error: {connection.lastError}</p>
                )}
                {connection.csvFallback && (
                  <p>Fallback CSV activo (reauth / sessão em falta). PSD2 continua o caminho feliz quando autorizado.</p>
                )}
              </>
            ) : (
              <p>Ainda não há ligação à conta do condomínio.</p>
            )}
            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                size="sm"
                onClick={() => authorize.mutate()}
                loading={authorize.isPending}
                disabled={!ibanToAuthorize}
              >
                Autorizar ASPSP
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => reauthorize.mutate()}
                loading={reauthorize.isPending}
                disabled={!connection}
              >
                Reautorizar
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => sync.mutate()}
                loading={sync.isPending}
                disabled={!connection}
              >
                Sync
              </Button>
            </div>
            {(authorize.error || reauthorize.error || sync.error) && (
              <p style={{ color: "var(--red)" }}>
                {(authorize.error || reauthorize.error || sync.error)?.message}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Fallback CSV</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <textarea
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              rows={6}
              className="w-full rounded-md border px-3 py-2 text-sm font-mono"
              style={{
                background: "var(--bg-secondary)",
                borderColor: "var(--border-strong)",
                color: "var(--text-primary)",
              }}
              placeholder="Extrato CSV (créditos → Payments candidatos, sem Quota.pago)"
            />
            <Button size="sm" onClick={() => csv.mutate()} loading={csv.isPending} disabled={!csvText.trim()}>
              Importar CSV
            </Button>
            {csv.error && <p className="text-sm" style={{ color: "var(--red)" }}>{csv.error.message}</p>}
            {csv.isSuccess && <p className="text-sm" style={{ color: "var(--green)" }}>CSV ingerido como candidatos.</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
