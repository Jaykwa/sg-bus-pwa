# Cloudflare Workers へのデプロイ手順

Render（米国・無料プランは寝る）から **Cloudflare Workers**（シンガポールエッジ・常時起動・無料）へ移すための手順や。
経常費用は **$0/月** のまま、「米国経由」と「コールドスタート50秒」が消えるで。

---

## 構成

```
スマホ ─→ Cloudflare（世界中のエッジ。SGからも近い）
            ├─ public/ の静的ファイル … CF が直接配信（Worker通らず爆速）
            └─ /api/*               … worker.js が処理して LTA DataMall へ中継
```

- `worker.js` … API中継（server.js の Cloudflare 版）
- `wrangler.toml` … 設定（public/ を静的配信、worker.js をAPIに）
- `busstops.seed.json` … Worker にバンドル（5201停留所をメモリ即ロード）
- `assetlinks.json`（リポジトリ直下）… Worker が `/.well-known/assetlinks.json` として配信
  - ※CFのアセット配信は「.」始まりを除外するので、あえて public の外に置いて Worker が返す

---

## 前提：Node.js のバージョン

- **wrangler 3**（今入ってる）… Node 18〜20 で動く。今すぐ使える。
- **wrangler 4**（最新）… **Node 22以上が必須**。

今の環境は Node 20 やから wrangler 3 のままでOK。
将来 Node 22 に上げたら `npm i -D wrangler@4` で最新にできる（設定はそのまま使える）。

---

## 初回デプロイ

### ① Cloudflare アカウントを作る（無料）
https://dash.cloudflare.com/sign-up

### ② ログイン
```powershell
npx wrangler login
```
ブラウザが開くので許可する。

### ③ LTA の鍵を Secret として登録（ブラウザには出えへん）
```powershell
npx wrangler secret put LTA_ACCOUNT_KEY
```
プロンプトに LTA DataMall の AccountKey を貼る。

### ④ デプロイ
```powershell
npx wrangler deploy
```
成功すると URL が出る：
```
https://sg-bus-pwa.<あなたのサブドメイン>.workers.dev
```

これで完了や。寝へんし、keepalive も要らん。

---

## ローカルで動かす（開発用）

```powershell
# 初回だけ：鍵をローカル用に置く
copy .dev.vars.example .dev.vars
# .dev.vars を開いて LTA_ACCOUNT_KEY を入れる

npx wrangler dev
# → http://localhost:8787 で確認
```

`.dev.vars` は .gitignore 済みやから git には乗らへん。

---

## Androidアプリ（TWA）について ⚠️ 要対応

今のAPKは `sg-bus-pwa.onrender.com` を指しとる。Workersに移すとURLが
`sg-bus-pwa.<サブドメイン>.workers.dev` に変わるから、**どっちかの対応が要る**：

### 案A：APKを新URLで作り直す（無料・おすすめ）
- PWABuilder / Bubblewrap で **新しい workers.dev のURL** を指定してAPKを再生成
- 署名は**同じ keystore**（`android.keystore`）を使う → フィンガープリントは変わらん
- `assetlinks.json` のフィンガープリントは既に正しいので、Workerがそのまま配信 → URLバー消えたまま
- 端末で入れ直す

### 案B：独自ドメインを当てる（年額ドメイン代がかかる）
- 独自ドメイン（例 `sgbus.example.com`）を Cloudflare で Worker にルーティング
- APKもそのドメインで作る
- ドメイン代（年 $10前後）がかかるので「経常費用ゼロ」やなくなる

> 経常費用ゼロを優先するなら **案A**。workers.dev のサブドメインは無料やからな。

---

## Render を引退させる（任意）

Workersに完全移行したら：
- Render のサービスは停止 or 削除してOK
- `.github/workflows/keepalive.yml` は不要（Workersは寝えへん）→ 削除してええ

> しばらくは両方動かしといて、Workers が安定してるの確認してから Render を止めるのが安全や。

---

## 困ったとき

| 症状 | 対処 |
|------|------|
| `/api/*` が 500 | `wrangler secret put LTA_ACCOUNT_KEY` で鍵を入れたか確認 |
| 検索がモック8件しか出ん | 鍵が未設定（mockモード）。Secret を確認 |
| URLバーが消えへん | `/.well-known/assetlinks.json` が新URLで開けるか／APKのパッケージ名・署名が一致してるか |
| `Node.js v22` 必須エラー | wrangler 4 を使てる。`npm i -D wrangler@3` に戻すか Node を22に上げる |
