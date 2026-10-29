const V = 'naklank-v42';
const FILES = ['./', 'index.html', 'stuk.js', 'koor.js', 'partituur.js', 'lib/osmd.min.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== V && k !== 'naklank-koren').map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Eerst uit de cache (werkt offline), op de achtergrond verversen.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // versleutelde koorbestanden: eerst het netwerk (altijd de nieuwste), anders de bewaarde kopie
  if (e.request.url.includes('/koren/')){
    e.respondWith(fetch(e.request).then(r => { if (r.ok){ const c = r.clone(); caches.open('naklank-koren').then(ch => ch.put(e.request, c)); } return r; }).catch(() => caches.match(e.request, { cacheName: 'naklank-koren' })));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(r => {
        if (r && r.ok && new URL(e.request.url).origin === location.origin) {
          const copy = r.clone(); caches.open(V).then(c => c.put(e.request, copy));
        }
        return r;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
