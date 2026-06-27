// ───────────────────────────────────────────────
//  SG Bus PWA  フロント側ロジック
// ───────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const api = (p) => fetch(p).then((r) => r.json());

// 外部のピン画像は環境によって読めへんことがあるので、SVGを埋め込んだ自前ピンを使う。
// これならネット画像を取りに行かんから確実に表示される。
const PIN_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 38">
  <path d="M13 0C5.8 0 0 5.8 0 13c0 9.2 13 25 13 25s13-15.8 13-25C26 5.8 20.2 0 13 0z" fill="#0b6b3a"/>
  <circle cx="13" cy="13" r="6.5" fill="#ffffff"/>
  <circle cx="13" cy="13" r="3" fill="#0b6b3a"/>
</svg>`;
const busIcon = L.icon({
  iconUrl: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(PIN_SVG),
  iconSize: [26, 38],
  iconAnchor: [13, 38],   // ピン先端が座標に来るように
  popupAnchor: [0, -34],  // 吹き出しはピンの上に
});

// 車種アイコン（車椅子マーク♿と同サイズ。currentColorで色付け）
const IC_DOUBLE_DECKER = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <rect x="3" y="2.5" width="18" height="16" rx="2.5" fill="currentColor"/>
  <rect x="5" y="4.5" width="14" height="4" rx="1" fill="#fff"/>
  <rect x="5" y="10" width="14" height="4" rx="1" fill="#fff"/>
  <circle cx="8" cy="21" r="1.7" fill="currentColor"/>
  <circle cx="16" cy="21" r="1.7" fill="currentColor"/>
</svg>`;
const IC_BENDY = `<svg viewBox="0 0 28 24" aria-hidden="true">
  <rect x="1.5" y="6" width="11" height="11" rx="2" fill="currentColor"/>
  <rect x="15.5" y="6" width="11" height="11" rx="2" fill="currentColor"/>
  <rect x="12.5" y="9.5" width="3" height="4" fill="currentColor"/>
  <rect x="3.5" y="8" width="7" height="3.5" rx="1" fill="#fff"/>
  <rect x="17.5" y="8" width="7" height="3.5" rx="1" fill="#fff"/>
  <circle cx="6" cy="19" r="1.6" fill="currentColor"/>
  <circle cx="22" cy="19" r="1.6" fill="currentColor"/>
</svg>`;

const FAV_KEY = 'sgbus.favorites';
let favorites = JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); // バス停まるごと [{code,name,road}]
const FAVSVC_KEY = 'sgbus.favservices';
let favServices = JSON.parse(localStorage.getItem(FAVSVC_KEY) || '[]'); // 路線単位 [{code,name,road,service}]
let map, mapMarkers = [];
let refreshTimer = null;
let currentModalStop = null;

// クライアント側の到着データキャッシュ（stale-while-revalidate）
// 直近に見た/更新したデータを保持し、モーダルを即表示する。60秒以内は「使えるデータ」とみなす。
const clientArrivalCache = new Map(); // code → { data, ts }
const CLIENT_STALE_MS = 60_000;

// ── 起動 ──
init();
async function init() {
  const st = await api('/api/status').catch(() => ({ mock: true }));
  $('#modeBadge').textContent = st.mock ? 'モックデータ' : 'ライブ';

  $('#searchInput').addEventListener('input', debounce(onSearch, 300));
  $('#nearbyBtn').addEventListener('click', onNearby);
  $('#locateBtn').addEventListener('click', locateAndPlot); // 地図：現在地に戻る
  $('#hereBtn').addEventListener('click', plotHere);         // 地図：今見てる場所の付近を表示
  document.querySelectorAll('.tabs button').forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.tab))
  );
  $('#mClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#mFav').addEventListener('click', toggleCurrentFav);
  $('#favRefresh').addEventListener('click', async () => {  // お気に入り全体を手動更新
    const ic = $('#favRefresh .ref-ic');
    ic.classList.add('spinning');
    await refreshFavServiceEtas();
    setTimeout(() => ic.classList.remove('spinning'), 400);
  });
  $('#mRefresh').addEventListener('click', async () => {  // 手動更新
    if (!currentModalStop) return;
    const btn = $('#mRefresh');
    btn.classList.add('spinning');
    await loadArrivals(currentModalStop.code);
    btn.classList.remove('spinning');
  });

  document.addEventListener('visibilitychange', onVisibilityChange);

  switchTab('fav'); // 起動時はお気に入りタブを表示（描画＋30秒更新も開始）
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

