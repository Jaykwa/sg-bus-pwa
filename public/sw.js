// シンプルなService Worker。
// アプリの殻（HTML/CSS/JS）はキャッシュしてオフラインでも開けるようにする。
// 到着時間などの /api/ はリアルタイムが命なので必ずネットから取る。
const CACHE = 'sgbus-v29';
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
  // 殻(HTML/CSS/JS/画像)はネット優先。取れたらキャッシュ更新、ダメな時だけキャッシュ。
  // ＝コード更新が次回読み込みで即反映される（古いJSが残って機能が効かへんのを防ぐ）。
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((h) => h || caches.match('./index.html')))
  );
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
