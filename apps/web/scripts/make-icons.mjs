// Writes the PWA icons into ../public. Run: node apps/web/scripts/make-icons.mjs
// A flat #17202b square with a light terminal-prompt mark (">_"), no dependencies beyond node:zlib.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../public/", import.meta.url));
mkdirSync(out, { recursive: true });

const BG = [0x17, 0x20, 0x2b];
const FG = [0xe8, 0xee, 0xf4];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Mark in unit coordinates, centred on (0.5, 0.5). `scale` shrinks it (the maskable icon needs a safe zone).
const SEGMENTS = [
  [0.3, 0.34, 0.5, 0.5],
  [0.5, 0.5, 0.3, 0.66],
  [0.54, 0.66, 0.72, 0.66],
];
const HALF_STROKE = 0.04;

function icon(size, scale) {
  const ss = 3;
  return png(size, (x, y) => {
    let hits = 0;
    for (let sy = 0; sy < ss; sy++) {
      for (let sx = 0; sx < ss; sx++) {
        const u = (x + (sx + 0.5) / ss) / size;
        const v = (y + (sy + 0.5) / ss) / size;
        const px = (u - 0.5) / scale + 0.5;
        const py = (v - 0.5) / scale + 0.5;
        if (SEGMENTS.some(([ax, ay, bx, by]) => distToSegment(px, py, ax, ay, bx, by) <= HALF_STROKE)) hits++;
      }
    }
    const a = hits / (ss * ss);
    return BG.map((c, i) => Math.round(c + (FG[i] - c) * a));
  });
}

writeFileSync(out + "icon-192.png", icon(192, 1));
writeFileSync(out + "icon-512.png", icon(512, 1));
writeFileSync(out + "icon-512-maskable.png", icon(512, 0.72));
writeFileSync(out + "apple-touch-icon.png", icon(180, 1));
console.log("icons written to", out);