// 他アプリに切り替わったら更新を止め、戻ってきたら即更新して再開する
function onVisibilityChange() {
  const favActive = $('#view-fav').classList.contains('active');
  const modalOpen = currentModalStop && !$('#modal').classList.contains('hidden');
  if (document.hidden) {
    stopFavRefresh();
    clearInterval(refreshTimer); // モーダルの自動更新も止める
  } else {
    if (modalOpen) {            // 開いてる到着画面を即更新して再開
      loadArrivals(currentModalStop.code);
      clearInterval(refreshTimer);
      refreshTimer = setInterval(() => loadArrivals(currentModalStop.code), 20000);
    }
    if (favActive) {            // お気に入りを即更新して再開
      refreshFavServiceEtas();
      startFavRefresh();
    }
  }
}

// ── タブ切替 ──
function switchTab(tab) {
  document.querySelectorAll('.tabs button').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(`#view-${tab}`).classList.add('active');
  // 検索バーは「一覧」タブのときだけ表示（地図・お気に入りでは不要）
  $('.search').style.display = tab === 'list' ? 'flex' : 'none';
  if (tab === 'map') setupMap();
  if (tab === 'fav') { renderFavorites(); startFavRefresh(); }
  else stopFavRefresh(); // 他タブに移ったら30秒更新は止める
}

// ── 検索クエリの正規化＆日本語→英語変換 ──
// 全角英数字・全角スペースを半角へ
function normalizeQuery(q) {
  return q
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')
    .trim();
}

// シンガポールの主要地名・MRT・ランドマークの日本語→英語辞書
const JP_PLACE = {
  'オーチャード': 'Orchard', 'サマセット': 'Somerset', 'ドビーゴート': 'Dhoby Ghaut',
  'シティホール': 'City Hall', 'ラッフルズ': 'Raffles', 'マリーナベイ': 'Marina Bay',
  'マリーナ': 'Marina', 'ベイフロント': 'Bayfront', 'ブギス': 'Bugis',
  'チャイナタウン': 'Chinatown', '中華街': 'Chinatown', 'クラークキー': 'Clarke Quay',
  'リトルインディア': 'Little India', 'ファーラーパーク': 'Farrer Park', 'ノベナ': 'Novena',
  'ニュートン': 'Newton', 'チャンギ空港': 'Changi Airport', 'チャンギ': 'Changi',
  '空港': 'Airport', 'セントーサ': 'Sentosa', 'ハーバーフロント': 'HarbourFront',
  'ジュロンイースト': 'Jurong East', 'ジュロン': 'Jurong', 'ブーンレイ': 'Boon Lay',
  'クレメンティ': 'Clementi', 'ブオナビスタ': 'Buona Vista', 'ウッドランズ': 'Woodlands',
  'アドミラルティ': 'Admiralty', 'センバワン': 'Sembawang', 'イーシュン': 'Yishun',
  'タンピネス': 'Tampines', 'ベドック': 'Bedok', 'パシリス': 'Pasir Ris',
  'タナメラ': 'Tanah Merah', 'ユーノス': 'Eunos', 'パヤレバ': 'Paya Lebar',
  'アンモキオ': 'Ang Mo Kio', 'ビシャン': 'Bishan', 'トアパヨ': 'Toa Payoh',
  'セラングーン': 'Serangoon', 'ホウガン': 'Hougang', 'センカン': 'Sengkang',
  'プンゴル': 'Punggol', 'カトン': 'Katong', 'ゲイラン': 'Geylang',
  'ブキティマ': 'Bukit Timah', 'ブキバトック': 'Bukit Batok', 'ブキパンジャン': 'Bukit Panjang',
  'チョアチューカン': 'Choa Chu Kang', 'カラン': 'Kallang', 'ラベンダー': 'Lavender',
  '病院': 'Hospital', '大学': 'University', '公園': 'Park', '動物園': 'Zoo',
  'マウントエリザベス': 'Mount Elizabeth', 'タンジョンパガー': 'Tanjong Pagar',
  // ── 観光ガイド掲載スポット（バス停データでヒット確認済み）──
  'マリーナベイサンズ': 'Marina Bay Sands', 'ガーデンズバイザベイ': 'Gardens by the Bay',
  'マーライオン': 'Fullerton', 'シンガポールフライヤー': 'Flyer', 'エスプラネード': 'Esplanade',
  'ボートキー': 'Boat', 'ハジレーン': 'Haji', 'アラブストリート': 'Sultan',
  'カンポングラム': 'Sultan', 'サルタンモスク': 'Sultan', 'チャイムス': 'Chijmes',
  'ボタニックガーデン': 'Botanic', '植物園': 'Botanic', 'ナイトサファリ': 'Mandai',
  'リバーサファリ': 'Mandai', 'マンダイ': 'Mandai', 'バードパーク': 'Bird Paradise',
  'サイエンスセンター': 'Science Ctr', 'ユニバーサルスタジオ': 'Resorts World',
  'リゾートワールド': 'Resorts World', 'ビボシティ': 'VivoCity', 'マウントフェーバー': 'Faber',
  'ティオンバル': 'Tiong Bahru', 'ホランドビレッジ': 'Holland', 'デンプシー': 'Dempsey',
  'チャンギビレッジ': 'Changi Village', 'サンテックシティ': 'Suntec', 'ラッフルズプレイス': 'Raffles Pl',
  'フォートカニング': 'Fort Canning', '国立博物館': 'Museum', '博物館': 'Museum',
  'ナショナルスタジアム': 'Stadium', 'スタジアム': 'Stadium', 'イーストコースト': 'East Coast',
  'スリマリアマン': 'Sri Mariamman', 'マックスウェル': 'Maxwell', 'ロチョー': 'Rochor',
  'テロックアヤ': 'Telok Ayer',
};

