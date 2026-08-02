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
// v8 (C1b): sdui-ui.js gains chart (usage.mine) + quick-actions renderers
// with new app-core.js keys + styles.css classes — all three precached
// files must refresh together.
// v9 (C1c): content/connector relay renderers (markdown-card / weather /
// card-feed) + their app-core.js keys + styles.css classes.
// v10 (PUSH-M3): this SW gains push/notificationclick/pushsubscriptionchange
// handlers + the /me notification card (app.js/app-core.js/app.html) — the
// shell must refresh so subscribe targets a SW that can actually show taps.
// v12 (SHELL-M2): hub-target.js joins the shell and app-core.js now depends on
// it at boot — a returning member must not get the new app-core with a cached
// shell that has no hub-target.js in it.
// v13 (SHELL-M3): sdui-ui.js declares its schemaVersion and gained the
// whole-panel downgrade; app-core.js carries its copy. A stale pair would put
// the downgrade branch in one file and the notice copy in neither.
// v14 (SHELL-M4): styles.css SHED its sdui block and app-core.js shed its 140
// sdui* keys — both moved into the renderer's own files. A returning member on
// a cached v13 shell would get a stripped styles.css/app-core.js, so the shell
// must refresh. sdui-ui.css is deliberately NOT precached: it pairs with
// sdui-ui.js, which is also not precached, so the pair stays on ONE cache path
// and cannot go stale against each other the way M3's pair could.
// v15 (SHELL-M4.5): app.html shed its 18 static tabbar buttons; app.js now
// GENERATES them (TAB_REGISTRY ∩ role ∩ panel-config) and loads admin bundles
// by config. app.html itself is never cached (role meta), but a stale v14
// app.js against the new empty-nav markup would render no tabbar at all —
// the precached app.js must refresh in lockstep with the markup change.
// v17 (POLISH-M1): sdui-ui.css became a token system scoped to `.sdui-root`
// and sdui-ui.js now stamps that class + data-sdui-scale. The pair shares one
// runtime cache path — a stale one of the two would render an unstyled or
// unscalable panel, so both must refresh together.
const CACHE = 'gotong-shell-v17'

// Stable, role-agnostic static shell. app.html is excluded on purpose
// (role-injected); admin.js / identity-ui.js etc. are left to the runtime
// stale-while-revalidate path so install stays fast and role-neutral.
const PRECACHE = [
  '/styles.css',
  '/hub-target.js',
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

/* ── Web Push (PUSH-M3) ───────────────────────────────────────────────────
 * The payload is the hub's fixed low-info tap — defensive parsing only, and
 * the fallback copy matches the hub's so a garbled payload still shows a
 * truthful "you have a message" rather than nothing (push events without a
 * shown notification get browsers to revoke the subscription).
 */
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    /* non-JSON payload → fixed fallback copy below */
  }
  const title = typeof data.title === 'string' && data.title ? data.title : '阿同 · Gotong'
  const body = typeof data.body === 'string' && data.body ? data.body : '有新消息,点开查看 · New message'
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      // One coalesced notification per member, not a pile-up of identical taps.
      tag: 'gotong-butler',
      data: { url: '/' },
    }),
  )
})

// Tap → focus an open /me tab if there is one, otherwise open the app.
// 推送≠授权: the tap only OPENS the app; reading happens behind the login.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const win of wins) {
        if ('focus' in win) return win.focus()
      }
      return self.clients.openWindow(target)
    }),
  )
})

// NB the SHELL-M2 fetch patch does NOT reach this file — a service worker is a
// separate global, and `hub-target.js` never runs here. That is correct rather
// than an oversight: a service worker only exists on the same origin that
// served it, so its `/api/…` is by definition this hub. The native shell has no
// service worker at all (its push leg goes native in SHELL-M6).
//
// The push service rotated our subscription: re-subscribe with the same
// applicationServerKey and best-effort re-register with the hub. If anything
// fails the /me card's honest count lets the member re-enable by hand.
self.addEventListener('pushsubscriptionchange', (event) => {
  const oldSub = event.oldSubscription
  if (!oldSub || !oldSub.options || !oldSub.options.applicationServerKey) return
  event.waitUntil(
    self.registration.pushManager
      .subscribe({
        userVisibleOnly: true,
        applicationServerKey: oldSub.options.applicationServerKey,
      })
      .then((sub) =>
        fetch('/api/me/push/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(sub.toJSON()),
        }),
      )
      .catch(() => {}),
  )
})
