// Ledgerline service worker: caches the app shell so the app opens with no signal.
// It never caches /api (cookie-authed, must stay live). Writes made offline are
// queued in localStorage by the app and uploaded when the connection returns.
const V = 'll-shell-v4';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/mascot.png', '/favicon.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/og.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  let u; try { u = new URL(r.url); } catch (_) { return; }
  if (u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api')) return;

  const isHTML = r.mode === 'navigate' || (r.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    e.respondWith(
      fetch(r).then(res => {
        const c = res.clone();
        caches.open(V).then(x => x.put('/index.html', c)).catch(() => {});
        return res;
      }).catch(() => caches.match('/index.html').then(hit => hit || caches.match('/')))
    );
    return;
  }
  e.respondWith(
    caches.match(r).then(hit => hit || fetch(r).then(res => {
      if (res && res.ok && res.type === 'basic') { const c = res.clone(); caches.open(V).then(x => x.put(r, c)).catch(() => {}); }
      return res;
    }).catch(() => hit))
  );
});