// 日本語が含まれていれば辞書で英語に置換（最長一致優先）
function jpToEn(q) {
  if (!/[぀-ヿ㐀-鿿]/.test(q)) return q; // 日本語なし→そのまま
  let out = q;
  for (const k of Object.keys(JP_PLACE).sort((a, b) => b.length - a.length)) {
    if (out.includes(k)) out = out.split(k).join(' ' + JP_PLACE[k] + ' ');
  }
  // 変換し切れなかった日本語は除去して整える
  out = out.replace(/[぀-ヿ㐀-鿿]/g, ' ').replace(/\s+/g, ' ').trim();
  return out || q;
}

// ── 検索 ──
async function onSearch(e) {
  const q = jpToEn(normalizeQuery(e.target.value));
  if (q.length < 2) { $('#results').innerHTML = ''; $('#listHint').style.display = 'block'; return; }
  $('#listHint').style.display = 'none';
  const stops = await api('/api/search?q=' + encodeURIComponent(q));
  renderStopList(stops, '#results');
}

// ── 近く ──
function onNearby() {
  if (!navigator.geolocation) return alert('位置情報が使えへん端末や');
  $('#listHint').style.display = 'none';
  $('#results').innerHTML = '<div class="spin">現在地を取得中…📍</div>';
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      const stops = await api(`/api/nearby?lat=${latitude}&lng=${longitude}`);
      renderStopList(stops, '#results');
    },
    () => { $('#results').innerHTML = '<div class="spin">位置情報が取れんかった…手で検索してや</div>'; },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

// ── バス停リスト描画 ──
function renderStopList(stops, target) {
  const el = $(target);
  if (!stops.length) { el.innerHTML = '<div class="spin">みつからへん…</div>'; return; }
  el.innerHTML = '';
  for (const s of stops) {
    const card = document.createElement('div');
    card.className = 'stop-card';
    const distTxt = s.dist != null ? `${s.dist} m` : s.code;
    card.innerHTML = `
      <div>
        <div class="name">${esc(s.name || s.code)}</div>
        <div class="meta">${esc(s.road || '')} ・ コード ${s.code}</div>
      </div>
      <div class="right">${distTxt}</div>`;
    card.addEventListener('click', () => openStop(s));
    el.appendChild(card);
  }
}

