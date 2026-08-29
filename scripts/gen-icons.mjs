/**
 * Regenerates the app's icon set from the Jarvis mark.
 *
 * Dependency-free on purpose: the mark is orthogonal geometry, so rasterising it
 * needs a point-in-rectangle test and a PNG writer, and `zlib` in the standard
 * library is the only hard part of the second. Adding a canvas or an SVG rasteriser
 * to devDependencies to draw eight rectangles would be a worse trade.
 *
 *   node scripts/gen-icons.mjs
 *
 * The geometry here is the same 64-unit grid as `src/components/Glyph.tsx`. If the
 * mark changes, change it in both places — they are two renderers of one drawing,
 * and there is no shared module because this file must run in plain node with no
 * TypeScript or bundler in the way.
 */

import { deflateSync } from 'node:zlib';
// Imported rather than taken off the global, so this file lints under the app's
// browser-ish eslint env without an override.
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

/** Warm charcoal, matching `splash.backgroundColor` in app.json. */
const INK = [0x26, 0x26, 0x24];
/** The decorative clay — the fill tone, not the darker text tone. */
const CLAY = [0xd9, 0x77, 0x57];
const WHITE = [0xff, 0xff, 0xff];

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

const GRID = 64;
const C = 32;

/**
 * The mark as eight rectangles on the 64-unit grid.
 *
 * Heavier than the on-screen glyph: an icon is read at 24dp in a launcher grid, and
 * a 4.4-unit stroke disappears there.
 */
function bars(stroke = 5.6, reach = 23, turn = 14) {
  const h = stroke / 2;
  return [
    [C - h, C - reach - h, stroke, reach + stroke],
    [C - h, C - reach - h, turn + stroke, stroke],
    [C - h, C - h, reach + stroke, stroke],
    [C + reach - h, C - h, stroke, turn + stroke],
    [C - h, C - h, stroke, reach + stroke],
    [C - turn - h, C + reach - h, turn + stroke, stroke],
    [C - reach - h, C - h, reach + stroke, stroke],
    [C - reach - h, C - turn - h, stroke, turn + stroke],
  ];
}

const MARK = bars();

/** True when a point on the grid is inside any arm. */
function inMark(x, y) {
  for (const [rx, ry, rw, rh] of MARK) {
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* PNG                                                                        */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crc = crc32(Buffer.concat([Buffer.from(type, 'ascii'), data]));
  out.writeUInt32BE(crc, data.length + 8);
  return out;
}

/** RGBA8 PNG, one IDAT, filter type 0 on every scanline. */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/** Subsamples per axis. 4×4 is enough for orthogonal edges at these sizes. */
const SS = 4;

/**
 * Draw the mark, centred, into a square canvas.
 *
 * `fraction` is how much of the edge the mark's 64-unit box occupies. `bg` may be
 * null for a transparent canvas, which is what the adaptive-icon foreground and the
 * splash image need — the background colour there comes from app.json.
 */
function render({ size, fg, bg, fraction }) {
  const rgba = Buffer.alloc(size * size * 4);
  const box = size * fraction;
  const origin = (size - box) / 2;
  const scale = box / GRID;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const gx = (px + (sx + 0.5) / SS - origin) / scale;
          const gy = (py + (sy + 0.5) / SS - origin) / scale;
          if (inMark(gx, gy)) hits += 1;
        }
      }
      const cover = hits / (SS * SS);
      const i = (py * size + px) * 4;

      if (bg) {
        // Composited against the background here rather than left to the consumer:
        // a launcher that ignores alpha would otherwise show fringed edges.
        for (let ch = 0; ch < 3; ch += 1) rgba[i + ch] = Math.round(bg[ch] + (fg[ch] - bg[ch]) * cover);
        rgba[i + 3] = 255;
      } else {
        for (let ch = 0; ch < 3; ch += 1) rgba[i + ch] = fg[ch];
        rgba[i + 3] = Math.round(cover * 255);
      }
    }
  }
  return encodePng(size, size, rgba);
}

/** A flat square, for the adaptive icon's background layer. */
function flat(size, colour) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = colour[0];
    rgba[i * 4 + 1] = colour[1];
    rgba[i * 4 + 2] = colour[2];
    rgba[i * 4 + 3] = 255;
  }
  return encodePng(size, size, rgba);
}

const targets = [
  { file: 'icon.png', png: () => render({ size: 1024, fg: CLAY, bg: INK, fraction: 0.6 }) },
  // Transparent: the splash background is set in app.json, so one image serves both
  // schemes and no seam appears where the two colours meet.
  { file: 'splash-icon.png', png: () => render({ size: 512, fg: CLAY, bg: null, fraction: 0.7 }) },
  // 432 canvas, 264 safe circle. The mark is kept inside the safe zone with room to
  // spare, because an adaptive icon can be masked to a circle, a squircle or a
  // teardrop and the arms are what get clipped first.
  { file: 'android-icon-foreground.png', png: () => render({ size: 432, fg: CLAY, bg: null, fraction: 0.5 }) },
  { file: 'android-icon-monochrome.png', png: () => render({ size: 432, fg: WHITE, bg: null, fraction: 0.5 }) },
  { file: 'android-icon-background.png', png: () => flat(432, INK) },
  { file: 'favicon.png', png: () => render({ size: 48, fg: CLAY, bg: INK, fraction: 0.68 }) },
];

for (const target of targets) {
  const buf = target.png();
  writeFileSync(join(ASSETS, target.file), buf);
  console.log(`${target.file.padEnd(32)} ${buf.length} bytes`);
}
