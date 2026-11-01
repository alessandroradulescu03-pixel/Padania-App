/* Service worker PadaniaTuning Check-in
   Cache-first con aggiornamento in background, cosi' l'app funziona
   anche offline dopo il primo caricamento (rete scarsa in fiera/evento). */
const CACHE_VERSION = 'pt-checkin-v2';

const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.webmanifest',
  './assets/app-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://unpkg.com/html5-qrcode'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // allSettled: se un singolo asset (es. CDN) fallisce, non blocca tutta l'installazione
      Promise.allSettled(CORE_ASSETS.map((url) => cache.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((resp) => {
          if (resp && resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => cached); // offline: usa la cache se la rete fallisce

      // cache-first: se c'e' gia' in cache, rispondi subito e aggiorna dietro le quinte
      return cached || network;
    })
  );
});