// ── 到着モーダル ──
async function openStop(stop) {
  currentModalStop = stop;
  $('#mTitle').textContent = stop.name || stop.code;
  $('#mSub').textContent = `${stop.road || ''} ・ コード ${stop.code}`;
  $('#mBody').innerHTML = '<div class="spin">到着情報を取得中…🚌</div>';
  $('#mFav').textContent = isFav(stop.code) ? '★' : '☆';
  $('#modal').classList.remove('hidden');
  loadArrivals(stop.code);
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => loadArrivals(stop.code), 20000); // 20秒ごと自動更新
}

async function loadArrivals(code) {
  // キャッシュがあれば即表示（スピナー無し → チラつかへん）
  const cached = clientArrivalCache.get(code);
  if (cached && Date.now() - cached.ts < CLIENT_STALE_MS) {
    renderArrivals(cached.data);
  }
  // 裏で最新データを取得して上書き
  try {
    const data = await api('/api/arrival?stop=' + code);
    clientArrivalCache.set(code, { data, ts: Date.now() });
    renderArrivals(data);
  } catch {
    if (!cached) $('#mBody').innerHTML = '<div class="spin">取得に失敗したわ…</div>';
  }
}

function renderArrivals(data) {
  const body = $('#mBody');
  if (!data.services || !data.services.length) {
    body.innerHTML = '<div class="spin">今は運行情報が無いみたいや（終バス後かも）</div>';
  } else {
    body.innerHTML = '';
    const stop = currentModalStop;
    for (const sv of data.services) {
      const card = document.createElement('div');
      card.className = 'arr-card';
      const etas = sv.buses.length
        ? sv.buses.map((b, i) => etaHtml(b, i)).join('')
        : '<div class="eta"><div class="lbl">運行情報なし</div></div>';
      const faved = isFavSvc(stop?.code, sv.service);
      card.innerHTML =
        `<div class="svc-no">${esc(sv.service)}</div>` +
        `<div class="etas">${etas}</div>` +
        `<button class="svc-star" title="この番号をお気に入り">${faved ? '★' : '☆'}</button>`;
      card.querySelector('.svc-star').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavSvc(stop, sv.service);
        e.target.textContent = isFavSvc(stop?.code, sv.service) ? '★' : '☆';
      });
      body.appendChild(card);
    }
  }
  const now = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('#mFoot').textContent = `更新 ${now}${data._mock ? '（モックデータ）' : ''} ・ 20秒ごとに自動更新`;
}

// 混雑度の区分。SEA=空き / SDA=やや混 / LSD=満員（到着数字の色分けに使う）
const LOAD_INFO = {
  SEA: { cls: 'low' },
  SDA: { cls: 'mid' },
  LSD: { cls: 'high' },
};

// 到着時間の数字を「混雑度」で色分けするためのクラス。
// 緑=空き(SEA) / オレンジ=やや混(SDA) / 赤=満員(LSD)。混雑度不明はデフォルト色。
function loadColorClass(load) {
  const info = LOAD_INFO[load];
  return info ? 'lc-' + info.cls : '';
}

// 車種・設備のアイコン列（♿と同サイズ）
function vehicleIcons(b) {
  const out = [];
  if (b.type === 'DD') out.push(`<span class="ic" title="2階建てバス">${IC_DOUBLE_DECKER}</span>`);
  if (b.type === 'BD') out.push(`<span class="ic" title="連節バス">${IC_BENDY}</span>`);
  if (b.feature === 'WAB') out.push('<span class="ic ic-emoji" title="車椅子対応">♿</span>');
  return out.length ? `<div class="ic-row">${out.join('')}</div>` : '';
}

function etaHtml(b) {
  const cls = loadColorClass(b.load); // 混雑度で色分け（緑→オレンジ→赤）
  const num = b.etaMin <= 0 ? '到着' : `${b.etaMin}<span class="unit">分</span>`;
  return `<div class="eta">
    <div class="min ${cls}">${num}</div>
    ${vehicleIcons(b)}
  </div>`;
}

