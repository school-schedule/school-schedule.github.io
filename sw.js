// Skedy — service worker: push-уведомления и работа без интернета
// Файлы сайта: сначала из сети (свежая версия), без сети — из кэша.
// Расписание само приложение хранит в localStorage, запросы к серверу (Worker) сюда не попадают.
var CACHE = 'app-v2';
var SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
var FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com$/;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // по одному: если какого-то файла нет, остальные всё равно сохранятся
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function fromCache(req) {
  return caches.match(req, { ignoreSearch: true }).then(function (r) {
    if (r) return r;
    if (req.mode === 'navigate') return caches.match('./').then(function (x) { return x || caches.match('index.html'); });
    return null;
  }).then(function (r) { return r || Response.error(); });
}
// сеть первой; если сеть молчит дольше 4 секунд (плохой Wi-Fi) — отдаём кэш
function networkFirst(req) {
  return new Promise(function (resolve) {
    var done = false;
    function finish(r) { if (!done) { done = true; resolve(r); } }
    var timer = setTimeout(function () {
      caches.match(req, { ignoreSearch: true }).then(function (r) { if (r) finish(r); });
    }, 4000);
    fetch(req).then(function (r) {
      clearTimeout(timer);
      if (r && r.ok) { var copy = r.clone(); caches.open(CACHE).then(function (c) { return c.put(req, copy); }).catch(function () {}); }
      finish(r);
    }, function () {
      clearTimeout(timer);
      fromCache(req).then(finish);
    });
  });
}
// шрифты не меняются: берём из кэша, а в фоне обновляем
function cacheFirst(req) {
  return caches.match(req).then(function (hit) {
    var net = fetch(req).then(function (r) {
      if (r && (r.ok || r.type === 'opaque')) { var copy = r.clone(); caches.open(CACHE).then(function (c) { return c.put(req, copy); }).catch(function () {}); }
      return r;
    });
    if (hit) { net.catch(function () {}); return hit; }
    return net;
  });
}
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin === self.location.origin) e.respondWith(networkFirst(req));
  else if (FONTS.test(url.origin)) e.respondWith(cacheFirst(req));
});

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Skedy', {
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
