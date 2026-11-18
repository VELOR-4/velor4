// VELOR4 service worker: network first, so new versions of the site always load.
const C = "velor4-v2";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;
  if (new URL(r.url).origin !== location.origin) return; // database and payments go straight to the network
  e.respondWith(
    fetch(r, { cache: "no-cache" }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(C).then(c => c.put(r, copy)); }
      return res;
    }).catch(() => caches.match(r).then(m => m || caches.match("./")))
  );
});
