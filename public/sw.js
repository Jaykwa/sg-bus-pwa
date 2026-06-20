// シンプルなService Worker。
// アプリの殻（HTML/CSS/JS）はキャッシュしてオフラインでも開けるようにする。
// 到着時間などの /api/ はリアルタイムが命なので必ずネットから取る。
const CACHE = 'sgbus-v20';
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
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 1個でも失敗(リダイレクト/404等)しても install 全体を落とさない。
    // ＝壊れたSWが居座って画面を真っ白にするのを防ぐ。
    await Promise.allSettled(
      SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API はネット優先（キャッシュしない）
  if (url.pathname.startsWith('/api/')) return;
  // 画面遷移(HTML)はネット優先・失敗時だけキャッシュ。
  // ＝古い殻やリダイレクトでアプリが固まるのを防ぐ。
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() =>
        caches.match(e.request).then((h) => h || caches.match('./index.html'))
      )
    );
    return;
  }
  // CSS/JS/画像はキャッシュ優先
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