function closeModal() {
  $('#modal').classList.add('hidden');
  clearInterval(refreshTimer);
  currentModalStop = null;
}

// ── お気に入り：バス停まるごと ──
function isFav(code) { return favorites.some((f) => f.code === code); }
function toggleCurrentFav() {
  const s = currentModalStop;
  if (!s) return;
  if (isFav(s.code)) favorites = favorites.filter((f) => f.code !== s.code);
  else favorites.push({ code: s.code, name: s.name, road: s.road });
  localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
  $('#mFav').textContent = isFav(s.code) ? '★' : '☆';
  renderFavorites();
}

// ── お気に入り：バス停＋路線番号（ピンポイント）──
function isFavSvc(code, service) {
  return favServices.some((f) => f.code === code && f.service === service);
}
function toggleFavSvc(stop, service) {
  if (!stop) return;
  if (isFavSvc(stop.code, service)) {
    favServices = favServices.filter((f) => !(f.code === stop.code && f.service === service));
  } else {
    favServices.push({ code: stop.code, name: stop.name, road: stop.road, service });
  }
  localStorage.setItem(FAVSVC_KEY, JSON.stringify(favServices));
  renderFavorites();
}

// ── 並び替え（ドラッグ＆ドロップ：SortableJS）──
// ドラッグ用つまみのHTML
const DRAG_HANDLE = '<span class="drag-handle" title="ドラッグで並べ替え">⠿</span>';

// 指定コンテナをドラッグ並べ替え可能にする。確定時に onCommit(順番のcode配列) を呼ぶ
function makeSortable(container, onCommit) {
  if (!window.Sortable) return; // ライブラリ未読込なら何もしない（アプリは動く）
  new Sortable(container, {
    handle: '.drag-handle',
    animation: 150,
    delay: 80,                 // ちょい押しで開始（誤爆防止）
    delayOnTouchOnly: true,
    forceFallback: true,       // タッチ挙動を安定させる
    onEnd: () => {
      const order = [...container.children].map((c) => c.dataset.code);
      onCommit(order);
    },
  });
}

// 右スワイプ中の直後はタップ（到着を開く）を抑制するフラグ
let suppressOpen = false;

// カードを右スワイプで削除できるようにする。閾値超えたら onDelete()
function enableSwipeDelete(card, onDelete) {
  let startX = 0, startY = 0, active = false, decided = false, horiz = false;
  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.drag-handle')) return; // つまみは並べ替え優先
    active = true; decided = false; horiz = false;
    startX = e.clientX; startY = e.clientY;
    card.style.transition = '';
  });
  card.addEventListener('pointermove', (e) => {
    if (!active) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!decided && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      decided = true;
      horiz = Math.abs(dx) > Math.abs(dy);
      if (horiz) card.setPointerCapture(e.pointerId);
    }
    if (decided && horiz) {
      e.preventDefault();
      const x = Math.max(0, dx); // 右方向だけ
      card.style.transform = `translateX(${x}px)`;
      card.parentElement.classList.toggle('will-delete', x > card.offsetWidth * 0.4);
    }
  });
  const finish = (e) => {
    if (!active) return; active = false;
    if (!decided || !horiz) return;
    const dx = e.clientX - startX;
    const w = card.offsetWidth;
    card.style.transition = 'transform .2s ease, opacity .2s ease';
    if (dx > w * 0.4) {
      card.style.transform = `translateX(${w}px)`;
      card.style.opacity = '0';
      suppressOpen = true; setTimeout(() => { suppressOpen = false; }, 400);
      setTimeout(onDelete, 180);
    } else {
      card.style.transform = '';
      card.parentElement.classList.remove('will-delete');
    }
  };
  card.addEventListener('pointerup', finish);
  card.addEventListener('pointercancel', finish);
}

// カードを削除可能なラッパで包む
function wrapSwipe(card, code, onDelete) {
  const item = document.createElement('div');
  item.className = 'swipe-item';
  item.dataset.code = code; // SortableJS が順番を読む
  item.innerHTML = '<div class="swipe-bg">🗑 削除</div>';
  item.appendChild(card);
  enableSwipeDelete(card, onDelete);
  return item;
}

