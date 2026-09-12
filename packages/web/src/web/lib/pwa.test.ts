import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  classifyIosPush,
  compareVersion,
  INSTALL_DISMISS_KEY,
  IOS_PUSH_SPIKE_RESULT,
  isIosDevice,
  isStandaloneDisplay,
  parseIosVersion,
  PWA_START_URL,
  readInstallDismissed,
  SEVILLA_BG,
  SEVILLA_THEME,
  shouldShowInstallPrompt,
  writeInstallDismissed,
} from "./pwa";

const webRoot = path.resolve(import.meta.dir, "../../..");
const publicDir = path.join(webRoot, "public");

describe("PWA manifest + shell", () => {
  test("manifest Sevilla aponta ao portal F3 em standalone", () => {
    const raw = fs.readFileSync(path.join(publicDir, "manifest.webmanifest"), "utf8");
    const manifest = JSON.parse(raw) as {
      name: string;
      start_url: string;
      display: string;
      theme_color: string;
      background_color: string;
      icons: { src: string; sizes: string; purpose?: string }[];
    };
    expect(manifest.start_url).toBe(PWA_START_URL);
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toBe(SEVILLA_THEME);
    expect(manifest.background_color).toBe(SEVILLA_BG);
    expect(manifest.name.toLowerCase()).toContain("lumen");
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) {
      const file = path.join(publicDir, icon.src.replace(/^\//, ""));
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
    }
  });

  test("offline shell é HTML mínimo Sevilla e não finge saldo Ledger", () => {
    const html = fs.readFileSync(path.join(publicDir, "offline.html"), "utf8");
    expect(html).toContain(SEVILLA_THEME);
    expect(html).toContain(SEVILLA_BG);
    expect(html.toLowerCase()).toContain("sem ligação");
    expect(html.toLowerCase()).not.toContain("quota.pago");
    expect(html).toContain("/f3/portal");
  });

  test("index.html liga manifest, theme-color Sevilla e apple-touch-icon", () => {
    const html = fs.readFileSync(path.join(webRoot, "index.html"), "utf8");
    expect(html).toContain('rel="manifest"');
    expect(html).toContain("/manifest.webmanifest");
    expect(html).toContain('content="#D0021B"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain("apple-mobile-web-app-capable");
  });

  test("service worker: shell + push visível; nunca cacheia /api", () => {
    const sw = fs.readFileSync(path.join(publicDir, "sw.js"), "utf8");
    expect(sw).toContain("lumen-f3-shell");
    expect(sw).toContain("/offline.html");
    expect(sw).toContain("skipWaiting");
    expect(sw).toContain("clients.claim");
    expect(sw).toContain("addEventListener(\"push\"");
    expect(sw).toContain("showNotification");
    expect(sw).toContain("notificationclick");
    expect(sw).toContain("/f3/portal");
    expect(sw).toMatch(/pathname === \"\/api\"|startsWith\(\"\/api\/\"\)/);
    expect(sw).not.toContain("Quota.pago");
    expect(sw).not.toContain("/qr");
  });
});

describe("install prompt", () => {
  test("esconde se standalone ou já dispensado", () => {
    expect(shouldShowInstallPrompt({ isStandalone: true, dismissed: false })).toBe(false);
    expect(shouldShowInstallPrompt({ isStandalone: false, dismissed: true })).toBe(false);
    expect(shouldShowInstallPrompt({ isStandalone: false, dismissed: false })).toBe(true);
  });

  test("standalone via display-mode ou navigator.standalone (iOS)", () => {
    expect(isStandaloneDisplay({ matchMedia: () => ({ matches: false }), navigatorStandalone: true })).toBe(true);
    expect(
      isStandaloneDisplay({
        matchMedia: (q) => ({ matches: q.includes("standalone") }),
        navigatorStandalone: false,
      }),
    ).toBe(true);
    expect(isStandaloneDisplay({ matchMedia: () => ({ matches: false }), navigatorStandalone: false })).toBe(false);
  });

  test("dismiss persiste na storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    expect(readInstallDismissed(storage)).toBe(false);
    writeInstallDismissed(storage);
    expect(store.get(INSTALL_DISMISS_KEY)).toBe("1");
    expect(readInstallDismissed(storage)).toBe(true);
  });
});

describe("spike iOS push", () => {
  test("veredicto de produto é FRAGILE", () => {
    expect(IOS_PUSH_SPIKE_RESULT).toBe("FRAGILE");
  });

  test("iOS 16.3 → FAIL", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15";
    expect(parseIosVersion(ua)).toEqual({ major: 16, minor: 3 });
    expect(isIosDevice(ua, "iPhone", 5)).toBe(true);
    const v = classifyIosPush({
      userAgent: ua,
      isStandalone: true,
      hasServiceWorker: true,
      hasPushManager: false,
      hasNotification: true,
    });
    expect(v.result).toBe("FAIL");
  });

  test("iOS 16.4+ tab Safari → FRAGILE (instalação obrigatória)", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15";
    const v = classifyIosPush({
      userAgent: ua,
      isStandalone: false,
      hasServiceWorker: true,
      hasPushManager: false,
      hasNotification: true,
    });
    expect(v.result).toBe("FRAGILE");
    expect(v.reasons.some((r) => r.includes("Adicionar ao ecrã principal"))).toBe(true);
  });

  test("iOS 17 standalone com APIs → FRAGILE (best-effort, email primário)", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
    const v = classifyIosPush({
      userAgent: ua,
      isStandalone: true,
      hasServiceWorker: true,
      hasPushManager: true,
      hasNotification: true,
    });
    expect(v.result).toBe("FRAGILE");
    expect(v.reasons.some((r) => r.includes("email continua primário"))).toBe(true);
  });

  test("Android Chrome com Push API → PASS de capacidade (fora do spike iOS)", () => {
    const v = classifyIosPush({
      userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0",
      isStandalone: false,
      hasServiceWorker: true,
      hasPushManager: true,
      hasNotification: true,
    });
    expect(v.result).toBe("PASS");
    expect(v.isIos).toBe(false);
  });

  test("iPadOS desktop UA conta como iOS", () => {
    expect(isIosDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5)).toBe(true);
    expect(compareVersion({ major: 16, minor: 4 }, { major: 16, minor: 3 })).toBeGreaterThan(0);
  });
});
