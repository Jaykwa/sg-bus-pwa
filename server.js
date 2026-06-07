// ───────────────────────────────────────────────────────────
//  SG Bus PWA  中継サーバー（プロキシ）
//  役割：LTA DataMall API に AccountKey を付けて転送する。
//        鍵はここ（サーバー）に隠すので、ブラウザには出さへん。
//        鍵が無いときは自動でモックデータを返す。
// ───────────────────────────────────────────────────────────
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── .env をてきとうに読む（依存ライブラリ無しで）──
function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) {
      process.env[m[1]] ??= m[2].trim();
    }
  }
}
loadEnv();

const ACCOUNT_KEY = process.env.LTA_ACCOUNT_KEY?.trim() || '';
const PORT = process.env.PORT || 3000;
const USE_MOCK = !ACCOUNT_KEY;
const LTA_BASE = 'https://datamall2.mytransport.sg/ltaodataservice';

const app = express();
// .well-known/assetlinks.json も配信する（TWAでURLバーを消すのに必要）
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'allow' }));

// バス停一覧のキャッシュ（メモリ＋ディスク）
const STOPS_CACHE_FILE = path.join(__dirname, 'busstops.cache.json');
const STOPS_SEED_FILE = path.join(__dirname, 'busstops.seed.json'); // リポジトリ同梱（起動を速く）
let busStops = null;

// ── LTA に投げる小さいヘルパ ──
async function ltaFetch(endpoint) {
  const res = await fetch(`${LTA_BASE}/${endpoint}`, {
    headers: { AccountKey: ACCOUNT_KEY, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`LTA ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── バス停一覧を全件取得（500件ずつページング）──
async function fetchAllBusStops() {
  const all = [];
  for (let skip = 0; skip < 10000; skip += 500) {
    const data = await ltaFetch(`BusStops?$skip=${skip}`);
    const rows = data.value || [];
    all.push(...rows);
    if (rows.length < 500) break; // 最後のページ
  }
  return all.map((s) => ({
    code: s.BusStopCode,
    road: s.RoadName,
    name: s.Description,
    lat: s.Latitude,
    lng: s.Longitude,
  }));
}

async function getBusStops() {
  if (busStops) return busStops;
  if (USE_MOCK) {
    busStops = MOCK_STOPS;
    return busStops;
  }
  // ① 実行時キャッシュ（手動更新した最新があれば優先）
  if (fs.existsSync(STOPS_CACHE_FILE)) {
    busStops = JSON.parse(fs.readFileSync(STOPS_CACHE_FILE, 'utf8'));
    console.log(`バス停 ${busStops.length} 件をキャッシュから読み込み`);
    return busStops;
  }
  // ② リポジトリ同梱のseed（クラウド起動直後でも即ロード＝LTAへ取りに行かへん）
  if (fs.existsSync(STOPS_SEED_FILE)) {
    busStops = JSON.parse(fs.readFileSync(STOPS_SEED_FILE, 'utf8'));
    console.log(`バス停 ${busStops.length} 件を同梱seedから即ロード`);
    return busStops;
  }
  // ③ どちらも無ければLTAから取得（初回フォールバック）
  console.log('LTA からバス停一覧を取得中…（初回だけ時間かかる）');
  busStops = await fetchAllBusStops();
  // クラウドだとファイルシステムが読み取り専用のことがあるので失敗しても落とさへん
  try {
    fs.writeFileSync(STOPS_CACHE_FILE, JSON.stringify(busStops));
  } catch (e) {
    console.warn('バス停キャッシュの保存はスキップ（メモリ上で保持）:', e.message);
  }
  console.log(`バス停 ${busStops.length} 件を読み込んだで`);
  return busStops;
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

// ───────────── API ルート ─────────────

// 到着予想
app.get('/api/arrival', async (req, res) => {
  const stop = req.query.stop;
  if (!stop) return res.status(400).json({ error: 'stop が要るで' });
  try {
    if (USE_MOCK) return res.json(mockArrival(stop));
    const data = await ltaFetch(`v3/BusArrival?BusStopCode=${stop}`);
    res.json(normalizeArrival(stop, data));
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// バス停検索（コード・名前・道路名で部分一致）
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  if (!q) return res.json([]);
  const stops = await getBusStops();
  const hit = stops.filter(
    (s) =>
      s.code.includes(q) ||
      (s.name || '').toLowerCase().includes(q) ||
      (s.road || '').toLowerCase().includes(q)
  );
  res.json(hit.slice(0, 50));
});

// 現在地から近い順
app.get('/api/nearby', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng))
    return res.status(400).json({ error: 'lat,lng が要るで' });
  const stops = await getBusStops();
  const withDist = stops
    .map((s) => ({ ...s, dist: distM(lat, lng, s.lat, s.lng) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 20);
  res.json(withDist);
});

// 1件のバス停情報（地図ピン用）
app.get('/api/stop/:code', async (req, res) => {
  const stops = await getBusStops();
  const s = stops.find((x) => x.code === req.params.code);
  if (!s) return res.status(404).json({ error: 'みつからへん' });
  res.json(s);
});

app.get('/api/status', (req, res) => {
  res.json({ mock: USE_MOCK, keyConfigured: !USE_MOCK });
});

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

app.listen(PORT, () => {
  console.log(`\n🚌 SG Bus PWA → http://localhost:${PORT}`);
  console.log(USE_MOCK
    ? '⚠️  モックモード（.env に LTA_ACCOUNT_KEY 未設定）'
    : '✅ 本番モード（LTA DataMall に接続）');
});
