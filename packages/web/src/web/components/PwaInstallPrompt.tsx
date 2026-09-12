import { useEffect, useState } from "react";
import {
  classifyIosPush,
  detectRuntimePushInput,
  isIosDevice,
  isStandaloneDisplay,
  readInstallDismissed,
  shouldShowInstallPrompt,
  writeInstallDismissed,
} from "../lib/pwa";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function PwaInstallPrompt() {
  const [visible, setVisible] = useState(false);
  const [ios, setIos] = useState(false);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const standalone = isStandaloneDisplay({
      matchMedia: window.matchMedia.bind(window),
      navigatorStandalone: Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
    });
    const dismissed = readInstallDismissed(window.localStorage);
    const onIos = isIosDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
    setIos(onIos);
    setVisible(shouldShowInstallPrompt({ isStandalone: standalone, dismissed }));

    const onBip = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      setVisible(shouldShowInstallPrompt({ isStandalone: false, dismissed: readInstallDismissed(window.localStorage) }));
    };
    window.addEventListener("beforeinstallprompt", onBip);
    return () => window.removeEventListener("beforeinstallprompt", onBip);
  }, []);

  if (!visible) return null;

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") setVisible(false);
  }

  function dismiss() {
    writeInstallDismissed(window.localStorage);
    setVisible(false);
  }

  return (
    <div
      role="dialog"
      aria-label="Instalar aplicação"
      className="fixed bottom-4 inset-x-4 z-[70] mx-auto max-w-lg rounded-2xl border bg-white p-4 shadow-lg"
      style={{ borderColor: "#E5E5EA" }}
    >
      <p className="text-xs uppercase tracking-wider" style={{ color: "#D0021B" }}>
        LUMEN
      </p>
      <p className="mt-1 text-sm font-semibold">Instalar no ecrã principal</p>
      {ios ? (
        <p className="mt-1 text-sm text-neutral-600">
          No Safari: toque em Partilhar e depois em «Adicionar ao ecrã principal». No iOS, o push só
          existe depois deste passo (16.4+) — e mesmo assim é best-effort; o email continua primário.
        </p>
      ) : (
        <p className="mt-1 text-sm text-neutral-600">
          Instale o portal para o abrir como aplicação. O saldo do Ledger continua a precisar de rede.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!ios && deferred ? (
          <button
            type="button"
            onClick={() => void install()}
            className="rounded-lg px-3 py-2 text-sm text-white"
            style={{ background: "#D0021B" }}
          >
            Instalar
          </button>
        ) : null}
        <button type="button" onClick={dismiss} className="text-sm text-neutral-500 underline">
          Agora não
        </button>
      </div>
    </div>
  );
}

export function IosPushSpikeNote() {
  const [text, setText] = useState("");
  useEffect(() => {
    const verdict = classifyIosPush(detectRuntimePushInput());
    setText(`${verdict.result} — ${verdict.reasons[0] ?? "spike iOS"}`);
  }, []);
  if (!text) return null;
  return (
    <p className="text-xs text-neutral-400">
      Spike iOS push: {text}. Email é o canal primário.
    </p>
  );
}
