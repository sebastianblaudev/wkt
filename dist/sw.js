const CACHE_NAME = 'walkie-talkie-v2';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET, chrome-extension, and socket.io
    if (event.request.method !== 'GET') return;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    if (url.pathname.includes('socket.io')) return;

    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;

            return fetch(event.request).then(response => {
                if (!response || response.status !== 200 || response.type !== 'basic') return response;

                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            }).catch(() => {
                if (event.request.mode === 'navigate') {
                    return caches.match('/');
                }
            });
        })
    );
});
