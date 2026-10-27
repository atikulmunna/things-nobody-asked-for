// Renders every app icon from the logo artwork without image libraries: the SVG logos and
// web icons in public/, plus launcher icons and splash screens in android/ when it exists.
// Run with: npm run icons
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The logo: yellow dots on black, in a 900 unit square. Traced from the original artwork
// (centers and radii measured from the source image).
const SIZE = 900;
const YELLOW = [0xff, 0xbe, 0x00];
const BLACK = [0x00, 0x00, 0x00];
const DOTS = [
  [252.3, 233.3, 32.2], [252.3, 362.0, 51.5], [252.3, 490.6, 32.2], [252.3, 619.3, 51.5],
  [449.8, 280.9, 32.2], [449.8, 409.6, 32.2], [449.8, 538.3, 51.5], [449.8, 666.9, 32.2],
  [647.4, 233.3, 32.2], [647.4, 362.0, 51.5], [647.4, 490.6, 32.2], [647.4, 619.3, 32.2],
];
const RADIUS = (SIZE * 112) / 512; // corner radius for rounded launcher tiles
const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

function onDot(u, v) {
  for (const [cx, cy, r] of DOTS) if ((u - cx) ** 2 + (v - cy) ** 2 <= r * r) return true;
  return false;
}

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

// The full logo tile (dots on black), clipped to a launcher shape.
function tile(size, shape) {
  return rasterize(size, size, (x, y) => {
    const u = (x / size) * SIZE;
    const v = (y / size) * SIZE;
    if (!inShape(u, v, shape)) return null;
    return onDot(u, v) ? YELLOW : BLACK;
  });
}

// Adaptive icon foreground: 108dp canvas whose visible center is 72dp, so the logo square
// maps onto that center and the dots stay well inside every launcher mask.
function adaptiveForeground(size) {
  const art = (size * 72) / 108;
  const off = (size - art) / 2;
  return rasterize(size, size, (x, y) => (onDot(((x - off) / art) * SIZE, ((y - off) / art) * SIZE) ? YELLOW : null));
}

// Splash: black screen with the logo centered.
function splash(width, height) {
  const side = Math.min(width, height) * 0.55;
  const ox = (width - side) / 2;
  const oy = (height - side) / 2;
  return rasterize(width, height, (x, y) => (onDot(((x - ox) / side) * SIZE, ((y - oy) / side) * SIZE) ? YELLOW : BLACK));
}

function svg({ background }) {
  // The transparent logo is cropped to the dots; the tile keeps the full black square.
  const viewBox = background ? `0 0 ${SIZE} ${SIZE}` : '196 196 508 508';
  const dots = DOTS.map(([cx, cy, r]) => `  <circle cx="${cx}" cy="${cy}" r="${r}"/>`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
${background ? `  <rect width="${SIZE}" height="${SIZE}" fill="${hex(BLACK)}"/>\n` : ''}  <g fill="${hex(YELLOW)}">
${dots.replace(/^/gm, '  ')}
  </g>
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
write('public/icon-192.png', tile(192, 'square'));
write('public/icon-512.png', tile(512, 'square'));
write('public/icon-180.png', tile(180, 'square'));

const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
if (fs.existsSync(RES)) {
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(densities)) {
    const dir = `android/app/src/main/res/mipmap-${d}`;
    write(`${dir}/ic_launcher.png`, tile(Math.round(48 * k), 'rounded'));
    write(`${dir}/ic_launcher_round.png`, tile(Math.round(48 * k), 'circle'));
    write(`${dir}/ic_launcher_foreground.png`, adaptiveForeground(Math.round(108 * k)));
  }
  // Replace each splash image at its existing size.
  for (const dir of fs.readdirSync(RES).filter((n) => n.startsWith('drawable'))) {
    const file = path.join(RES, dir, 'splash.png');
    if (!fs.existsSync(file)) continue;
    const head = fs.readFileSync(file);
    write(`android/app/src/main/res/${dir}/splash.png`, splash(head.readUInt32BE(16), head.readUInt32BE(20)));
  }
}
