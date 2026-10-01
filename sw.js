// sw.js — INFINICUS Engine v3 Service Worker
// Bump CACHE_VERSION when deploying significant updates to force re-cache
// Deployed: 2026-07-16 rev21 — platform flow redesign: 6-layer nav (Data/Ops/Intel/Twin/Simulate/AI)
const CACHE_VERSION = 'v28';
const CACHE = 'infinicus-' + CACHE_VERSION;

// Core shell assets — cached on install
const SHELL = [
  '/index.html',
  '/landing.html',
  '/account.html',
  '/legal.html',
  '/manifest.json',
  '/infinicus-mark.svg',
  '/og-image.svg',
  '/infinicus logo.jpeg',
];

// Fonts are cached at runtime (cross-origin, can't pre-cache reliably)
const FONT_ORIGINS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// ── Install: pre-cache shell ──────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()) // Don't let missing optional assets block install
  );
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: strategy by request type ──────────────────────────────────────────
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Never intercept non-http(s) schemes — browser extensions can trigger
  // page-context requests (chrome-extension://, moz-extension://, etc.)
  // that the Cache API flatly rejects with "Request scheme ... is
  // unsupported", logged as an uncaught promise rejection on every such
  // request. Not ours to cache either way.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Never intercept API calls (legacy Cloudflare Functions under /api/, or
  // the Postgres platform under /v1/) or any non-GET request — always go
  // straight to network. Cache-first/cache-put only make sense for
  // cacheable GET requests; matching or storing a POST/PUT/DELETE by URL
  // risks serving a stale or wrong response for a different payload.
  if (request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) return;

  // External analytics — don't intercept
  if (url.hostname.includes('cloudflareinsights.com')) return;

  // Fonts — cache on first fetch, serve from cache thereafter
  if (FONT_ORIGINS.some(h => url.hostname.includes(h))) {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached;
          return fetch(request).then(resp => {
            if (resp && resp.status === 200) cache.put(request, resp.clone());
            return resp;
          }).catch(() => cached); // silent fail — fonts not critical offline
        })
      )
    );
    return;
  }

  // HTML pages — network-first so users get fresh content when online,
  // but fall back to cached version when offline
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    e.respondWith(
      fetch(request)
        .then(resp => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE).then(c => c.put(request, copy));
          }
          return resp;
        })
        .catch(() =>
          caches.match(request)
            .then(cached => cached || caches.match('/index.html'))
        )
    );
    return;
  }

  // Everything else (JS/CSS inline, SVGs, images) — cache-first
  e.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(resp => {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(request, copy));
        }
        return resp;
      });
    })
  );
});

// ── Background sync: notify clients of SW update ─────────────────────────────
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
