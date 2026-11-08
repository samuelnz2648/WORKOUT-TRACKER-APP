// Bump this when you change any app file, so phones pick up the new version.
const CACHE = 'workout-tracker-v13';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache so a new version gets fresh files
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// App shell: serve from cache instantly, refresh the cache in the background.
// API calls (script.google.com) are cross-origin and are not touched.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  const update = caches.open(CACHE).then(async (cache) => {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  });
  event.waitUntil(update.catch(() => {})); // let the background refresh finish

  event.respondWith(
    caches.match(req, { ignoreSearch: true })
      .then((cached) => cached || update)
      .catch(() => Response.error())
  );
});
