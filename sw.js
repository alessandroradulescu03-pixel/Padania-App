/* Service worker PadaniaTuning Check-in · v3
   - File dell'app: prima la rete, saltando la cache di GitHub Pages (così vedi subito l'ultima versione), cache se offline
   - Librerie e font: prima la cache (non cambiano), così funziona anche senza campo */
const CACHE = 'pt-checkin-v4-7';

const CORE = [
  './', './index.html', './schermo.html', './style.css', './script.js', './natale.css', './natale.js', './manifest.webmanifest',
  './assets/logo.png', './assets/icon-192.png', './assets/icon-180.png',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(CORE.map(u => c.add(u)))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const sameOrigin = new URL(req.url).origin === self.location.origin;

  const put = resp => {
    if (resp && (resp.ok || resp.type === 'opaque')) {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
    }
    return resp;
  };

  if (sameOrigin) {
    // network-first
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(put).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
  } else {
    // cache-first (CDN, Google Fonts)
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(put)));
  }
});
