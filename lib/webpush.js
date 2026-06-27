// ───────────────────────────────────────────────────────────
//  Web Push（VAPID）送信ヘルパ — Cloudflare Workers / Web Crypto
//  フェーズ1：ペイロード無しの「合図プッシュ」を送る。
//   端末の Service Worker が push を受けて通知を出す。
//   （本文付き通知=ペイロード暗号化はフェーズ2で対応）
// ───────────────────────────────────────────────────────────

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// VAPID秘密鍵(PKCS8 base64url)を ECDSA P-256 の署名鍵として読み込む
async function importVapidKey(privB64) {
  return crypto.subtle.importKey(
    'pkcs8',
    b64urlToBytes(privB64),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

// VAPID JWT（ES256）を作る。aud は push エンドポイントのオリジン。
async function signVapidJwt(aud, subject, privB64) {
  const header = { alg: 'ES256', typ: 'JWT' };
  const payload = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject };
  const enc = (o) => bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const key = await importVapidKey(privB64);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput)
  );
  // Web Crypto の ECDSA 署名は r||s（JOSE形式）なのでそのまま使える
  return `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
}

// ── ペイロード暗号化（RFC 8291 aes128gcm）──
function concatBytes(...arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8
  );
  return new Uint8Array(bits);
}

// 購読の公開鍵で本文を暗号化して aes128gcm ボディを作る
async function encryptPayload(subscription, plaintext) {
  const uaPublic = b64urlToBytes(subscription.keys.p256dh); // 受信者公開鍵(65)
  const authSecret = b64urlToBytes(subscription.keys.auth); // 認証シークレット(16)

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey)); // 65

  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  // IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\0"||ua||as, 32)
  const ikm = await hkdf(
    authSecret, ecdh,
    concatBytes(new TextEncoder().encode('WebPush: info\0'), uaPublic, asPublic),
    32
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const padded = concatBytes(plaintext, new Uint8Array([2])); // 最終レコードの区切り 0x02
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded));

  // ヘッダ: salt(16)||rs(4=4096)||idlen(1)||keyid(asPublic 65)||ciphertext
  return concatBytes(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPublic.length]), asPublic, ct);
}

// 本文付きプッシュを1件送る。戻り値はHTTPステータス（404/410=購読無効）。
export async function sendPush(subscription, payloadObj, env) {
  const endpoint = subscription.endpoint;
  const aud = new URL(endpoint).origin;
  const jwt = await signVapidJwt(aud, env.VAPID_SUBJECT, env.VAPID_PRIVATE_KEY);
  const body = await encryptPayload(subscription, new TextEncoder().encode(JSON.stringify(payloadObj)));
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      TTL: '120',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body,
  });
  return res.status;
}
