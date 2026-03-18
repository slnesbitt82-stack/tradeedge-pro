// ═══════════════════════════════════════════════════════════
// TradeEdge Pro — Service Worker v2.0
// Updated to match current app version (all features included)
//
// DEPLOYMENT: Place this file in the SAME directory as
// tradeedge_pro.html when hosting on a web server.
// Both files must be served from the same origin over HTTPS.
//
// Features:
//   • Offline-first caching for the app shell
//   • Stale-while-revalidate for fonts & CDN assets
//   • Background sync support
//   • Push notification support (ready for broker sync alerts)
//   • Auto cache versioning — bumping CACHE_VERSION below
//     forces all clients to update on next visit
// ═══════════════════════════════════════════════════════════

const CACHE_VERSION = 'tradeedge-v2';
const CACHE_NAME    = CACHE_VERSION;

// Files to pre-cache on install (app shell)
const APP_SHELL = [
  './',
  './tradeedge_pro.html',
];

// External resources to cache on first use (CDN / fonts)
const CDN_ORIGINS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
];

// ── Install ────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW v2] Installing TradeEdge Pro...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW v2] Pre-caching app shell');
        return cache.addAll(APP_SHELL);
      })
      .then(() => {
        console.log('[SW v2] Install complete — skipping wait');
        return self.skipWaiting();
      })
      .catch(err => {
        // App shell cache can fail if offline at install time — non-fatal
        console.warn('[SW v2] Pre-cache failed (offline at install?):', err);
        return self.skipWaiting();
      })
  );
});

// ── Activate ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW v2] Activating — cleaning up old caches...');
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        const toDelete = cacheNames.filter(name => name !== CACHE_NAME);
        if (toDelete.length) {
          console.log('[SW v2] Deleting old caches:', toDelete);
        }
        return Promise.all(toDelete.map(name => caches.delete(name)));
      })
      .then(() => {
        console.log('[SW v2] Now controlling all clients');
        return self.clients.claim();
      })
  );
});

// ── Fetch ──────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET, browser extensions, and blob URLs
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;
  if (url.protocol === 'blob:') return;
  if (url.protocol === 'data:') return;

  // ── Strategy 1: App shell (HTML file) — Cache First ──
  // Serve instantly from cache, update cache in background
  if (request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
    event.respondWith(
      caches.match(request).then(cached => {
        const networkUpdate = fetch(request)
          .then(response => {
            if (response.ok) {
              caches.open(CACHE_NAME).then(cache => {
                cache.put(request, response.clone());
              });
            }
            return response;
          })
          .catch(() => null);

        // Return cached immediately if available, otherwise wait for network
        return cached || networkUpdate || caches.match('./tradeedge_pro.html');
      })
    );
    return;
  }

  // ── Strategy 2: CDN resources (Fonts, Chart.js) — Stale While Revalidate ──
  // Return cache immediately, update in background for next visit
  const isCDN = CDN_ORIGINS.some(origin => url.hostname.includes(origin));
  if (isCDN) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(request);

        // Always try to update in background
        const networkFetch = fetch(request)
          .then(response => {
            if (response.ok && response.type !== 'opaque') {
              cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => null);

        // Return cached version immediately if available (stale is fine for fonts/charts)
        return cached || await networkFetch;
      })
    );
    return;
  }

  // ── Strategy 3: Everything else — Network First with cache fallback ──
  event.respondWith(
    fetch(request)
      .then(response => {
        // Cache successful responses
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline fallback — try cache
        return caches.match(request).then(cached => {
          if (cached) return cached;
          // Last resort: serve the app shell for navigation requests
          if (request.mode === 'navigate') {
            return caches.match('./tradeedge_pro.html');
          }
          // Return a minimal offline response for other requests
          return new Response('Offline', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
          });
        });
      })
  );
});

// ── Background Sync ────────────────────────────────────────
// Used for future broker data sync when connection is restored
self.addEventListener('sync', event => {
  console.log('[SW v2] Background sync triggered:', event.tag);

  if (event.tag === 'sync-trades') {
    event.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
        .then(clients => {
          clients.forEach(client => {
            client.postMessage({
              type: 'SYNC_READY',
              message: 'Connection restored — ready to sync broker data'
            });
          });
        })
    );
  }

  if (event.tag === 'sync-broker') {
    event.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
        .then(clients => {
          clients.forEach(client => {
            client.postMessage({
              type: 'BROKER_SYNC_READY',
              message: 'Background broker sync triggered'
            });
          });
        })
    );
  }
});

// ── Push Notifications ─────────────────────────────────────
// Ready for broker sync alerts, daily reminders, and trade alerts
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = {
      title: 'TradeEdge Pro',
      body: event.data.text(),
      type: 'info'
    };
  }

  const title = payload.title || 'TradeEdge Pro';
  const options = {
    body: payload.body || '',
    icon:  './icon-192.png',
    badge: './icon-192.png',
    tag:   payload.tag || 'tradeedge-default',
    data:  payload,
    vibrate: [200, 100, 200],
    requireInteraction: payload.requireInteraction || false,
    actions: payload.actions || [],
  };

  // Different vibration patterns for different alert types
  if (payload.type === 'alert')    options.vibrate = [300, 100, 300, 100, 300];
  if (payload.type === 'warning')  options.vibrate = [200, 50, 200];
  if (payload.type === 'success')  options.vibrate = [100];

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Notification Click ─────────────────────────────────────
self.addEventListener('notificationclick', event => {
  console.log('[SW v2] Notification clicked:', event.notification.tag);
  event.notification.close();

  const payload = event.notification.data || {};
  const targetUrl = payload.url || './';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // Focus an existing window if open
        for (const client of clientList) {
          if ('focus' in client) {
            client.focus();
            // Send message to navigate to the right page
            if (payload.page) {
              client.postMessage({ type: 'NAVIGATE', page: payload.page });
            }
            return;
          }
        }
        // No window open — open a new one
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
  );
});

// ── Notification Close ─────────────────────────────────────
self.addEventListener('notificationclose', event => {
  console.log('[SW v2] Notification dismissed:', event.notification.tag);
});

// ── Message Handler ────────────────────────────────────────
// Handles messages sent from the app to the SW
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  if (type === 'SKIP_WAITING') {
    console.log('[SW v2] Skip waiting requested');
    self.skipWaiting();
  }

  if (type === 'CACHE_CLEAR') {
    event.waitUntil(
      caches.delete(CACHE_NAME).then(() => {
        event.source.postMessage({ type: 'CACHE_CLEARED' });
      })
    );
  }

  if (type === 'GET_VERSION') {
    event.source.postMessage({ type: 'VERSION', version: CACHE_VERSION });
  }
});
