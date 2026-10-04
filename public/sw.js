// plan.md §H1. Written by hand: no library, and the cache is exactly this build's own files.
// `vite build` (the querylens-service-worker plugin in vite.config.ts) replaces the two placeholders
// below. The build stamp is in the cache name, so every build ships a worker whose bytes differ.
//
// No skipWaiting: a new worker activates only once no open tab is still served by the old one. An
// open tab therefore keeps its own build's files, so a lazy route it has not loaded yet still
// resolves, and the old cache is deleted only after nothing uses it.

const CACHE = 'querylens-__BUILD_STAMP__';
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('querylens-') && key !== CACHE).map((key) => caches.delete(key)))),
  );
});

// Every route is the same document, so a navigation gets the cached shell whatever the URL.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(answer(request, url));
});

async function answer(request, url) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request.mode === 'navigate' ? '/index.html' : url.pathname);
  return cached ?? fetch(request);
}
