# 📱 Androidアプリ(APK)化までの手順

PWA → 公開HTTPSデプロイ(Render) → Bubblewrapで TWA の .apk 生成 → スマホにインストール。

---

## STEP 1. GitHub にコードを上げる

`gh` コマンドが無いので、リポジトリは手で作る。

1. https://github.com/new を開く
2. Repository name: `sg-bus-pwa`、**Public**、READMEなどは付けずに「Create」
3. 出来たらそのURL（例 `https://github.com/＜ユーザー名＞/sg-bus-pwa.git`）をコピー
4. このフォルダで次を実行（push時にブラウザでGitHubログインを求められる）：

```bash
git remote add origin https://github.com/＜ユーザー名＞/sg-bus-pwa.git
git push -u origin main
```

> ⚠️ `.env`（鍵）は `.gitignore` で除外済み。GitHubには鍵は上がらへん。

---

## STEP 2. Render でデプロイ

1. https://render.com にGitHubでサインイン
2. **New → Blueprint** → さっきの `sg-bus-pwa` リポジトリを選ぶ
   （`render.yaml` を自動で読む）
3. デプロイ設定画面で環境変数を入れる：
   - `LTA_ACCOUNT_KEY` = （DataMallの鍵）
4. 「Apply / Create」→ ビルド完了を待つ（数分）
5. 出来たURLを確認（例 `https://sg-bus-pwa.onrender.com`）
   - `https://＜URL＞/api/status` を開いて `{"mock":false,"keyConfigured":true}` ならOK

> Render無料プランは15分アクセスが無いとスリープする。初回アクセスで数十秒待つことがあるが、テストには十分。

---

## STEP 3. Bubblewrap で APK を作る（JDK/SDKは自動DL）

デプロイURLが決まってから実行。

```bash
# CLIインストール（初回だけ）
npm install -g @bubblewrap/cli

# プロジェクト初期化（公開manifestのURLを指定）
bubblewrap init --manifest https://＜RenderのURL＞/manifest.webmanifest
#  → JDK と Android SDK を自動でダウンロードするか聞かれる → Yes
#  → アプリ名・パッケージ名(us.originally.sgbus 等)・署名キー情報を対話で入力

# ビルド
bubblewrap build
#  → app-release-signed.apk が出来る
```

ビルド時に表示される **署名のSHA256フィンガープリント** をメモする。

---

## STEP 4.（任意）URLバーを消す = Digital Asset Links

STEP 3で出たSHA256を `public/.well-known/assetlinks.json` の
`sha256_cert_fingerprints` に貼る → commit → push → Render再デプロイ。
これでアプリ起動時のChromeのURLバーが消えて“ネイティブアプリ”っぽくなる。
（貼らなくてもアプリは動くが、上部にURLバーが出る）

`package_name` は STEP3 で決めたものと一致させること。

---

## STEP 5. スマホにインストール

- **方法A（USB）**: スマホをUSB接続して
  ```bash
  adb install app-release-signed.apk
  ```
- **方法B（手動）**: `app-release-signed.apk` をスマホに転送（メール/Drive等）して開く。
  「提供元不明のアプリ」を許可してインストール。

起動したら、シンガポールのバス到着アプリがネイティブアプリとして立ち上がる🚌

---

## 困ったとき
- `api/status` が `mock:true` → Renderの環境変数 `LTA_ACCOUNT_KEY` 未設定
- 位置情報が動かない → HTTPSでアクセスしているか確認（Renderは標準でHTTPS）
- ピンが出ない → ブラウザのハードリロード、またはアプリ再インストール
