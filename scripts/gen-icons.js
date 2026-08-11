#!/usr/bin/env node
// Generate simple placeholder icons for the Hermes extension.
// Pure Node — writes PNGs directly (no canvas dependency).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function makePng(size) {
  const w = size, h = size;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const off = y * (w * 4 + 1) + 1 + x * 4;
      // purple gradient with a simple "H" monogram
      const t = x / w, b = y / h;
      // background: deep indigo -> purple
      let r = Math.round(24 + 40 * t);
      let g = Math.round(10 + 60 * b);
      let bl = Math.round(90 + 120 * t);
      // draw an 'H'
      const cx = x / size, cy = y / size;
      const barW = 0.18, gap = 0.22;
      const inLeft = Math.abs(cx - 0.30) < barW;
      const inRight = Math.abs(cx - 0.70) < barW;
      const inMid = cy > 0.30 && cy < 0.70 && Math.abs(cx - 0.5) < 0.06;
      if (inLeft || inRight || inMid) { r = 255; g = 255; bl = 255; }
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = bl; raw[off + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, color type RGBA
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const iconsDir = path.join(__dirname, '..', 'extension', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });
[16, 32, 48, 128].forEach((s) => {
  fs.writeFileSync(path.join(iconsDir, `icon${s}.png`), makePng(s));
  console.log('wrote icon' + s + '.png');
});