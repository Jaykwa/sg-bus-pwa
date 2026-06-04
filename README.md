# 🚌 SG Bus PWA

シンガポールの公共バスの**到着予想時間**を表示するPWA（Webアプリ）。
LTA DataMall の公式リアルタイムデータを使う。

## 機能
- バス停の到着予想時間（次・次々・3本目）＋混雑度・車種・車椅子対応マーク
- お気に入りバス停（端末に保存）
- 現在地から近いバス停（GPS）
- バス停・路線・道路名で検索
- 地図表示（Leaflet + OpenStreetMap、無料）
- ホーム画面に追加できる（PWA・オフラインでも殻は開く）

## 動かし方

```bash
npm install
npm start          # → http://localhost:3000
```

`.env` の `LTA_ACCOUNT_KEY` が空のときは**モックデータ**で動く（画面確認用）。
本番データにするには下の鍵を取って `.env` に貼るだけ。

```
LTA_ACCOUNT_KEY=ここに鍵
```

## LTA DataMall の AccountKey の取り方（無料）

1. https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html を開く
2. 名前・メール・組織名（個人なら自分の名前でOK）を入力して申請
3. **メールで AccountKey が届く**（だいたい即時〜数営業日）
4. 届いた鍵を `.env` の `LTA_ACCOUNT_KEY=` に貼る
5. サーバー再起動 → バッジが「ライブ」になれば成功

> 初回起動時、サーバーがバス停一覧（5000件超）を取得して
> `busstops.cache.json` に保存する。検索・近く・地図で使う。

## 構成

```
[ブラウザ/PWA]  →  [server.js (中継・鍵を隠す)]  →  [LTA DataMall API]
  public/             ・/api/arrival  到着予想
  ├ index.html        ・/api/search   バス停検索
  ├ app.js            ・/api/nearby   現在地から近い順
  ├ styles.css        ・/api/stop/:code
  ├ sw.js (PWA)       ・/api/status
  └ manifest...
```

### なんでサーバーが要るん？
LTA DataMall は ①ブラウザから直接呼ぶと CORS で弾かれる ②鍵をフロントに置くと丸見え。
そやから鍵を持った中継サーバーを挟む。これが定石やで。

## デプロイ（公開したいとき）
- **Render / Railway / Fly.io**：Node アプリそのまま乗る。環境変数に `LTA_ACCOUNT_KEY` を設定。
- **Vercel / Cloudflare Workers**：`/api/*` をサーバーレス関数に移植すれば静的フロントと一緒に乗る。

## 注意（LTA データの仕様）
- 到着情報は**運行時間中のみ**。終バス後や早朝は空っぽになる。
- ETA は秒単位の予測を分に丸めとる。`到着` 表示は「もうすぐ／到着済み」。
- 混雑度 SEA=空き / SDA=やや混 / LSD=満員、車種 DD=2階建 / BD=連節。
