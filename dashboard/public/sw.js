// Push notifications ("your search is ready") — shown even when the dashboard is closed.
// The server sends { title, body, url, tag } (server/src/notify.js).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: 'FB Lead Finder', body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || 'FB Lead Finder', {
      body: d.body || '',
      icon: '/favicon.png',
      badge: '/favicon.png',
      tag: d.tag || 'fblf',
      renotify: true,
      data: { url: d.url || '/' },
    }),
  );
});

// click → open (or focus) the dashboard at the project
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin);
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const same = wins.find((w) => new URL(w.url).origin === url.origin);
      if (same) {
        await same.focus();
        if ('navigate' in same) return same.navigate(url.href);
        return undefined;
      }
      return self.clients.openWindow(url.href);
    })(),
  );
});
