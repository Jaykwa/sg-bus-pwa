// VAPID鍵ペア(P-256)を生成する。
//  - 公開鍵: base64url(65バイト非圧縮点) → フロント & wrangler.toml の VAPID_PUBLIC_KEY
//  - 秘密鍵: base64url(PKCS8 DER) → .vapid-private に書き出し、wrangler secret に登録
// 実行: node scripts/gen-vapid.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const pubJwk = publicKey.export({ format: 'jwk' });
const x = Buffer.from(pubJwk.x, 'base64url');
const y = Buffer.from(pubJwk.y, 'base64url');
const pub = Buffer.concat([Buffer.from([4]), x, y]).toString('base64url'); // 0x04||X||Y

const priv = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).toString('base64url');

fs.writeFileSync('.vapid-private', priv); // gitignore済み。wrangler secret に流し込む用
console.log('VAPID_PUBLIC_KEY=' + pub);
console.log('(秘密鍵は .vapid-private に書き出した。チャットには出さへん)');
