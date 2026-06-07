// シンプルなService Worker。
// アプリの殻（HTML/CSS/JS）はキャッシュしてオフラインでも開けるようにする。
// 到着時間などの /api/ はリアルタイムが命なので必ずネットから取る。
const CACHE = 'sgbus-v14';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API はネット優先（キャッシュしない）
  if (url.pathname.startsWith('/api/')) return;
  // 殻はキャッシュ優先
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
