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

// ペイロード無しプッシュを1件送る。戻り値はHTTPステータス。
// 404/410 は購読が無効（削除対象）。
export async function sendPushEmpty(subscription, env) {
  const endpoint = subscription.endpoint;
  const aud = new URL(endpoint).origin;
  const jwt = await signVapidJwt(aud, env.VAPID_SUBJECT, env.VAPID_PRIVATE_KEY);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      TTL: '60',
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      'Content-Length': '0',
    },
  });
  return res.status;
}
