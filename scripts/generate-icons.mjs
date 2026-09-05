// Generates the extension icons from the same calendar glyph the sidebar header
// uses (see PoolSidebar.tsx). No image dependencies: shapes are rasterised with
// 4x supersampling and written as PNG via Node's built-in zlib.
//
//   node scripts/generate-icons.mjs
//
// Re-run after changing the glyph; the PNGs in icons/ are committed so a plain
// `npm run build` never needs this script.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor per axis

const BLUE = [66, 133, 244]; // #4285f4, the sidebar's accent

// ── PNG encoding ─────────────────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// rgba: Uint8ClampedArray of size*size*4
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  // 10-12: compression, filter, interlace — all 0

  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let i = 0; i < size * 4; i++) raw[rowStart + 1 + i] = rgba[y * size * 4 + i];
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Glyph ────────────────────────────────────────────────────────────────────

// All coordinates below are in a 24x24 space, matching the sidebar SVG, and are
// scaled to the target size at sample time.

function roundedRectRingHit(x, y, rect) {
  const { x0, y0, x1, y1, r, w } = rect;
  const outside = sdRoundRect(x, y, x0, y0, x1, y1, r);
  return outside <= 0 && outside >= -w;
}

// Signed distance to a rounded rectangle: <=0 inside, >0 outside.
function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r;
  const hy = (y1 - y0) / 2 - r;
  const dx = Math.abs(px - cx) - hx;
  const dy = Math.abs(py - cy) - hy;
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

function inCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) <= r;
}

function inRect(px, py, x0, y0, x1, y1) {
  return px >= x0 && px <= x1 && py >= y0 && py <= y1;
}

// Returns true if the 24x24-space point is part of the glyph.
function glyphHit(x, y, big) {
  const stroke = big ? 1.9 : 2.6; // thicken strokes at small sizes so they survive

  // Calendar body outline
  if (roundedRectRingHit(x, y, { x0: 2.6, y0: 6, x1: 21.4, y1: 21, r: 2.4, w: stroke })) return true;

  // Header rule
  if (inRect(x, y, 2.6, 10 - stroke / 2, 21.4, 10 + stroke / 2)) return true;

  // Two hangers
  const hangerHalf = stroke / 2;
  if (inRect(x, y, 8 - hangerHalf, 2.6, 8 + hangerHalf, 7)) return true;
  if (inRect(x, y, 16 - hangerHalf, 2.6, 16 + hangerHalf, 7)) return true;

  // Three dots — the "pool" of items. Merged into one bar when too small to resolve.
  const dotR = big ? 1.5 : 1.9;
  const dotY = 15.6;
  if (big) {
    if (inCircle(x, y, 7.6, dotY, dotR)) return true;
    if (inCircle(x, y, 12, dotY, dotR)) return true;
    if (inCircle(x, y, 16.4, dotY, dotR)) return true;
  } else if (inRect(x, y, 7, dotY - dotR, 17, dotY + dotR)) {
    return true;
  }

  return false;
}

// ── Rasterise ────────────────────────────────────────────────────────────────

function render(size) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  const big = size >= 32;
  const scale = 24 / size;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          if (glyphHit(x, y, big)) hits++;
        }
      }
      if (!hits) continue;
      const i = (py * size + px) * 4;
      rgba[i] = BLUE[0];
      rgba[i + 1] = BLUE[1];
      rgba[i + 2] = BLUE[2];
      rgba[i + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  return rgba;
}

for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file}`);
}
