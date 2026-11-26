const CACHE_NAME = "pyq-cloud-shell-v8";
const APP_SHELL = [
  "/",
  "/manifest.json",
  "/icons/pyq-cloud-icon-v2-192.png",
  "/icons/pyq-cloud-icon-v2-512.png",
  "/icons/pyq-cloud-icon-v2-maskable-512.png",
  "/icons/pyq-cloud-apple-icon-v2.png",
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { payload = { body: event.data?.text() || "Open PYQ Cloud to see what’s new." }; }
  event.waitUntil(self.registration.showNotification(payload.title || "PYQ Cloud", {
    body: payload.body || "There’s something new to explore.",
    icon: "/icons/pyq-cloud-icon-v2-192.png",
    badge: "/icons/pyq-cloud-icon-v2-192.png",
    tag: payload.id || "pyq-cloud-announcement",
    data: { url: typeof payload.url === "string" && payload.url.startsWith("/") && !payload.url.startsWith("//") ? payload.url : "/" },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.navigate(targetUrl);
      return existing.focus();
    }
    return self.clients.openWindow(targetUrl);
  }));
});
self.addEventListener("fetch", (event) => {
  if (["localhost", "127.0.0.1"].includes(self.location.hostname)) return;
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  const url = new URL(event.request.url);
  const isDocument = event.request.mode === "navigate";
  const isStaticAsset = url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/mascot-lottie/") || url.pathname.startsWith("/brand/") || url.pathname.startsWith("/figma-assets/") || url.pathname.startsWith("/figma-assets-oct-2026/") || url.pathname.startsWith("/icons/");
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok && (isDocument || isStaticAsset)) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(isDocument ? "/" : event.request, copy));
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(isDocument ? "/" : event.request);
    if (cached) return cached;
    return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }));
});
