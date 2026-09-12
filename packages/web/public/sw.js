/* LUMEN F3 — offline shell mínimo. Nunca cacheia /api (Ledger não é SoT offline). */
const CACHE = "lumen-f3-shell-v1";
const OFFLINE_URL = "/offline.html";
const SHELL = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-192-maskable.png",
  "/icons/icon-512-maskable.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

function isApiRequest(url) {
  return url.pathname === "/api" || url.pathname.startsWith("/api/");
}

function isNavigation(request) {
  return request.mode === "navigate" || (request.method === "GET" && request.destination === "document");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isApiRequest(url)) return;
  if (url.pathname === "/sw.js") return;

  if (isNavigation(request)) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          if (fresh.ok) {
            cache.put("/index.html", fresh.clone()).catch(() => undefined);
          }
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match("/index.html")) ||
            (await cache.match(OFFLINE_URL)) ||
            new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } })
          );
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(request);
        if (fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone()).catch(() => undefined);
        }
        return fresh;
      } catch {
        const cached = await caches.match(request);
        return (
          cached ||
          new Response("", { status: 504, statusText: "offline-shell" })
        );
      }
    })(),
  );
});

/** iOS 16.4+ exige notificação visível; push invisível revoga a permissão. */
self.addEventListener("push", (event) => {
  let title = "LUMEN";
  let body = "Tem um aviso no portal do condómino.";
  try {
    const data = event.data ? event.data.json() : null;
    if (data && typeof data === "object") {
      if (typeof data.title === "string") title = data.title;
      if (typeof data.body === "string") body = data.body;
    }
  } catch {
    if (event.data) {
      const text = event.data.text();
      if (text) body = text;
    }
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: "/f3/portal" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/f3/portal";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => client.url.includes("/f3/portal"));
      if (existing) return existing.focus();
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    }),
  );
});
