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

// Every route is the same document, so an offline navigation gets the cached shell whatever the URL. Online
// navigations go network-first so returning visitors see new deployments right away without waiting for every open
// tab to close; hashed `/assets/*` stay cache-first so an open tab still resolves its own build's lazy chunks.
// The shell is cached as `/`: the platform redirects `/index.html` to `/`, and a navigation answered with a
// redirected response fails outright — which is how the first production build of this worker broke every visit
// after the first (CHANGELOG, 2.0.0-rc.2).
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(answer(request, url));
});

async function answer(request, url) {
  const cache = await caches.open(CACHE);
  if (request.mode === 'navigate') {
    let networkResponse;
    try {
      networkResponse = await fetch(request);
      if (networkResponse.ok || networkResponse.type === 'opaqueredirect') return networkResponse;
    } catch {
      // Offline or transient network failure: fall back to the precached shell below.
    }
    const cached = await cache.match('/');
    if (!cached) return networkResponse ?? fetch(request);
    // Belt and braces: a response that arrived by redirect is handed back as a fresh one, which a navigation accepts.
    return cached.redirected
      ? new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers: cached.headers })
      : cached;
  }
  const cached = await cache.match(url.pathname);
  return cached ?? fetch(request);
}
