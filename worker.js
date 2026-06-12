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
// ───────────────────────────────────────────────────────────
import seedStops from './busstops.seed.json';
// Cloudflare Workers のアセット配信は「.」で始まるパス（.well-known 等）を
// デフォルト除外＆誤処理する。TWAのURLバー消しに必須なので、ファイルは public の外
// （リポジトリ直下）に置き、Worker から直接 /.well-known/assetlinks.json として返す。
import assetLinks from './assetlinks.json';

const LTA_BASE = 'https://datamall2.mytransport.sg/ltaodataservice';

// ── 到着データのサーバー側キャッシュ（15秒TTL）──
// LTA DataMall は約20秒ごと更新なので、15秒キャッシュしてもデータの鮮度はほぼ変わらへん。
// ※Workerはリクエストごとに別インスタンスのことがあるので、これは「同じインスタンスが
//   生きてる間だけ効くベストエフォート」。それでも自動更新の連打はだいぶ間引ける。
const arrivalCache = new Map(); // code → { data, ts }
const ARRIVAL_TTL_MS = 15_000;

function getCachedArrival(stop) {
  const hit = arrivalCache.get(stop);
  if (hit && Date.now() - hit.ts < ARRIVAL_TTL_MS) return hit.data;
  return null;
}
function setCachedArrival(stop, data) {
  arrivalCache.set(stop, { data, ts: Date.now() });
  if (arrivalCache.size > 1000) {
    const oldest = [...arrivalCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0][0];
    arrivalCache.delete(oldest);
  }
}

// ── LTA に投げる小さいヘルパ ──
async function ltaFetch(endpoint, key) {
  const res = await fetch(`${LTA_BASE}/${endpoint}`, {
    headers: { AccountKey: key, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`LTA ${res.status}: ${await res.text()}`);
  return res.json();
}

// バス停一覧を返す（バンドルしたseed。mock時はMOCK_STOPS）
function getBusStops(useMock) {
  return useMock ? MOCK_STOPS : seedStops;
}

// 2点間の距離（メートル, Haversine）
function distM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
}

// JSONを返す小さいヘルパ
function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init,
  });
}

// ───────────── ルーター ─────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const KEY = (env.LTA_ACCOUNT_KEY || '').trim();
    const USE_MOCK = !KEY;

    try {
      // Digital Asset Links（TWAでURLバーを消すのに必要）
      if (path === '/.well-known/assetlinks.json') {
        return json(assetLinks);
      }

      // 到着予想
      if (path === '/api/arrival') {
        const stop = url.searchParams.get('stop');
        if (!stop) return json({ error: 'stop が要るで' }, { status: 400 });
        if (USE_MOCK) return json(mockArrival(stop));
        const cached = getCachedArrival(stop);
        if (cached) return json(cached, { headers: { 'X-Cache': 'HIT' } });
        const data = await ltaFetch(`v3/BusArrival?BusStopCode=${stop}`, KEY);
        const result = normalizeArrival(stop, data);
        setCachedArrival(stop, result);
        return json(result, { headers: { 'X-Cache': 'MISS' } });
      }

      // バス停検索（コード・名前・道路名で部分一致）
      if (path === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim().toLowerCase();
        if (!q) return json([]);
        const stops = getBusStops(USE_MOCK);
        const hit = stops.filter(
          (s) =>
            s.code.includes(q) ||
            (s.name || '').toLowerCase().includes(q) ||
            (s.road || '').toLowerCase().includes(q)
        );
        return json(hit.slice(0, 50));
      }

      // 現在地から近い順
      if (path === '/api/nearby') {
        const lat = parseFloat(url.searchParams.get('lat'));
        const lng = parseFloat(url.searchParams.get('lng'));
        if (Number.isNaN(lat) || Number.isNaN(lng))
          return json({ error: 'lat,lng が要るで' }, { status: 400 });
        const stops = getBusStops(USE_MOCK);
        const withDist = stops
          .map((s) => ({ ...s, dist: distM(lat, lng, s.lat, s.lng) }))
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 20);
        return json(withDist);
      }

      // 1件のバス停情報（地図ピン用）
      if (path.startsWith('/api/stop/')) {
        const code = path.slice('/api/stop/'.length);
        const s = getBusStops(USE_MOCK).find((x) => x.code === code);
        if (!s) return json({ error: 'みつからへん' }, { status: 404 });
        return json(s);
      }

      // 稼働状態
      if (path === '/api/status') {
        return json({ mock: USE_MOCK, keyConfigured: !USE_MOCK });
      }

      // /api/* 以外がここに来ることは基本ない（静的アセットが先に処理される）
      return json({ error: 'not found' }, { status: 404 });
    } catch (e) {
      return json({ error: String(e) }, { status: 502 });
    }
  },
};

