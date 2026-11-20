// VELOR4 service worker: makes the site installable. It does not cache anything,
// so orders, payments and products always come live from the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
