// シンプルなService Worker。
// アプリの殻（HTML/CSS/JS）はキャッシュしてオフラインでも開けるようにする。
// 到着時間などの /api/ はリアルタイムが命なので必ずネットから取る。
const CACHE = 'sgbus-v28';
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
  // 別オリジン（Googleログイン/Leaflet/地図タイル等）はSWを通さず素通し
  if (url.origin !== self.location.origin) return;
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

// ── プッシュ通知 ──
// ペイロードがあればそれを表示。無ければテスト通知（フェーズ1）。
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = {}; }
  const title = data.title || '🚌 SG Bus 通知テスト';
  const opts = {
    body: data.body || '通知が届いたで！設定はうまくいっとる。',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: data.tag || 'sgbus',
    data: { url: data.url || './index.html' },
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) { if ('focus' in w) return w.focus(); }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
