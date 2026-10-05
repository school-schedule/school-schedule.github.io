// המערכת שלי — service worker: показывает push-уведомления
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil(self.registration.showNotification(d.title || 'המערכת שלי', {
    body: d.body || '',
    tag: d.tag || 'changes',
    renotify: true,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    dir: d.dir || 'auto',
    lang: d.lang || 'he'
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) return list[i].focus(); }
    return self.clients.openWindow('./');
  }));
});
