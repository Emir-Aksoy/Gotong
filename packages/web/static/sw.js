/* Gotong PWA service worker — app-shell cache (Phase 12 M9).
 *
 * Deliberately conservative for a token-gated admin tool:
 *
 *   - NEVER touches `/api/*`. That covers every authenticated endpoint AND
 *     the SSE stream (`/api/stream`) — letting respondWith intercept an
 *     event-stream would buffer it and break live updates. Those requests
 *     fall through to the browser's default network handling untouched.
 *   - Only GET, same-origin requests are considered. POST/PUT/DELETE and
 *     cross-origin (e.g. CDN bundle imports) always go straight to network.
 *   - Static assets (css/js/svg/icons/fonts/manifest) use
 *     stale-while-revalidate: instant from cache, refreshed in the
 *     background. The SW cache is independent of the `cache-control:
 *     no-cache` the server stamps, so this is safe.
 *   - Navigations are network-first with an offline-page fallback. The
 *     SPA shell (app.html) is intentionally NOT cached — it carries a
 *     server-injected role meta, so a stale copy could mis-render. On a
 *     dead network the user gets a clear "you're offline" page instead.
 *
 * Bumping CACHE invalidates the old shell on the next activate.
 */
// v3 (MR2): the precached shell (app-core.js, app.js) gained the dreaming
// "上次复盘" line + its i18n key. Bumping forces returning members past the
// stale-while-revalidate window so they get the new shell on the next activate,
// not one load later.
const CACHE = 'gotong-shell-v3'

// Stable, role-agnostic static shell. app.html is excluded on purpose
// (role-injected); admin.js / identity-ui.js etc. are left to the runtime
// stale-while-revalidate path so install stays fast and role-neutral.
const PRECACHE = [
  '/styles.css',
  '/app-core.js',
  '/app.js',
  '/icon.svg',
  '/manifest.webmanifest',
  '/offline.html',
]

const STATIC_EXT = /\.(?:css|js|mjs|svg|png|jpg|jpeg|gif|webp|ico|woff2?|webmanifest)$/i

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  let url
  try {
    url = new URL(req.url)
  } catch {
    return
  }
  if (url.origin !== self.location.origin) return
  // Authenticated endpoints + SSE — always live, never intercepted.
  if (url.pathname.startsWith('/api/')) return

  // Navigations: try the network, fall back to the offline shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/offline.html')),
    )
    return
  }

  // Static assets: stale-while-revalidate.
  if (STATIC_EXT.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          const network = fetch(req)
            .then((res) => {
              if (res && res.status === 200) cache.put(req, res.clone())
              return res
            })
            .catch(() => cached)
          return cached || network
        }),
      ),
    )
  }
})
