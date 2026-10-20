/**
 * Generates the source app icon (1024x1024 PNG) with no image dependencies.
 * Run with: node scripts/make-icon.mjs
 *
 * The mark: a rounded "desktop layer" tile with a lifted panel and a sparkle,
 * i.e. the app's two ideas (desktop surface + widgets floating on it).
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'src-tauri', 'icons', 'app-icon.png');

const px = new Uint8Array(SIZE * SIZE * 4);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Signed distance to a rounded rectangle centred on the canvas. */
function sdRoundRect(x, y, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(x - cx) - (halfW - r);
  const qy = Math.abs(y - cy) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Antialiased coverage from a signed distance (positive = outside). */
const cover = (d) => clamp01(0.5 - d);

const C = {
  deepA: [24, 26, 54],
  deepB: [58, 40, 116],
  tileA: [99, 102, 241],
  tileB: [56, 189, 248],
  panel: [255, 255, 255],
  sparkle: [250, 204, 21],
};

// Background: a soft diagonal gradient, full bleed (the OS masks corners).
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const t = clamp01((x / SIZE) * 0.45 + (y / SIZE) * 0.75);
    const [r, g, b] = mix(C.deepA, C.deepB, t);
    const i = (y * SIZE + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
}

// The main tile.
const TILE = { cx: 512, cy: 512, hw: 336, hh: 336, r: 104 };
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const a = cover(sdRoundRect(x, y, TILE.cx, TILE.cy, TILE.hw, TILE.hh, TILE.r));
    if (a <= 0) continue;
    const t = clamp01(((x - TILE.cx + TILE.hw) / (TILE.hw * 2)) * 0.6 + ((y - TILE.cy + TILE.hh) / (TILE.hh * 2)) * 0.4);
    const [r, g, b] = mix(C.tileA, C.tileB, t);
    const i = (y * SIZE + x) * 4;
    px[i] = Math.round(px[i] * (1 - a) + r * a);
    px[i + 1] = Math.round(px[i + 1] * (1 - a) + g * a);
    px[i + 2] = Math.round(px[i + 2] * (1 - a) + b * a);
  }
}

// A "widget panel" lifted off the tile, plus two launcher dots beneath it.
function shape(draw) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const a = cover(draw(x, y));
      if (a <= 0) continue;
      const i = (y * SIZE + x) * 4;
      px[i] = Math.round(px[i] * (1 - a) + C.panel[0] * a);
      px[i + 1] = Math.round(px[i + 1] * (1 - a) + C.panel[1] * a);
      px[i + 2] = Math.round(px[i + 2] * (1 - a) + C.panel[2] * a);
    }
  }
}

shape((x, y) => sdRoundRect(x, y, 512, 452, 196, 108, 34)); // panel

for (const cx of [392, 512, 632]) {
  shape((x, y) => {
    const d = Math.hypot(x - cx, y - 636) - 46;
    return d;
  });
}

// Sparkle in the top-right of the tile: a four-point star built from the
// intersection of two thin diamonds.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = x - 690;
    const dy = y - 320;
    const star = Math.min(Math.abs(dx) + Math.abs(dy) * 0.34, Math.abs(dy) + Math.abs(dx) * 0.34) - 22;
    const a = cover(star);
    if (a <= 0) continue;
    const i = (y * SIZE + x) * 4;
    px[i] = Math.round(px[i] * (1 - a) + C.sparkle[0] * a);
    px[i + 1] = Math.round(px[i + 1] * (1 - a) + C.sparkle[1] * a);
    px[i + 2] = Math.round(px[i + 2] * (1 - a) + C.sparkle[2] * a);
  }
}

// ---------------------------------------------------------------- PNG encode
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
// 10..12 stay zero: deflate / adaptive filtering / no interlace

// One filter byte (0 = None) per scanline.
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${(png.length / 1024).toFixed(1)} KB)`);
