// ───────────────────────────────────────────────────────────
//  SG Bus  共通コアロジック（プラットフォーム非依存）
//  worker.js（Cloudflare Workers）と server.js（Node/Express）の両方が使う。
//  ここには「LTAの叩き方・整形・検索・距離・モック・キャッシュ・API保護」だけ置く。
//  ※ HTTPの受け口（Request/Response の作り方）や静的配信は各アダプタ側の責務。
// ───────────────────────────────────────────────────────────

export const LTA_BASE = 'https://datamall2.mytransport.sg/ltaodataservice';

// ── 到着データのサーバー側キャッシュ（15秒TTL）──
// LTA DataMall は約20秒ごと更新なので、15秒キャッシュしても鮮度はほぼ変わらへん。
// 複数タブ・お気に入り自動更新・モーダル自動更新が重なっても LTA への問い合わせを間引ける。
export const ARRIVAL_TTL_MS = 15_000;
const arrivalCache = new Map(); // code → { data, ts }

export function getCachedArrival(stop) {
  const hit = arrivalCache.get(stop);
  if (hit && Date.now() - hit.ts < ARRIVAL_TTL_MS) return hit.data;
  return null;
}
export function setCachedArrival(stop, data) {
  arrivalCache.set(stop, { data, ts: Date.now() });
  // メモリリーク防止：1000件超えたら一番古いものから消す
  if (arrivalCache.size > 1000) {
    const oldest = [...arrivalCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0][0];
    arrivalCache.delete(oldest);
  }
}

// ── LTA に投げる小さいヘルパ（global fetch は Node18+ / Workers 両方にある）──
export async function ltaFetch(endpoint, key) {
  const res = await fetch(`${LTA_BASE}/${endpoint}`, {
    headers: { AccountKey: key, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`LTA ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── 2点間の距離（メートル, Haversine）──
export function distM(aLat, aLng, bLat, bLng) {
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

// ── LTA の到着レスポンスを画面用に整形 ──
export function normalizeArrival(stop, data) {
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

// ───────────── ハンドラ（{ status, body, headers? } を返す純関数）─────────────
// HTTPの作法に依存せん形で返すので、worker/server どちらも同じ結果を整形して返せる。

// 到着予想。useMock のときはモック、それ以外は cache → LTA。
export async function handleArrival(stop, { key, useMock }) {
  if (!stop) return { status: 400, body: { error: 'stop が要るで' } };
  if (useMock) return { status: 200, body: mockArrival(stop) };
  const cached = getCachedArrival(stop);
  if (cached) return { status: 200, body: cached, headers: { 'X-Cache': 'HIT' } };
  const data = await ltaFetch(`v3/BusArrival?BusStopCode=${stop}`, key);
  const result = normalizeArrival(stop, data);
  setCachedArrival(stop, result);
  return { status: 200, body: result, headers: { 'X-Cache': 'MISS' } };
}

// バス停検索（コード・名前・道路名で部分一致）
export function handleSearch(q, stops) {
  const query = (q || '').toString().trim().toLowerCase();
  if (!query) return { status: 200, body: [] };
  const hit = stops.filter(
    (s) =>
      s.code.includes(query) ||
      (s.name || '').toLowerCase().includes(query) ||
      (s.road || '').toLowerCase().includes(query)
  );
  return { status: 200, body: hit.slice(0, 50) };
}

// 現在地から近い順
export function handleNearby(latRaw, lngRaw, stops) {
  const lat = parseFloat(latRaw);
  const lng = parseFloat(lngRaw);
  if (Number.isNaN(lat) || Number.isNaN(lng))
    return { status: 400, body: { error: 'lat,lng が要るで' } };
  const withDist = stops
    .map((s) => ({ ...s, dist: distM(lat, lng, s.lat, s.lng) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 20);
  return { status: 200, body: withDist };
}

// 1件のバス停情報（地図ピン用）
export function handleStop(code, stops) {
  const s = stops.find((x) => x.code === code);
  if (!s) return { status: 404, body: { error: 'みつからへん' } };
  return { status: 200, body: s };
}

// 稼働状態
export function handleStatus(useMock) {
  return { status: 200, body: { mock: useMock, keyConfigured: !useMock } };
}

// ───────────── API 濫用ガード（タダ乗りプロキシ防止）─────────────
// 正規アプリは必ず「同一オリジン」から fetch するので、ブラウザが付ける
// same-origin シグナルで判定する。外部サイトに API を埋め込まれる濫用を弾ける。
// （curl 等の完全偽装までは防げへんが、ブラウザ経由の横取りはほぼ封じられる）
//   getHeader: (name) => string|null   各アダプタがヘッダ取得関数を渡す
//   selfHost : このサーバー自身のホスト（Host ヘッダ等）
export function isAllowedApiRequest(getHeader, selfHost) {
  const secFetchSite = (getHeader('sec-fetch-site') || '').toLowerCase();
  // 同一オリジンからの fetch。最新ブラウザはこれを必ず付ける。
  if (secFetchSite === 'same-origin') return true;
  // 古いブラウザ向けフォールバック：Origin / Referer のホストが自分自身と一致
  const hostOf = (u) => {
    try { return new URL(u).host; } catch { return ''; }
  };
  const refHost = hostOf(getHeader('origin')) || hostOf(getHeader('referer'));
  return Boolean(refHost && selfHost && refHost === selfHost);
}

// ───────────── モックデータ（鍵未設定のローカル開発用）─────────────
export const MOCK_STOPS = [
  { code: '83139', road: 'Upp Changi Rd East', name: 'Opp Tropicana Condo', lat: 1.34041, lng: 103.96337 },
  { code: '01012', road: 'Victoria St', name: 'Hotel Grand Pacific', lat: 1.29684, lng: 103.85253 },
  { code: '01112', road: 'Bras Basah Rd', name: "St. Joseph's Ch", lat: 1.29770, lng: 103.85369 },
  { code: '09022', road: 'Orchard Rd', name: 'Orchard Stn/Tang Plaza', lat: 1.30420, lng: 103.83217 },
  { code: '09047', road: 'Orchard Blvd', name: 'Orchard Stn Exit 13', lat: 1.30362, lng: 103.83179 },
  { code: '04167', road: 'Raffles Quay', name: 'Opp Capital Twr', lat: 1.27732, lng: 103.84675 },
  { code: '14141', road: 'Sentosa Gateway', name: 'Resorts World Sentosa', lat: 1.25434, lng: 103.82087 },
  { code: '46009', road: 'Woodlands Ave 5', name: 'Woodlands Stn', lat: 1.43699, lng: 103.78641 },
];

export function mockArrival(stop) {
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
