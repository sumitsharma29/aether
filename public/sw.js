const CACHE_NAME = 'aether-v4-quantum';

const ASSETS_TO_CACHE = [
  '/',
  '/void',
  '/logo.png',
  '/manifest.json',
  '/app.js',
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700;900&display=swap',
  'https://cdn.socket.io/4.8.1/socket.io.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/simple-peer/9.11.1/simplepeer.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching critical application assets');
      return cache.addAll(ASSETS_TO_CACHE.filter(url => !url.startsWith('http')));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Purging stale cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Exclude API, socket.io, and vault downloads from cache
  const url = event.request.url;
  if (url.includes('/socket.io/') || url.includes('/api/') || url.includes('/v/')) {
    return;
  }

  // Network-first with cache fallback
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response && response.status === 200) {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
