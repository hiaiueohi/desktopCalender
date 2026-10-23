// 依存なしでアプリアイコン (256x256 PNG) を生成する: カレンダー + チェックマーク
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 256;
const px = new Uint8Array(N * N * 4);

function blend(x, y, [r, g, b], a) {
  if (x < 0 || y < 0 || x >= N || y >= N || a <= 0) return;
  const i = (y * N + x) * 4;
  const da = px[i + 3] / 255;
  const oa = a + da * (1 - a);
  const mix = (s, d) => Math.round((s * a + d * da * (1 - a)) / (oa || 1));
  px[i] = mix(r, px[i]);
  px[i + 1] = mix(g, px[i + 1]);
  px[i + 2] = mix(b, px[i + 2]);
  px[i + 3] = Math.round(oa * 255);
}

// 角丸矩形 (4x4 スーパーサンプリングでアンチエイリアス)
function roundRect(x0, y0, x1, y1, r, color) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      let hit = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const fx = x + (sx + 0.5) / 4;
          const fy = y + (sy + 0.5) / 4;
          if (fx < x0 || fx > x1 || fy < y0 || fy > y1) continue;
          const cx = Math.min(Math.max(fx, x0 + r), x1 - r);
          const cy = Math.min(Math.max(fy, y0 + r), y1 - r);
          if ((fx - cx) ** 2 + (fy - cy) ** 2 <= r * r) hit++;
        }
      }
      blend(x, y, color, hit / 16);
    }
  }
}

// 太線 (端は丸)
function line(xa, ya, xb, yb, w, color) {
  const minX = Math.floor(Math.min(xa, xb) - w);
  const maxX = Math.ceil(Math.max(xa, xb) + w);
  const minY = Math.floor(Math.min(ya, yb) - w);
  const maxY = Math.ceil(Math.max(ya, yb) + w);
  const dx = xb - xa;
  const dy = yb - ya;
  const len2 = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let hit = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const fx = x + (sx + 0.5) / 4;
          const fy = y + (sy + 0.5) / 4;
          const t = Math.max(0, Math.min(1, ((fx - xa) * dx + (fy - ya) * dy) / len2));
          const d2 = (fx - xa - t * dx) ** 2 + (fy - ya - t * dy) ** 2;
          if (d2 <= (w / 2) ** 2) hit++;
        }
      }
      blend(x, y, color, hit / 16);
    }
  }
}

const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];
const GREEN = [22, 163, 74];
const GRAY = [203, 213, 225];

roundRect(16, 28, 240, 240, 36, BLUE);
roundRect(32, 84, 224, 224, 18, WHITE);
roundRect(68, 12, 88, 56, 10, [30, 64, 175]);
roundRect(168, 12, 188, 56, 10, [30, 64, 175]);
for (const [x, y] of [[52, 104], [96, 104], [140, 104], [184, 104], [52, 144], [52, 184]]) {
  roundRect(x, y, x + 24, y + 22, 5, GRAY);
}
line(100, 168, 132, 200, 22, GREEN);
line(132, 200, 196, 128, 22, GREEN);

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * N * 4, N * 4).copy(raw, y * (N * 4 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote', out);
