/* Minimal service worker — exists only to make the ERP installable
   ("Add to Home Screen" / desktop install) and to survive a flaky
   connection, NOT to work as a real offline app. A school's fee/attendance
   data must always be live, so this deliberately:
     - never intercepts /api/* requests (those always hit the network), and
     - is network-first for everything it does cache, only falling back to
       the cached copy when the network request itself fails.
   Bump CACHE_NAME whenever the shell changes so old caches get cleared. */
const CACHE_NAME = 'school-erp-shell-v1';
const SHELL_URLS = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (request.url.includes('/api/')) return; // ERP data is always fetched live, never cached

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/')))
  );
});

/* ===== Web Push ===== */
// Fee payment / fee due / marks / attendance alerts — see server.js's
// "Notifications: Web Push + WhatsApp" section for what sends these and
// index.html's subscribeToPush() for how a Parent/Student login opts in.
// The payload is always the small JSON object notifyAfterResourceWrite's
// notify* functions build: { title, body, tag, url }.
self.addEventListener('push', (event) => {
  let data = { title: 'Notification', body: '' };
  try { data = event.data ? event.data.json() : data; } catch (e) { /* non-JSON payload — keep the default */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Notification', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'erp-notification',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => 'focus' in c);
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});