function renderFavorites() {
  const el = $('#favList');
  const empty = !favorites.length && !favServices.length;
  $('#favHint').style.display = empty ? 'block' : 'none';
  $('#favToolbar').style.display = empty ? 'none' : 'flex';
  el.innerHTML = '';

  // 路線お気に入り（バス停ごとにまとめてライブETA付き）
  if (favServices.length) {
    el.insertAdjacentHTML('beforeend', '<h3 class="fav-h">🚌 バス番号＋バス停</h3>');
    const sec = document.createElement('div');
    sec.className = 'fav-section';
    // バス停ごとにグループ化（登録順を保つ）
    const byStop = new Map();
    for (const f of favServices) {
      if (!byStop.has(f.code)) byStop.set(f.code, { code: f.code, name: f.name, road: f.road, services: [] });
      byStop.get(f.code).services.push(f.service);
    }
    for (const g of byStop.values()) {
      const card = document.createElement('div');
      card.className = 'stop-card fav-stop';
      card.dataset.code = g.code;
      const lines = g.services.map((sv) => `
        <div class="fav-svc-line" data-service="${esc(sv)}">
          <span class="svc-pill">${esc(sv)}</span>
          <span class="right" data-eta>…</span>
        </div>`).join('');
      card.innerHTML = `
        <div class="fav-stop-head">
          <div class="fav-stop-text">
            <div class="name">${esc(g.name || g.code)}</div>
            <div class="meta">${esc(g.road || '')} ・ コード ${g.code}</div>
          </div>
          ${DRAG_HANDLE}
        </div>
        <div class="fav-svc-lines">${lines}</div>`;
      const open = () => { if (!suppressOpen) openStop({ code: g.code, name: g.name, road: g.road }); };
      card.querySelector('.fav-stop-text').addEventListener('click', open);
      card.querySelector('.fav-svc-lines').addEventListener('click', open);
      sec.appendChild(wrapSwipe(card, g.code, () => {
        favServices = favServices.filter((f) => f.code !== g.code); // この停留所の番号を全部削除
        localStorage.setItem(FAVSVC_KEY, JSON.stringify(favServices));
        renderFavorites();
      }));
    }
    el.appendChild(sec);
    refreshFavServiceEtas(); // 初回の数字を埋める
    // ドラッグ確定：バス停グループの順番で favServices を組み直す（番号の中身は保つ）
    makeSortable(sec, (order) => {
      const groups = {};
      for (const f of favServices) (groups[f.code] ??= []).push(f);
      favServices = order.flatMap((c) => groups[c] || []);
      localStorage.setItem(FAVSVC_KEY, JSON.stringify(favServices));
    });
  }

  // バス停まるごとお気に入り
  if (favorites.length) {
    el.insertAdjacentHTML('beforeend', '<h3 class="fav-h">🚏 バス停まるごと</h3>');
    const sec = document.createElement('div');
    sec.className = 'fav-section';
    favorites.forEach((s) => {
      const card = document.createElement('div');
      card.className = 'stop-card';
      card.dataset.code = s.code;
      card.innerHTML = `
        <div class="fav-stop-text">
          <div class="name">★ ${esc(s.name || s.code)}</div>
          <div class="meta">${esc(s.road || '')} ・ コード ${s.code}</div>
        </div>
        ${DRAG_HANDLE}`;
      card.querySelector('.fav-stop-text').addEventListener('click', () => { if (!suppressOpen) openStop(s); });
      sec.appendChild(wrapSwipe(card, s.code, () => {
        favorites = favorites.filter((f) => f.code !== s.code);
        localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
        renderFavorites();
      }));
    });
    el.appendChild(sec);
    // ドラッグ確定：その順番で favorites を組み直す
    makeSortable(sec, (order) => {
      const byCode = Object.fromEntries(favorites.map((s) => [s.code, s]));
      favorites = order.map((c) => byCode[c]).filter(Boolean);
      localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
    });
  }
}

