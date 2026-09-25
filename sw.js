// Service worker: cache-first for the app shell, stale-while-revalidate for
// data.json. Bump VERSION whenever a shell file (HTML, CSS, JS, icons) changes,
// or returning visitors will keep the old copy.
const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = 'data';

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/css/style.css',
  'assets/js/app.js',
  'assets/logo.svg',
  'assets/fonts/montserrat-latin-wght.woff2',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
];

const scoped = (p) => new URL(p, self.registration.scope).href;
const DATA_URL = scoped('data/data.json');

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL.map(scoped)))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.href.split('?')[0] === DATA_URL) {
    e.respondWith(staleWhileRevalidate(e));
    return;
  }

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).catch(() =>
        req.mode === 'navigate' ? caches.match(scoped('index.html')) : Response.error());
    }),
  );
});

async function staleWhileRevalidate(e) {
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(DATA_URL);

  const network = fetch(DATA_URL, { cache: 'no-cache' }).then(async (res) => {
    if (!res.ok) return res;
    const fresh = await res.clone().text();
    const old = cached ? await cached.clone().text() : null;
    await cache.put(DATA_URL, res.clone());
    // Tell open pages to re-render if the data changed under them.
    if (cached && fresh !== old) {
      for (const client of await self.clients.matchAll()) client.postMessage({ type: 'data-updated' });
    }
    return res;
  });

  if (cached) {
    e.waitUntil(network.catch(() => {}));
    return cached;
  }
  return network;
}
