// ───────────────────────────────────────────────────────────
//  SG Bus PWA  Cloudflare Worker（中継／プロキシ）
//  役割：LTA DataMall API に AccountKey を付けて転送する。
//        鍵は Cloudflare の Secret に隠すので、ブラウザには出さへん。
//        鍵が無いときは自動でモックデータを返す。
//
//  ・/api/* だけこの Worker が処理する。
//  ・それ以外（HTML/CSS/JS/画像）は wrangler.toml の [assets] が
//    静的配信するので、Worker を通らず爆速で返る。
//  ・バス停一覧は busstops.seed.json をバンドルしてメモリ即ロード。
//  ・コアロジック（整形・検索・距離・モック・キャッシュ・濫用ガード）は
//    lib/busapi.js に集約。ここは「HTTPの受け口」だけの薄いアダプタ。
// ───────────────────────────────────────────────────────────
import seedStops from './busstops.seed.json';
// Cloudflare Workers のアセット配信は「.」で始まるパス（.well-known 等）を
// デフォルト除外＆誤処理する。TWAのURLバー消しに必須なので、ファイルは public の外
// （リポジトリ直下）に置き、Worker から直接 /.well-known/assetlinks.json として返す。
import assetLinks from './assetlinks.json';
import {
  MOCK_STOPS,
  handleArrival,
  handleSearch,
  handleNearby,
  handleStop,
  handleStatus,
  isAllowedApiRequest,
} from './lib/busapi.js';
import { verifyGoogleToken } from './lib/googleAuth.js';
import { sendPushEmpty } from './lib/webpush.js';

// Authorization: Bearer <token> から ID トークンを取り出す
function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

// JSONを返す小さいヘルパ
function json(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

// ───────────── ルーター ─────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const KEY = (env.LTA_ACCOUNT_KEY || '').trim();
    const useMock = !KEY;
    const stops = useMock ? MOCK_STOPS : seedStops;

    try {
      // Digital Asset Links（TWAでURLバーを消すのに必要）
      if (path === '/.well-known/assetlinks.json') {
        return json(assetLinks);
      }

      // html_handling="none" にしたので、トップ "/" は worker が index.html を返す。
      // （/index.html はアセット層がそのまま200で返す＝TWAの起動URLがコケへん）
      if (path === '/' || path === '') {
        return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
      }

      // 稼働状態は監視用に常に開けておく（濫用ガードの対象外）
      // フロントが Google ログインを初期化できるよう Client ID も返す（公開情報）
      if (path === '/api/status') {
        const s = handleStatus(useMock);
        s.body.googleClientId = env.GOOGLE_CLIENT_ID || '';
        s.body.vapidPublicKey = env.VAPID_PUBLIC_KEY || ''; // フロントの購読に使う（公開鍵）
        return reply(s);
      }

      // ここから先のデータAPIは「自オリジンからの呼び出し」だけ許可（タダ乗り防止）
      if (path.startsWith('/api/')) {
        if (!isAllowedApiRequest((k) => request.headers.get(k), url.host)) {
          return json({ error: 'このAPIは公開しとらんで' }, { status: 403 });
        }
      }

      if (path === '/api/arrival') {
        return reply(await handleArrival(url.searchParams.get('stop'), { key: KEY, useMock }));
      }
      if (path === '/api/search') {
        return reply(handleSearch(url.searchParams.get('q'), stops));
      }
      if (path === '/api/nearby') {
        return reply(handleNearby(url.searchParams.get('lat'), url.searchParams.get('lng'), stops));
      }
      if (path.startsWith('/api/stop/')) {
        return reply(handleStop(path.slice('/api/stop/'.length), stops));
      }

      // お気に入りのクラウド保存／取得（要 Googleログイン）
      if (path === '/api/favorites') {
        const user = await verifyGoogleToken(bearer(request), env.GOOGLE_CLIENT_ID);
        if (!user) return json({ error: 'ログインが必要やで' }, { status: 401 });
        const key = 'fav:' + user.sub;
        if (request.method === 'GET') {
          const data = await env.FAV_KV.get(key);
          return json(data ? JSON.parse(data) : { favorites: [], favServices: [] });
        }
        if (request.method === 'PUT' || request.method === 'POST') {
          const body = await request.json().catch(() => null);
          if (!body || typeof body !== 'object') return json({ error: 'bad body' }, { status: 400 });
          const clean = {
            favorites: Array.isArray(body.favorites) ? body.favorites.slice(0, 500) : [],
            favServices: Array.isArray(body.favServices) ? body.favServices.slice(0, 500) : [],
          };
          await env.FAV_KV.put(key, JSON.stringify(clean));
          return json({ ok: true });
        }
        return json({ error: 'method' }, { status: 405 });
      }

      // プッシュ通知の購読登録／解除（要 Googleログイン）。購読は push:<sub> に配列で保存
      if (path === '/api/push/subscribe' || path === '/api/push/unsubscribe') {
        const user = await verifyGoogleToken(bearer(request), env.GOOGLE_CLIENT_ID);
        if (!user) return json({ error: 'ログインが必要やで' }, { status: 401 });
        const body = await request.json().catch(() => null);
        const sub = body && body.subscription;
        if (!sub || !sub.endpoint) return json({ error: 'bad subscription' }, { status: 400 });
        const key = 'push:' + user.sub;
        let list = JSON.parse((await env.FAV_KV.get(key)) || '[]');
        list = list.filter((s) => s.endpoint !== sub.endpoint); // 同一端末は重複させない
        if (path === '/api/push/subscribe') list.push(sub);
        await env.FAV_KV.put(key, JSON.stringify(list.slice(0, 20)));
        return json({ ok: true, count: list.length });
      }

      // テスト通知を自分の端末へ送る（要 Googleログイン）
      if (path === '/api/push/test') {
        const user = await verifyGoogleToken(bearer(request), env.GOOGLE_CLIENT_ID);
        if (!user) return json({ error: 'ログインが必要やで' }, { status: 401 });
        const key = 'push:' + user.sub;
        const list = JSON.parse((await env.FAV_KV.get(key)) || '[]');
        if (!list.length) return json({ error: '通知の購読がまだ無いで', sent: 0 }, { status: 400 });
        let sent = 0;
        const alive = [];
        for (const sub of list) {
          const st = await sendPushEmpty(sub, env).catch(() => 0);
          if (st === 404 || st === 410) continue;       // 無効な購読は捨てる
          alive.push(sub);
          if (st >= 200 && st < 300) sent++;
        }
        await env.FAV_KV.put(key, JSON.stringify(alive));
        return json({ ok: true, sent });
      }

      // /api/* 以外がここに来ることは基本ない（静的アセットが先に処理される）
      return json({ error: 'not found' }, { status: 404 });
    } catch (e) {
      return json({ error: String(e) }, { status: 502 });
    }
  },
};

// ハンドラの { status, body, headers } を Response に変換
function reply({ status, body, headers }) {
  return json(body, { status, headers });
}
