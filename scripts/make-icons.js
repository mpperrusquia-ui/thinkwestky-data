#!/usr/bin/env node
// Generates the PWA icons (navy tile, hexagon mark from the EDP logo) with no
// dependencies. Run once: node scripts/make-icons.js
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const NAVY = [0x1a, 0x42, 0x8a];
const RED = [0xf5, 0x33, 0x3f];
const WHITE = [0xff, 0xff, 0xff];

// Flat-topped hexagon, centered at 0.5,0.5, radius r (fraction of size).
const inHex = (x, y, r) => {
  const dx = Math.abs(x - 0.5), dy = Math.abs(y - 0.5);
  return dy <= r * Math.sqrt(3) / 2 && Math.sqrt(3) * dx + dy <= Math.sqrt(3) * r;
};

function pixel(x, y, scale) {
  const r = 0.34 * scale;
  if (inHex(x, y, r * 0.52)) return RED;
  if (inHex(x, y, r) && !inHex(x, y, r * 0.74)) return WHITE;
  return NAVY;
}

function png(size, scale) {
  const ss = 4; // supersampling
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = pixel((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, scale);
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
      acc.forEach((v, i) => (row[1 + x * 3 + i] = Math.round(v / (ss * ss))));
    }
    rows.push(row);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../assets/icons/', import.meta.url);
writeFileSync(new URL('icon-192.png', out), png(192, 1));
writeFileSync(new URL('icon-512.png', out), png(512, 1));
writeFileSync(new URL('icon-maskable-512.png', out), png(512, 0.8)); // inside the maskable safe zone
writeFileSync(new URL('apple-touch-icon.png', out), png(180, 1));
console.log('Icons written to assets/icons/');
