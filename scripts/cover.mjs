// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark warm gradient, a round
// speaker seen from the front (brushed aluminium ring, dark fabric, a small
// bronze center) on a thin stand, and sound arcs on both sides. Plain Node
// (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [18, 16, 15];
const WARM = [58, 50, 44];
const ALU = [214, 214, 210];
const ALU_DARK = [150, 150, 148];
const FABRIC = [38, 38, 42];
const BRONZE = [176, 130, 82];

const CX = 400;
const CY = 245;
const R = 175;

/** The colour of one pixel. */
function pixel(x, y) {
  let color = mix(DARK, WARM, 1 - Math.hypot((x - CX) / 600, (y - CY) / 420));
  // The stand: a thin pole and a flat oval foot, and its shadow.
  const shadow = Math.hypot((x - CX) / 150, (y - 492) / 12);
  color = mix(color, [0, 0, 0], (1 - shadow) * 0.6);
  if (y > CY && y < 480) {
    color = mix(color, ALU_DARK, smooth(0, Math.abs(x - CX) - 5));
  }
  const foot = (Math.hypot((x - CX) / 90, (y - 484) / 9) - 1) * 9;
  color = mix(color, ALU_DARK, smooth(0, foot));
  // The disc: brushed aluminium ring (radial shading), dark fabric inside.
  const dx = x - CX;
  const dy = y - CY;
  const d = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  const brushed = mix(ALU, ALU_DARK, 0.35 + 0.35 * Math.cos(angle * 2 + 0.6) + 0.05 * Math.sin(d));
  color = mix(color, brushed, smooth(0, d - R));
  color = mix(color, mix(FABRIC, [24, 24, 28], dy / R / 2 + 0.5), smooth(0, d - (R - 22)));
  // A fine ring on the fabric and the bronze center.
  color = mix(color, [60, 60, 66], smooth(1.2, Math.abs(d - (R - 70))));
  color = mix(color, BRONZE, smooth(0, d - 16));
  // Sound arcs on both sides.
  const side = Math.abs(Math.atan2(dy, Math.abs(dx)));
  if (side < 0.5 && d > R + 30) {
    for (const r of [R + 55, R + 95, R + 135]) {
      color = mix(color, BRONZE, smooth(3, Math.abs(d - r)) * (1 - side / 0.5) * 0.85);
    }
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