// LTA の到着レスポンスを画面用に整形
function normalizeArrival(stop, data) {
  const now = Date.now();
  const services = (data.Services || []).map((sv) => {
    const buses = ['NextBus', 'NextBus2', 'NextBus3']
      .map((k) => sv[k])
      .filter((b) => b && b.EstimatedArrival)
      .map((b) => ({
        etaMin: Math.max(
          0,
          Math.round((new Date(b.EstimatedArrival).getTime() - now) / 60000)
        ),
        load: b.Load, // SEA=空, SDA=やや混, LSD=満員
        type: b.Type, // SD=普通, DD=2階建, BD=連節
        feature: b.Feature, // WAB=車椅子対応
      }));
    return { service: sv.ServiceNo, operator: sv.Operator, buses };
  });
  services.sort((a, b) => a.service.localeCompare(b.service, 'en', { numeric: true }));
  return { stop, services };
}

// ───────────── モックデータ ─────────────
const MOCK_STOPS = [
  { code: '83139', road: 'Upp Changi Rd East', name: 'Opp Tropicana Condo', lat: 1.34041, lng: 103.96337 },
  { code: '01012', road: 'Victoria St', name: 'Hotel Grand Pacific', lat: 1.29684, lng: 103.85253 },
  { code: '01112', road: 'Bras Basah Rd', name: "St. Joseph's Ch", lat: 1.29770, lng: 103.85369 },
  { code: '09022', road: 'Orchard Rd', name: 'Orchard Stn/Tang Plaza', lat: 1.30420, lng: 103.83217 },
  { code: '09047', road: 'Orchard Blvd', name: 'Orchard Stn Exit 13', lat: 1.30362, lng: 103.83179 },
  { code: '04167', road: 'Raffles Quay', name: 'Opp Capital Twr', lat: 1.27732, lng: 103.84675 },
  { code: '14141', road: 'Sentosa Gateway', name: 'Resorts World Sentosa', lat: 1.25434, lng: 103.82087 },
  { code: '46009', road: 'Woodlands Ave 5', name: 'Woodlands Stn', lat: 1.43699, lng: 103.78641 },
];

function mockArrival(stop) {
  const seed = Number(stop.replace(/\D/g, '').slice(-3)) || 7;
  const rnd = (n) => ((seed * (n + 3) * 7919) % 23);
  const loads = ['SEA', 'SDA', 'LSD'];
  const types = ['SD', 'DD', 'BD'];
  const svcNames = ['12', '32', '57', '107', '961', 'NR7'];
  const services = svcNames.slice(0, 4 + (seed % 3)).map((name, i) => ({
    service: name,
    operator: 'SBST',
    buses: [0, 1, 2].map((j) => ({
      etaMin: (rnd(i * 3 + j) + j * 6) % 30,
      load: loads[(seed + i + j) % 3],
      type: types[(i + j) % 3],
      feature: (i + j) % 2 ? 'WAB' : '',
    })).sort((a, b) => a.etaMin - b.etaMin),
  }));
  return { stop, services, _mock: true };
}
