const CACHE_NAME = 'budget-tracker-v28';

// './' and './index.html' are the same document. Keeping both here means a
// cold offline launch works whether the browser asks for the directory or the
// file by name.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png'
];

// cache.addAll() is all-or-nothing: one 404 (a renamed icon, a manifest not
// deployed yet) rejects the whole promise, install fails, and the service
// worker never activates at all -- so a missing 180px icon could silently
// cost you offline support entirely. Warm each entry on its own instead and
// let the stragglers be filled in by the fetch handler later.
function warmCache(cache) {
  return Promise.all(
    APP_SHELL.map((url) =>
      cache.add(url).catch((err) => {
        console.warn('[sw] could not precache', url, err);
      })
    )
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(warmCache)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Delete every cache bucket that isn't the current version -- this is
      // what purges any stale Supabase GET responses the old buggy version
      // of this file may have cached under the old bucket name.
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Lets the page tell a waiting worker to take over immediately, so you can
// ship a fix without asking yourself to force-quit the installed app.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isDocumentRequest(request, url) {
  return request.mode === 'navigate' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('.html');
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only ever intercept our own same-origin app-shell files (this page,
  // manifest, icons). Everything else -- and in particular every request
  // the live-sync system makes to Supabase -- must always go straight to
  // the network and is never cached. Caching a cross-origin sync read was
  // the bug: it could silently serve an old snapshot of your data instead
  // of the current one, making saves look like they hadn't taken.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // The document itself is network-first. Under the old cache-first rule,
  // pushing a new index.html got you the OLD one on the very next launch --
  // the fresh copy only landed in the cache in the background, so it took a
  // second launch to actually see a change. That reads exactly like a deploy
  // that didn't take. Ask the network first, fall back to the cache when
  // offline or the request fails.
  if (isDocumentRequest(event.request, url)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              // Store under both spellings so an offline launch resolves
              // whichever form the browser happens to request.
              cache.put(event.request, clone.clone());
              cache.put('./index.html', clone);
            });
          }
          return response;
        })
        .catch(() =>
          caches.match(event.request)
            .then((cached) => cached || caches.match('./index.html'))
            .then((cached) => cached || Response.error())
        )
    );
    return;
  }

  // Everything else in the shell (manifest, icons) is content-addressed
  // enough to serve straight from the cache, with a background refresh.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        // Returning `cached` here is undefined when nothing was cached AND
        // the network is down, and resolving respondWith with undefined
        // throws. Give the browser a real Response either way.
        .catch(() => cached || Response.error());

      return cached || networkFetch;
    })
  );
});
