const cachePrefix = "doi-shell-";
const cacheName = cachePrefix + "14";
const shell = self.registration.scope;
const index = new URL("./index.html", shell).href;
const assets = new Set([
  "./",
  "./styles.css",
  "./app.js",
  "./dates.js",
  "./db.js",
  "./record.js",
  "./couple.js",
  "./couple-view.js",
  "./stats.js",
  "./backup.js",
  "./android.js",
  "./album-view.js",
  "./media.js",
  "./manifest.webmanifest",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
].map((path) => new URL(path, self.registration.scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(cacheName).then((cache) => {
      const requests = Array.from(assets, (url) => new Request(url, { cache: "reload" }));
      return cache.addAll(requests);
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const address = url.origin + url.pathname;
  const key = request.mode === "navigate" && (address === shell || address === index) ? shell : address;
  if (!assets.has(key)) return;

  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const response = await cache.match(key);
    return response ?? fetch(request);
  })());
});
