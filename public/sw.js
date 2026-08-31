const CACHE_NAME = 'aether-v5-ultra';

const ASSETS_TO_CACHE = [
  '/',
  '/void',
  '/logo.png',
  '/manifest.json',
  '/app.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Purging old cache version:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  // Always fetch fresh HTML, API, and Socket.io requests from network
  if (url.includes('/socket.io/') || url.includes('/api/') || url.includes('/v/') || event.request.destination === 'document') {
    return;
  }

  // Network-first with cache fallback for static assets
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
