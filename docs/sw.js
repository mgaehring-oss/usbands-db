// Service worker: makes the app shell + last-fetched database usable
// offline, and tells open tabs when a newer database becomes available.
//
// Bump the cache names below (v1 -> v2, etc.) whenever SHELL_ASSETS changes,
// so the activate handler purges the old versions instead of leaving stale
// entries around forever.
const SHELL_CACHE = "usbands-shell-v1";
const DATA_CACHE = "usbands-data-v1";
const VENDOR_CACHE = "usbands-vendor-v1";
const CACHES = [SHELL_CACHE, DATA_CACHE, VENDOR_CACHE];

const SHELL_ASSETS = [
  "./",
  "index.html",
  "app.js",
  "style.css",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !CACHES.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isDataAsset(url) {
  return url.pathname.endsWith("/data/usbands.db") || url.pathname.endsWith("/data/last_updated.txt");
}

function isVendorAsset(url) {
  return url.origin === "https://cdn.jsdelivr.net";
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) client.postMessage(message);
}

// Serves the cached copy immediately (instant, and works offline), then
// re-fetches in the background to keep the cache warm for next time.
// notifyOnChange is only used for last_updated.txt -- a few bytes, cheap to
// diff on every load -- as the signal that the (much larger) database has
// actually changed, rather than diffing the database's own bytes.
//
// The background fetch is registered with event.waitUntil() -- without it,
// the browser is free to kill the worker the moment respondWith()'s promise
// resolves, before the "revalidate" half of stale-while-revalidate (the
// cache.put, and the change-detection notify) ever gets to run.
//
// The cached response's text is read out immediately (not inside the
// .then() below) and kept as a plain string -- holding onto the Response
// object itself across that async boundary and cloning it later triggered
// a real "Response body is already used" error under concurrent access.
async function staleWhileRevalidate(event, request, cacheName, { notifyOnChange = false } = {}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const cachedText = notifyOnChange && cached ? await cached.clone().text() : null;

  const networkFetch = fetch(request)
    .then(async (response) => {
      if (!response.ok) return response;
      if (cachedText !== null) {
        const newText = await response.clone().text();
        if (cachedText.trim() !== newText.trim()) notifyClients({ type: "usbands-data-updated" });
      }
      await cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  event.waitUntil(networkFetch);
  return cached || (await networkFetch) || Response.error();
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  if (isDataAsset(url)) {
    event.respondWith(
      staleWhileRevalidate(event, event.request, DATA_CACHE, { notifyOnChange: url.pathname.endsWith("last_updated.txt") })
    );
    return;
  }
  if (isVendorAsset(url)) {
    event.respondWith(cacheFirst(event.request, VENDOR_CACHE));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event, event.request, SHELL_CACHE));
  }
});
