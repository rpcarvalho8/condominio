import { useEffect, useRef } from "react";
import { Redirect } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { authClient, getToken } from "../lib/auth";

// Sync silencioso no arranque — corre uma vez por sessão de browser
async function silentBankSync(queryClient: ReturnType<typeof useQueryClient>) {
  const key = "bank-sync-done";
  if (sessionStorage.getItem(key)) return; // já correu nesta sessão
  sessionStorage.setItem(key, "1");
  try {
    const token = getToken();
    await fetch("/api/bank/sync", {
      method: "POST",
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    // Pequena pausa para garantir que a BD já foi escrita antes de refetch
    await new Promise(r => setTimeout(r, 500));
    await queryClient.invalidateQueries();
  } catch {
    // silencioso — falha não interrompe o utilizador
  }
}

export function ProtectedRoute({ children, adminOnly = false }: { children: React.ReactNode; adminOnly?: boolean }) {
  const { data: session, isPending } = authClient.useSession();
  const queryClient = useQueryClient();
  const syncedRef = useRef(false);

  // Sync automático quando admin autentica
  useEffect(() => {
    const user = session?.user as any;
    if (user?.role === "admin" && !syncedRef.current) {
      syncedRef.current = true;
      silentBankSync(queryClient);
    }
  }, [session, queryClient]);

  if (isPending) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-400 text-sm">A carregar...</div>
      </div>
    );
  }

  if (!session) return <Redirect to="/login" />;

  const user = session.user as any;

  // Condómino trying to access admin area → send to portal
  if (adminOnly && user?.role !== "admin") return <Redirect to="/portal" />;

  return <>{children}</>;
}
