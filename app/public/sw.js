/**
 * Cache-first for everything the safety loop needs: the shell, the wasm runtime
 * and the model. Once installed, a ride works with no connection at all.
 */
const CACHE = "pathfinder-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(["/", "/index.html", "/manifest.webmanifest"])),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  // hazard data must always be live; everything else may come from cache
  if (new URL(request.url).pathname.startsWith("/api/")) return;

  // The HTML shell goes network-first: it names the content-hashed asset
  // bundles, so a stale copy would point at files that no longer exist and
  // strand the rider on a broken page with no way to recover. Falls back to
  // cache when there is no connection, which is the whole point of the SW.
  // The assets themselves are hashed, so cache-first stays safe for them.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit ?? caches.match("/index.html"))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
