// ───────────────────────────────────────────────────────────
//  SG Bus PWA  中継サーバー（プロキシ）※ローカル開発／Render用
//  役割：LTA DataMall API に AccountKey を付けて転送する。
//        鍵はここ（サーバー）に隠すので、ブラウザには出さへん。
//        鍵が無いときは自動でモックデータを返す。
//
//  コアロジック（整形・検索・距離・モック・キャッシュ・濫用ガード）は
//  lib/busapi.js に集約。ここは Express の受け口＋バス停データ供給だけ。
//  本番（Cloudflare Workers）は worker.js が同じ lib を使う。
// ───────────────────────────────────────────────────────────
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MOCK_STOPS,
  ltaFetch,
  handleArrival,
  handleSearch,
  handleNearby,
  handleStop,
  handleStatus,
  isAllowedApiRequest,
} from './lib/busapi.js';

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

const app = express();
// TWAでURLバーを消すのに必要。assetlinks.json はリポジトリ直下に置いてあるので明示配信する
// （Cloudflare Workers と置き場所を揃えるため public の外に出した）。
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'assetlinks.json'));
});
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'allow' }));

// バス停一覧のキャッシュ（メモリ＋ディスク）
const STOPS_CACHE_FILE = path.join(__dirname, 'busstops.cache.json');
const STOPS_SEED_FILE = path.join(__dirname, 'busstops.seed.json'); // リポジトリ同梱（起動を速く）
let busStops = null;

// ── バス停一覧を全件取得（500件ずつページング）──
async function fetchAllBusStops() {
  const all = [];
  for (let skip = 0; skip < 10000; skip += 500) {
    const data = await ltaFetch(`BusStops?$skip=${skip}`, ACCOUNT_KEY);
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

// ハンドラの { status, body, headers } を Express レスポンスに変換
function send(res, { status, body, headers }) {
  if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(status).json(body);
}

// ───────────── API ルート ─────────────

// 稼働状態は監視用に常に開けておく（濫用ガードの対象外）
app.get('/api/status', (req, res) => send(res, handleStatus(USE_MOCK)));

// ここから先のデータAPIは「自オリジンからの呼び出し」だけ許可（タダ乗り防止）
app.use('/api', (req, res, next) => {
  if (isAllowedApiRequest((k) => req.get(k), req.get('host'))) return next();
  res.status(403).json({ error: 'このAPIは公開しとらんで' });
});

// 到着予想
app.get('/api/arrival', async (req, res) => {
  try {
    send(res, await handleArrival(req.query.stop, { key: ACCOUNT_KEY, useMock: USE_MOCK }));
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// バス停検索（コード・名前・道路名で部分一致）
app.get('/api/search', async (req, res) => {
  send(res, handleSearch(req.query.q, await getBusStops()));
});

// 現在地から近い順
app.get('/api/nearby', async (req, res) => {
  send(res, handleNearby(req.query.lat, req.query.lng, await getBusStops()));
});

// 1件のバス停情報（地図ピン用）
app.get('/api/stop/:code', async (req, res) => {
  send(res, handleStop(req.params.code, await getBusStops()));
});

app.listen(PORT, () => {
  console.log(`\n🚌 SG Bus PWA → http://localhost:${PORT}`);
  console.log(USE_MOCK
    ? '⚠️  モックモード（.env に LTA_ACCOUNT_KEY 未設定）'
    : '✅ 本番モード（LTA DataMall に接続）');
});