// お気に入り路線のETAだけ更新（カードは作り直さへんのでチラつかへん）。Promiseを返す
function refreshFavServiceEtas() {
  if (!favServices.length) return Promise.resolve();
  // 同じバス停は1回だけ問い合わせる
  const byStop = {};
  for (const f of favServices) (byStop[f.code] ??= []).push(f);
  const tasks = Object.keys(byStop).map((code) =>
    api('/api/arrival?stop=' + code).then((data) => {
      clientArrivalCache.set(code, { data, ts: Date.now() }); // モーダルの即表示に使う
      const svcMap = {};
      for (const sv of data.services || []) svcMap[sv.service] = sv.buses || [];
      for (const f of byStop[code]) {
        const cell = document.querySelector(
          `.fav-stop[data-code="${cssEsc(f.code)}"] .fav-svc-line[data-service="${cssEsc(f.service)}"] [data-eta]`
        );
        if (!cell) continue;
        const buses = svcMap[f.service] || [];
        cell.innerHTML = buses.length
          ? buses.slice(0, 3).map((b) => {
              const t = b.etaMin <= 0 ? '到着' : b.etaMin + '分';
              const cls = loadColorClass(b.load); // 混雑度で色分け（緑→オレンジ→赤）
              return `<span class="min ${cls}">${t}</span>`;
            }).join(' ')
          : '<span class="muted">運行情報なし</span>';
        // バス番号バッジを「直近バスの混雑度」で色づけ（ひと目で混み具合がわかる）
        const pill = cell.closest('.fav-svc-line')?.querySelector('.svc-pill');
        if (pill) pill.className = 'svc-pill ' + (buses[0] ? loadColorClass(buses[0].load) : '');
      }
    }).catch(() => {})
  );
  return Promise.all(tasks);
}

let favTimer = null;
function startFavRefresh() {
  clearInterval(favTimer);
  favTimer = setInterval(refreshFavServiceEtas, 30000); // 30秒ごと
}
function stopFavRefresh() { clearInterval(favTimer); }

// ── 地図 ──
let meMarker = null;

function setupMap() {
  if (!map) {
    map = L.map('map').setView([1.3521, 103.8198], 12); // 初期：シンガポール中心
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(map);
  }
  // タブ表示直後はサイズが0なので測り直す
  setTimeout(() => map.invalidateSize(), 100);
  // 開くたびに現在地へ移動して近くのバス停を表示
  locateAndPlot();
}

function locateAndPlot() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      map.setView([latitude, longitude], 16);
      // 現在地マーカー（青丸）は1個だけ使い回す
      if (meMarker) meMarker.setLatLng([latitude, longitude]);
      else meMarker = L.circleMarker([latitude, longitude], {
        radius: 7, color: '#1a73e8', fillColor: '#1a73e8', fillOpacity: 0.9,
      }).addTo(map).bindPopup('現在地');
      const stops = await api(`/api/nearby?lat=${latitude}&lng=${longitude}`);
      plotStops(stops);
    },
    () => {}, // 位置取れんかったらシンガポール全体のまま
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

// 今表示している地図の中心付近のバス停をプロット（現在地ではなく「見てる場所」基準）
async function plotHere() {
  if (!map) return;
  const btn = $('#hereBtn');
  btn.disabled = true; // 二度押し防止（応答は速いので一瞬）
  try {
    const c = map.getCenter();
    const stops = await api(`/api/nearby?lat=${c.lat}&lng=${c.lng}`);
    plotStops(stops);
  } catch { /* 取得失敗は黙ってスルー（既存ピンは残す）*/ }
  btn.disabled = false;
}

function plotStops(stops) {
  mapMarkers.forEach((m) => map.removeLayer(m));
  mapMarkers = [];
  for (const s of stops) {
    if (!s.lat || !s.lng) continue;
    const m = L.marker([s.lat, s.lng], { icon: busIcon }).addTo(map);
    const distTxt = s.dist != null ? `<br>約 ${s.dist} m` : '';
    m.bindPopup(`<b>${esc(s.name || s.code)}</b><br>${esc(s.road || '')}（${s.code}）${distTxt}
      <br><button class="map-go" onclick="window._openFromMap('${s.code}')">🚌 到着を見る</button>`);
    mapMarkers.push(m);
  }
}
window._openFromMap = async (code) => {
  const s = await api('/api/stop/' + code);
  openStop(s);
};

// ── ちょいユーティリティ ──
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function cssEsc(s) {
  return window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&');
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
