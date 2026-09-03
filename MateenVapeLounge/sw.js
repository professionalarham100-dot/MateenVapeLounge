/* =====================================================================
   Mateen VapeLounge - Service Worker
   Cache-first for static assets, network-first for /api requests.
   ===================================================================== */

const CACHE_VERSION = 'mvlounge-v1.0.0';
const CORE_ASSETS = [
    '/',
    '/index.html',
    '/owner-dashboard.html',
    '/staff-dashboard.html',
    '/css/main.css',
    '/css/login.css',
    '/css/owner-dashboard.css',
    '/css/staff-dashboard.css',
    '/js/auth.js',
    '/js/owner.js',
    '/js/staff.js',
    '/manifest.json',
    '/static/icon.svg',
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) =>
            // Use addAll but tolerate individual failures
            Promise.allSettled(CORE_ASSETS.map((url) =>
                cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
            ))
        )
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.map((k) => (k === CACHE_VERSION ? null : caches.delete(k))))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Never cache API calls — always go to network so data stays fresh.
    if (url.pathname.startsWith('/api/')) {
        return; // let browser handle normally
    }

    // For navigations: cache-first, network fallback.
    if (req.mode === 'navigate') {
        event.respondWith(
            caches.match(req).then((cached) => cached || fetch(req).catch(() =>
                caches.match('/index.html')))
        );
        return;
    }

    // Static assets: cache-first, then update cache from network in background.
    event.respondWith(
        caches.match(req).then((cached) => {
            const networkPromise = fetch(req).then((res) => {
                if (res && res.status === 200 && res.type === 'basic') {
                    const clone = res.clone();
                    caches.open(CACHE_VERSION).then((c) => c.put(req, clone)).catch(() => {});
                }
                return res;
            }).catch(() => cached);
            return cached || networkPromise;
        })
    );
});
