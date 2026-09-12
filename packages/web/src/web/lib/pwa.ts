/** PWA Essencial F3 — helpers puros (Sevilla / iOS push spike). */

export const SEVILLA_THEME = "#D0021B";
export const SEVILLA_BG = "#F5F5F7";
export const PWA_START_URL = "/f3/portal";
export const INSTALL_DISMISS_KEY = "lumen.pwa.install.dismissed";

/** Veredicto do spike de produto: iOS push nunca é canal primário. */
export const IOS_PUSH_SPIKE_RESULT = "FRAGILE" as const;

export type IosPushResult = "PASS" | "FRAGILE" | "FAIL";

export type PushCapabilityInput = {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  isStandalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
};

export function parseIosVersion(ua: string): { major: number; minor: number } | null {
  const os = ua.match(/OS (\d+)[._](\d+)/);
  if (os) return { major: Number(os[1]), minor: Number(os[2]) };
  const iphone = ua.match(/iPhone OS (\d+)[._](\d+)/);
  if (iphone) return { major: Number(iphone[1]), minor: Number(iphone[2]) };
  return null;
}

export function isIosDevice(ua: string, platform = "", maxTouchPoints = 0): boolean {
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return platform === "MacIntel" && maxTouchPoints > 1;
}

export function compareVersion(
  a: { major: number; minor: number },
  b: { major: number; minor: number },
): number {
  if (a.major !== b.major) return a.major - b.major;
  return a.minor - b.minor;
}

/**
 * Classifica Web Push no dispositivo.
 * Spike iOS (SoT F3 / ADR-035): mesmo com APIs presentes o canal é FRAGILE —
 * exige «Adicionar ao ecrã principal», gesto para permissão, notificação visível,
 * e a subscrição pode cair. Email continua primário.
 */
export function classifyIosPush(input: PushCapabilityInput): {
  result: IosPushResult;
  reasons: string[];
  isIos: boolean;
  iosVersion: { major: number; minor: number } | null;
} {
  const isIos = isIosDevice(input.userAgent, input.platform, input.maxTouchPoints);
  const iosVersion = parseIosVersion(input.userAgent);
  const reasons: string[] = [];

  if (!isIos) {
    if (input.hasServiceWorker && input.hasPushManager && input.hasNotification) {
      return {
        result: "PASS",
        reasons: ["Push API presente fora do iOS — o spike F3 aplica-se só ao Safari iOS"],
        isIos,
        iosVersion,
      };
    }
    return {
      result: "FRAGILE",
      reasons: ["Push API incompleta neste browser"],
      isIos,
      iosVersion,
    };
  }

  if (iosVersion && compareVersion(iosVersion, { major: 16, minor: 4 }) < 0) {
    return {
      result: "FAIL",
      reasons: [`iOS ${iosVersion.major}.${iosVersion.minor} < 16.4 — Web Push não existe`],
      isIos,
      iosVersion,
    };
  }

  if (!input.hasServiceWorker) {
    return {
      result: "FAIL",
      reasons: ["Service Worker ausente"],
      isIos,
      iosVersion,
    };
  }

  if (!input.isStandalone) {
    reasons.push("não está em standalone — iOS exige Partilhar → Adicionar ao ecrã principal");
  }
  if (!input.hasPushManager) {
    reasons.push("PushManager ausente (típico em tab Safari, não na PWA instalada)");
  }
  if (!input.hasNotification) {
    reasons.push("Notification API ausente");
  }
  reasons.push(
    "best-effort: permissão só com gesto; Safari revoga push invisível; subscrições caem; email continua primário",
  );

  return { result: "FRAGILE", reasons, isIos, iosVersion };
}

export function shouldShowInstallPrompt(input: { isStandalone: boolean; dismissed: boolean }): boolean {
  return !input.isStandalone && !input.dismissed;
}

export function isStandaloneDisplay(opts: {
  matchMedia?: (query: string) => { matches: boolean };
  navigatorStandalone?: boolean;
}): boolean {
  if (opts.matchMedia?.("(display-mode: standalone)").matches) return true;
  if (opts.matchMedia?.("(display-mode: fullscreen)").matches) return true;
  return opts.navigatorStandalone === true;
}

export function readInstallDismissed(storage: Pick<Storage, "getItem"> | null | undefined): boolean {
  try {
    return storage?.getItem(INSTALL_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeInstallDismissed(storage: Pick<Storage, "setItem"> | null | undefined) {
  try {
    storage?.setItem(INSTALL_DISMISS_KEY, "1");
  } catch {
    /* private mode */
  }
}

export function registerLumenServiceWorker() {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  });
}

/**
 * Rede real: navigator.onLine pode mentir.
 * Sonda `/sw.js` (o SW não o intercepta; a API pode devolver 500 sem rede caída).
 * Qualquer resposta HTTP = online; só falha de rede = offline.
 */
export async function probeNetworkOnline(
  fetchImpl: typeof fetch,
  navOnline = true,
): Promise<boolean> {
  if (!navOnline) return false;
  try {
    await fetchImpl("/sw.js", { method: "GET", cache: "no-store", headers: { "X-Lumen-Online-Probe": "1" } });
    return true;
  } catch {
    return false;
  }
}

export function detectRuntimePushInput(): PushCapabilityInput {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const win = typeof window === "undefined" ? undefined : window;
  return {
    userAgent: nav?.userAgent ?? "",
    platform: nav?.platform ?? "",
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    isStandalone: isStandaloneDisplay({
      matchMedia: win?.matchMedia?.bind(win),
      navigatorStandalone: Boolean((nav as Navigator & { standalone?: boolean })?.standalone),
    }),
    hasServiceWorker: Boolean(nav && "serviceWorker" in nav),
    hasPushManager: typeof PushManager !== "undefined",
    hasNotification: typeof Notification !== "undefined",
  };
}
