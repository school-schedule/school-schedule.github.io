// Skedy — service worker: push-уведомления и работа без интернета
// Файлы сайта (страницы, config.js, иконки): сразу из кэша, свежая версия качается в фоне — приложение
// открывается мгновенно даже на плохом Wi-Fi, а новая версия сайта видна со следующего открытия.
// JSON-файлы (teacher/*.json): сначала из сети, без сети или если сеть молчит 4 с — из кэша.
// Расписание само приложение хранит в localStorage, запросы к серверу (Worker) сюда не попадают.
var CACHE = 'app-v11';
var SHELL = ['./', 'index.html', 'config.js', 'map.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'teacher/', 'teacher/index.html', 'teacher/manifest.webmanifest', 'teacher/icon-192.png', 'teacher/icon-512.png', 'teacher/apple-touch-icon.png', 'teacher/rooms.json', 'teacher/teachers.json', 'teacher/subjects.json',
  'parents/', 'parents/index.html', 'parents/manifest.webmanifest', 'parents/icon-192.png', 'parents/icon-512.png', 'parents/apple-touch-icon.png']; // teacher/ — Skedy для учителей, parents/ — для родителей
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
// страницы и файлы сайта: сразу из кэша (приложение открывается мгновенно даже на плохом Wi-Fi),
// а свежая версия качается в фоне и будет при следующем открытии; кэша нет — из сети
function staleWhileRevalidate(e, req) {
  return caches.match(req, { ignoreSearch: true }).then(function (hit) {
    var net = fetch(req).then(function (r) {
      if (r && r.ok) { var copy = r.clone(); caches.open(CACHE).then(function (c) { return c.put(req, copy); }).catch(function () {}); }
      return r;
    });
    if (hit) { e.waitUntil(net.catch(function () {})); return hit; }
    return net.catch(function () { return fromCache(req); });
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
  if (url.origin === self.location.origin) e.respondWith(/\.json$/.test(url.pathname) ? networkFirst(req) : staleWhileRevalidate(e, req));
  else if (FONTS.test(url.origin)) e.respondWith(cacheFirst(req));
});

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) {}
  // у Skedy Teachers и Skedy Parents свои иконки (с шапочкой и с сердечком)
  var m = /\/(teacher|parents)\/$/.exec(self.registration.scope), ico = m ? m[1] + '/icon-192.png' : 'icon-192.png';
  e.waitUntil(self.registration.showNotification(d.title || 'Skedy', {
    body: d.body || '',
    tag: d.tag || 'changes',
    renotify: true,
    icon: ico,
    badge: ico,
    dir: d.dir || 'auto',
    lang: d.lang || 'he'
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  // открываем то приложение, чья это подписка: ученическое (scope «/»), для учителей («/teacher/») или для родителей («/parents/»)
  var scope = self.registration.scope, sub = /\/(teacher|parents)\/$/.test(scope);
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var u = list[i].url, mine = u.indexOf(scope) === 0 && (sub || (u.indexOf('/teacher/') < 0 && u.indexOf('/parents/') < 0));
      if (mine && 'focus' in list[i]) return list[i].focus();
    }
    return self.clients.openWindow(scope);
  }));
});
