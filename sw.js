/**
 * ESP32-S3 Web Tester — Service Worker
 *
 * Stratégie : Network-first avec fallback cache.
 * En ligne  → toujours la dernière version (+ mise en cache)
 * Hors-ligne → version cachée
 * Incrémente CACHE_VERSION à chaque nouvelle version pour purger l'ancien cache.
 */

const CACHE_VERSION = 'esp32-v1';

const FILES_TO_CACHE = [
    './',
    './index.html',
    './style.css',
    './serial.js',
    './network.js',
    './plotter.js',
    './pinmap.js',
    './manifest.json',
    './icons/icon.svg'
];

// Install : pré-cache tous les fichiers
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => cache.addAll(FILES_TO_CACHE))
    );
    self.skipWaiting();
});

// Activate : supprime les anciens caches, prend le contrôle immédiatement
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

// Fetch : network-first, fallback cache
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    if (!event.request.url.startsWith(self.location.origin)) return;

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => {
                return caches.match(event.request);
            })
    );
});

// Écouter les messages pour forcer un update
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});
