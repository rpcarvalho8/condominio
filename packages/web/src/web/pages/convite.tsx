import { useState } from "react";
import { useLocation, useParams } from "wouter";
import { authClient, captureToken } from "../lib/auth";

type InvitationView = {
  contactoMasked: string;
  contacto?: string;
  personName: string | null;
  roleCode: string;
  status: string;
  contactVerified: boolean;
  expiresAt: string;
};

async function publicF3<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/f3${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

export default function ConvitePage() {
  const params = useParams<{ token: string }>();
  const [, navigate] = useLocation();
  const token = params.token ?? "";
  const [invitation, setInvitation] = useState<InvitationView | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [step, setStep] = useState<"load" | "verify" | "account" | "done">("load");
  const [loading, setLoading] = useState(false);

  async function loadPreview() {
    setError("");
    setLoading(true);
    try {
      const body = await publicF3<{ invitation: InvitationView }>(`/public/invitations/${token}`);
      setInvitation(body.invitation);
      setName(body.invitation.personName ?? "");
      setStep(body.invitation.contactVerified ? "account" : "verify");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Convite inválido");
    } finally {
      setLoading(false);
    }
  }

  async function requestCode() {
    setError("");
    setLoading(true);
    try {
      await publicF3(`/public/invitations/${token}/verify/request`, { method: "POST" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível enviar o código");
    } finally {
      setLoading(false);
    }
  }

  async function confirmCode() {
    setError("");
    setLoading(true);
    try {
      const body = await publicF3<{ invitation: InvitationView }>(
        `/public/invitations/${token}/verify/confirm`,
        { method: "POST", body: JSON.stringify({ code }) },
      );
      setInvitation(body.invitation);
      setStep("account");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Código inválido");
    } finally {
      setLoading(false);
    }
  }

  async function accept() {
    setError("");
    setLoading(true);
    try {
      const preview = invitation;
      if (!preview) throw new Error("Convite em falta");
      const accountEmail = preview.contacto;
      if (password.length >= 8 && accountEmail) {
        const signUp = await authClient.signUp.email(
          { email: accountEmail, password, name },
          { onSuccess: captureToken },
        );
        if (signUp.error) {
          const signIn = await authClient.signIn.email(
            { email: accountEmail, password },
            { onSuccess: captureToken },
          );
          if (signIn.error) throw new Error(signUp.error.message || "Não foi possível criar a conta");
        }
      }
      await publicF3(`/public/invitations/${token}/accept`, {
        method: "POST",
        body: JSON.stringify({ name, email: accountEmail }),
      });
      setStep("done");
      navigate("/portal");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível aceitar o convite");
    } finally {
      setLoading(false);
    }
  }

  if (step === "load") {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ background: "#F5F5F7" }}>
        <div className="w-full max-w-md bg-white rounded-2xl p-8 border" style={{ borderColor: "#E5E5EA" }}>
          <h1 className="text-xl font-semibold mb-2">Aceitar convite</h1>
          <p className="text-sm text-neutral-500 mb-6">
            Verificação de contacto — não é verificação de identidade (KYC).
          </p>
          <button
            type="button"
            onClick={loadPreview}
            disabled={loading || !token}
            className="w-full rounded-lg py-2.5 text-white text-sm font-medium"
            style={{ background: "#D0021B" }}
          >
            {loading ? "A abrir…" : "Abrir convite"}
          </button>
          {error && <p className="text-sm text-red-600 mt-4">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: "#F5F5F7" }}>
      <div className="w-full max-w-md bg-white rounded-2xl p-8 border space-y-4" style={{ borderColor: "#E5E5EA" }}>
        <h1 className="text-xl font-semibold">Convite da fração</h1>
        <p className="text-sm text-neutral-500">
          {invitation?.personName ?? "Condómino"} · {invitation?.contactoMasked} · {invitation?.roleCode}
        </p>
        {step === "verify" && (
          <>
            <button
              type="button"
              onClick={requestCode}
              disabled={loading}
              className="w-full rounded-lg py-2.5 text-sm border"
            >
              Enviar código de verificação de contacto
            </button>
            <input
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="Código de 6 dígitos"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button
              type="button"
              onClick={confirmCode}
              disabled={loading || code.length < 6}
              className="w-full rounded-lg py-2.5 text-white text-sm font-medium"
              style={{ background: "#D0021B" }}
            >
              Confirmar contacto
            </button>
          </>
        )}
        {step === "account" && (
          <>
            <input
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="Nome"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              type="password"
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="Password (opcional se já tiver sessão)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={accept}
              disabled={loading || !name.trim()}
              className="w-full rounded-lg py-2.5 text-white text-sm font-medium"
              style={{ background: "#D0021B" }}
            >
              Criar ou associar conta
            </button>
          </>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
