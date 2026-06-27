// ───────────────────────────────────────────────────────────
//  Google ID トークン検証
//  フロントが送ってくる Google の ID トークン(JWT)を検証して、
//  ユーザーの sub（Googleの不変ID）と email を取り出す。
//  小規模アプリ向けに Google の tokeninfo エンドポイントで検証する
//  （署名検証は Google 側がやってくれる）。同じトークンの再検証は
//  メモリにキャッシュして Google への問い合わせを間引く。
// ───────────────────────────────────────────────────────────

const tokenCache = new Map(); // idToken → { user, exp(ms) }

export async function verifyGoogleToken(idToken, clientId) {
  if (!idToken || !clientId) return null;

  // キャッシュヒット（有効期限内）ならGoogleに問い合わせへん
  const cached = tokenCache.get(idToken);
  if (cached && cached.exp > Date.now()) return cached.user;

  let p;
  try {
    const res = await fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken)
    );
    if (!res.ok) return null;
    p = await res.json();
  } catch {
    return null;
  }

  // このアプリ向けのトークンか（aud）、発行者（iss）、期限（exp）を確認
  const issOk = p.iss === 'accounts.google.com' || p.iss === 'https://accounts.google.com';
  const expMs = Number(p.exp) * 1000;
  if (p.aud !== clientId || !issOk || !(expMs > Date.now())) return null;

  const user = { sub: p.sub, email: p.email || '', name: p.name || '' };
  tokenCache.set(idToken, { user, exp: expMs });
  if (tokenCache.size > 500) tokenCache.clear(); // 素朴な上限（メモリ肥大防止）
  return user;
}
