// Renders every app icon from the logo geometry without image libraries: the SVG logos in
// public/, plus launcher icons and splash screens in android/ when it exists.
// Run with: npm run icons
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The logo: an orange cloud with a small bar chart cut out of it, in a 900 unit square.
const SIZE = 900;
const ORANGE = [0xff, 0x99, 0x00];
const BLACK = [0x00, 0x00, 0x00];
const PUFFS = [[295, 515, 110], [445, 435, 160], [605, 515, 110]];
const BASE = { x0: 295, x1: 605, y0: 515, y1: 625 };
const BAR_R = 24;
const BAR_BOTTOM = 568;
const BARS = [[372, 478], [450, 404], [528, 448]]; // [center x, top y]
const RADIUS = (SIZE * 112) / 512; // corner radius for rounded launcher tiles
const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

function inCloud(u, v) {
  if (u >= BASE.x0 && u <= BASE.x1 && v >= BASE.y0 && v <= BASE.y1) return true;
  return PUFFS.some(([cx, cy, r]) => (u - cx) ** 2 + (v - cy) ** 2 <= r * r);
}

function inBar(u, v) {
  return BARS.some(([cx, top]) => {
    const y = Math.min(Math.max(v, top + BAR_R), BAR_BOTTOM - BAR_R);
    return Math.hypot(u - cx, v - y) <= BAR_R;
  });
}

const onLogo = (u, v) => inCloud(u, v) && !inBar(u, v);

function inShape(u, v, shape) {
  if (u < 0 || v < 0 || u > SIZE || v > SIZE) return false;
  if (shape === 'square') return true;
  if (shape === 'circle') return Math.hypot(u - SIZE / 2, v - SIZE / 2) <= SIZE / 2;
  const cx = Math.min(Math.max(u, RADIUS), SIZE - RADIUS);
  const cy = Math.min(Math.max(v, RADIUS), SIZE - RADIUS);
  return Math.hypot(u - cx, v - cy) <= RADIUS;
}

// Supersampled rasterizer. color(x, y) returns [r, g, b] or null for transparent.
function rasterize(width, height, color) {
  const ss = 4;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = color(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      raw[o++] = a ? Math.round(r / a) : 0;
      raw[o++] = a ? Math.round(g / a) : 0;
      raw[o++] = a ? Math.round(b / a) : 0;
      raw[o++] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return png(width, height, raw);
}

// The full logo tile (orange cloud on black), clipped to a launcher shape.
function tile(size, shape) {
  return rasterize(size, size, (x, y) => {
    const u = (x / size) * SIZE;
    const v = (y / size) * SIZE;
    if (!inShape(u, v, shape)) return null;
    return onLogo(u, v) ? ORANGE : BLACK;
  });
}

// Adaptive icon foreground: 108dp canvas whose visible center is 72dp.
function adaptiveForeground(size) {
  const art = (size * 72) / 108;
  const off = (size - art) / 2;
  return rasterize(size, size, (x, y) => (onLogo(((x - off) / art) * SIZE, ((y - off) / art) * SIZE) ? ORANGE : null));
}

// Splash: black screen with the logo centered.
function splash(width, height) {
  const side = Math.min(width, height) * 0.6;
  const ox = (width - side) / 2;
  const oy = (height - side) / 2;
  return rasterize(width, height, (x, y) => (onLogo(((x - ox) / side) * SIZE, ((y - oy) / side) * SIZE) ? ORANGE : BLACK));
}

function svg({ background }) {
  const viewBox = background ? `0 0 ${SIZE} ${SIZE}` : '175 265 550 370';
  const puffs = PUFFS.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join('');
  const bars = BARS.map(([cx, top]) => `<rect x="${cx - BAR_R}" y="${top}" width="${BAR_R * 2}" height="${BAR_BOTTOM - top}" rx="${BAR_R}" fill="#000"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
  <defs><mask id="m"><rect x="0" y="0" width="${SIZE}" height="${SIZE}" fill="#fff"/>${bars}</mask></defs>
${background ? `  <rect width="${SIZE}" height="${SIZE}" fill="${hex(BLACK)}"/>\n` : ''}  <g fill="${hex(ORANGE)}" mask="url(#m)">${puffs}<rect x="${BASE.x0}" y="${BASE.y0}" width="${BASE.x1 - BASE.x0}" height="${BASE.y1 - BASE.y0}"/></g>
</svg>
`;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
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

function png(width, height, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function write(rel, data) {
  fs.writeFileSync(path.join(ROOT, rel), data);
  console.log(`wrote ${rel}`);
}

write('public/logo.svg', svg({ background: false }));
write('public/icon.svg', svg({ background: true }));
write('public/icon-512.png', tile(512, 'square'));

const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
if (fs.existsSync(RES)) {
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(densities)) {
    const dir = `android/app/src/main/res/mipmap-${d}`;
    write(`${dir}/ic_launcher.png`, tile(Math.round(48 * k), 'rounded'));
    write(`${dir}/ic_launcher_round.png`, tile(Math.round(48 * k), 'circle'));
    write(`${dir}/ic_launcher_foreground.png`, adaptiveForeground(Math.round(108 * k)));
  }
  write('android/app/src/main/res/values/ic_launcher_background.xml',
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#000000</color>\n</resources>\n');
  // Replace each splash image at its existing size.
  for (const dir of fs.readdirSync(RES).filter((n) => n.startsWith('drawable'))) {
    const file = path.join(RES, dir, 'splash.png');
    if (!fs.existsSync(file)) continue;
    const head = fs.readFileSync(file);
    write(`android/app/src/main/res/${dir}/splash.png`, splash(head.readUInt32BE(16), head.readUInt32BE(20)));
  }
}
