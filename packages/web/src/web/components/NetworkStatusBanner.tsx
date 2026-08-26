import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

/**
 * Banner discreto quando o iPad/browser fica offline.
 * Não bloqueia a UI — só informa.
 */
export function NetworkStatusBanner() {
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  if (online) return null;

  return (
    <div
      className="fixed top-0 inset-x-0 z-[60] flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium"
      style={{ background: "var(--amber)", color: "#1a1a1a" }}
      role="status"
    >
      <WifiOff size={14} />
      Sem ligação — dados já gravados neste dispositivo estão seguros. As alterações serão enviadas quando a rede voltar.
    </div>
  );
}
