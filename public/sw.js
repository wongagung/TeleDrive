// Service worker MINIMAL -- tujuannya cuma biar situs ini kepenuhin syarat
// "installable" (Add to Home Screen) di Chrome/Android. BUKAN buat bikin
// app ini bisa dipakai offline -- ini app private yang butuh login & data
// selalu berubah (file, kuota, dll), jadi API dan halaman HTML SENGAJA
// TIDAK di-cache sama sekali, selalu ambil langsung dari server biar gak
// pernah nunjukin data basi/salah.
const CACHE_NAME = 'vaultku-shell-v1';
const SHELL_ASSETS = [
  '/style.css',
  '/theme.js',
  '/protect.js',
  '/favicon.svg',
  '/favicon-32.png',
  '/favicon-16.png',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch((err) => console.warn('[sw] gagal cache shell assets:', err.message))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Cuma tangani GET buat aset statis yang eksplisit didaftarin di atas.
  // API (/api/...), semua halaman HTML, dan request lain apa pun SELALU
  // langsung ke network -- gak pernah lewat cache sama sekali.
  if (event.request.method !== 'GET' || !SHELL_ASSETS.includes(url.pathname)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
