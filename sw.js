// Minimal service worker: enables PWA install without caching app logic (cookie-authed API must stay live).
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',()=>{});
