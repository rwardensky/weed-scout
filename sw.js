// Offline support: the page and the last product list are cached, so the app opens without signal.
// Network first for the page and data (always fresh when online), cache first for icons and photos.
const CACHE = 'weed-scout-v2';
const SHELL = ['./', 'index.html', 'orders.js', 'suggest.js', 'data.json', 'manifest.webmanifest', 'icon.svg', 'icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameSite = url.origin === location.origin;
  // the page and its data: try the network, fall back to the last copy
  if (sameSite && (req.mode === 'navigate' || /\/(index\.html|data\.json)?$/.test(url.pathname) || url.pathname.endsWith('data.json') || url.pathname.endsWith('.js'))) {
    e.respondWith(fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? './' : req, copy)); } return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./'))));
    return;
  }
  // repo-hosted photos and icons: cache first
  if (sameSite && /\.(png|webp|jpg|svg)$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return r; })));
  }
});
