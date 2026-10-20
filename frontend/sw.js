const CACHE_NAME = 'mistroom-ac17528771bcfadf';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/vendor/noble-crypto.js',
  '/vendor/wordlist.txt',
  '/vendor/qrcode.js',
  '/vendor/jsqr.js',
  '/js/state.js',
  '/js/crypto.js',
  '/js/transport.js',
  '/js/bootstrap.js',
  '/js/ble/protocol.js',
  '/js/ble/plugin_interface.js',
  '/js/ble/transport_ble.js',
  '/js/safewalk.js',
  '/js/badges.js',
  '/js/harassment_log.js',
  '/js/triage.js',
  '/js/mesh.js',
  '/js/files.js',
  '/js/calls.js',
  '/js/ws.js',
  '/js/ui.js',
  '/js/settings.js',
  '/js/outbox.js',
  '/shared/triage_rules.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // Precache with per-asset try/catch so one 404 does not abort install
      for (const asset of PRECACHE_ASSETS) {
        try {
          await cache.add(asset);
        } catch (err) {
          console.warn(`[SW] Precache failed for ${asset}:`, err);
        }
      }
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Network-first for dynamic endpoints
  if (url.pathname === '/api/info' || url.pathname === '/qr.svg') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // WebSocket requests bypass Service Worker
  if (url.pathname.startsWith('/ws')) {
    return;
  }

  // Cache-first, falling back to network
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const toCache = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, toCache);
        });
        return response;
      });
    })
  );
});
