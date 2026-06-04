// 依存ライブラリ無しで PNG アイコンを生成する（Node標準のzlibだけ使用）。
// 緑背景＋白いバス。マスカブル対応のため背景は全面塗り。
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// ── CRC32 ──
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit, RGBA
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, y * w * 4 + w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── 絵を描く ──
function makeIcon(N) {
  const buf = Buffer.alloc(N * N * 4);
  const set = (x, y, c) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    const i = (y * N + x) * 4;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3] ?? 255;
  };
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++) set(x, y, c);
  };
  const circle = (cx, cy, r, c) => {
    for (let y = Math.round(cy - r); y <= cy + r; y++)
      for (let x = Math.round(cx - r); x <= cx + r; x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(x, y, c);
  };
  const roundRect = (x0, y0, x1, y1, rad, c) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++) {
        let inside = true;
        const cxs = [[x0 + rad, y0 + rad], [x1 - rad, y0 + rad], [x0 + rad, y1 - rad], [x1 - rad, y1 - rad]];
        if (x < x0 + rad && y < y0 + rad) inside = (x - cxs[0][0]) ** 2 + (y - cxs[0][1]) ** 2 <= rad * rad;
        else if (x >= x1 - rad && y < y0 + rad) inside = (x - cxs[1][0]) ** 2 + (y - cxs[1][1]) ** 2 <= rad * rad;
        else if (x < x0 + rad && y >= y1 - rad) inside = (x - cxs[2][0]) ** 2 + (y - cxs[2][1]) ** 2 <= rad * rad;
        else if (x >= x1 - rad && y >= y1 - rad) inside = (x - cxs[3][0]) ** 2 + (y - cxs[3][1]) ** 2 <= rad * rad;
        if (inside) set(x, y, c);
      }
  };

  const green = [11, 107, 58, 255];
  const white = [255, 255, 255, 255];
  const u = N / 100;

  rect(0, 0, N, N, green);                       // 背景（全面：マスカブル対応）
  roundRect(24 * u, 27 * u, 76 * u, 67 * u, 7 * u, white);  // 車体
  roundRect(28 * u, 32 * u, 72 * u, 45 * u, 3 * u, green);  // 窓
  rect(48.5 * u, 32 * u, 51.5 * u, 45 * u, white);          // 窓の仕切り
  rect(28 * u, 58 * u, 72 * u, 61 * u, green);              // ライン
  circle(35 * u, 70 * u, 6.5 * u, white);                   // 車輪
  circle(65 * u, 70 * u, 6.5 * u, white);
  circle(35 * u, 70 * u, 3 * u, green);
  circle(65 * u, 70 * u, 3 * u, green);
  return encodePNG(buf, N, N);
}

for (const N of [192, 512]) {
  const out = path.join(outDir, `icon-${N}.png`);
  fs.writeFileSync(out, makeIcon(N));
  console.log(`✅ ${out}`);
}
