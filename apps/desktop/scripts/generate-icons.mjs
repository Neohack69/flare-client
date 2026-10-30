// ---------------------------------------------------------------------------
// generate-icons.mjs — генерирует `build/icon.png` (512) и `build/icon.ico`
// из бренд-знака «Контакт» (brand.md §8), без внешних зависимостей/растеризаторов.
//
// Зачем скрипт, а не PNG в репозитории: `build/` в .gitignore, а иконка обязана
// соответствовать знаку и обновляться вместе с геометрией. Запускается перед
// `electron-builder` из `package:win`.
//
// Экспортирует ядро генерации для тестов (`nodes/icons` размеры, `generateIcons`).
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

/** Размеры в `icon.ico` (Windows подбирает под DPI/панель задач). */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** `icon.png` для BrowserWindow/About: ≥512 (крупные иконки, Store). */
export const ICON_PNG_SIZE = 512;
/** Эталонный размер глифа трея (runtime рисует сам, PNG — референс/дизайн). */
export const TRAY_GLYPH_SIZE = 32;

// Цвета — из фирменного знака `apps/web/src/app/icon.svg` (BrandMark, brand.md §8):
// тёплый тёмный фон, светлый контур, акцент `--accent-primary` #5B9FD4.
const BG = { r: 0x22, g: 0x20, b: 0x1b, a: 255 };
const LIGHT = { r: 0xf3, g: 0xee, b: 0xe4, a: 255 };
/** Акцент бренда (`--accent-primary`); экспортируется для проверки в тестах. */
export const BRAND_ACCENT = { r: 0x5b, g: 0x9f, b: 0xd4, a: 255 };
const ACCENT = BRAND_ACCENT;

/* Геометрия знака A в 32-сетке (brand.md §8.1). */
const RUNWAY_Y = 21.5;
const RUNWAY_X0 = 5;
const RUNWAY_X1 = 27;
const RUNWAY_HALF = 1.1;
const CONTACT_X0 = 12.13;
const CONTACT_X1 = 19.87;
const CONTACT_HALF = 1.6;
const TIRE_CX = 16;
const TIRE_CY = 14.5;
const TIRE_R = 8;
const TIRE_HALF = 1.1;
const GAP_FROM = 61.1;
const GAP_TO = 118.9;
const CORNER_RADIUS = 6 / 32;

const SUBSAMPLES = 4;

function onSegment(px, py, x0, x1, y, half) {
  return py >= y - half && py <= y + half && px >= x0 && px <= x1;
}

function inTire(px, py) {
  const dx = px - TIRE_CX;
  const dy = py - TIRE_CY;
  if (Math.abs(Math.hypot(dx, dy) - TIRE_R) > TIRE_HALF) return false;
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  return angle <= GAP_FROM || angle >= GAP_TO;
}

function markColor(px, py) {
  if (onSegment(px, py, CONTACT_X0, CONTACT_X1, RUNWAY_Y, CONTACT_HALF)) return ACCENT;
  if (onSegment(px, py, RUNWAY_X0, RUNWAY_X1, RUNWAY_Y, RUNWAY_HALF)) return LIGHT;
  if (inTire(px, py)) return LIGHT;
  return null;
}

function inRoundedRect(px, py, size) {
  if (px < 0 || py < 0 || px > size || py > size) return false;
  const r = size * CORNER_RADIUS;
  const cx = Math.min(Math.max(px, r), size - r);
  const cy = Math.min(Math.max(py, r), size - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

export function renderRgba(size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = 32 / size;
  const total = SUBSAMPLES * SUBSAMPLES;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUBSAMPLES; sy += 1) {
        for (let sx = 0; sx < SUBSAMPLES; sx += 1) {
          const fx = x + (sx + 0.5) / SUBSAMPLES;
          const fy = y + (sy + 0.5) / SUBSAMPLES;
          let color = inRoundedRect(fx, fy, size) ? BG : null;
          const mark = markColor(fx * scale, fy * scale);
          if (mark) color = mark;
          if (color) {
            r += color.r;
            g += color.g;
            b += color.b;
            a += color.a;
          }
        }
      }
      const offset = (y * size + x) * 4;
      out[offset] = Math.round(r / total);
      out[offset + 1] = Math.round(g / total);
      out[offset + 2] = Math.round(b / total);
      out[offset + 3] = Math.round(a / total);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

export function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

// ---------------------------------------------------------------------------
// T117: референсные ассеты глифа трея для тёмной/светлой панели задач.
// Runtime по-прежнему рисует иконку+status dot из `tray-icons.ts`; PNG-пара
// фиксирует геометрию/цвета и используется для проверки/дизайна.
// ---------------------------------------------------------------------------
const TRAY_DARK_GLYPH = { r: 0x0b, g: 0x12, b: 0x20, a: 255 };
const TRAY_LIGHT_GLYPH = LIGHT;

function inMarkShape(px, py) {
  return (
    onSegment(px, py, RUNWAY_X0, RUNWAY_X1, RUNWAY_Y, RUNWAY_HALF) ||
    onSegment(px, py, CONTACT_X0, CONTACT_X1, RUNWAY_Y, CONTACT_HALF) ||
    inTire(px, py)
  );
}

function renderGlyph(size, color) {
  const out = Buffer.alloc(size * size * 4);
  const scale = 32 / size;
  const total = SUBSAMPLES * SUBSAMPLES;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SUBSAMPLES; sy += 1) {
        for (let sx = 0; sx < SUBSAMPLES; sx += 1) {
          const fx = x + (sx + 0.5) / SUBSAMPLES;
          const fy = y + (sy + 0.5) / SUBSAMPLES;
          if (inMarkShape(fx * scale, fy * scale)) hits += 1;
        }
      }
      if (hits === 0) continue;
      const offset = (y * size + x) * 4;
      out[offset] = color.r;
      out[offset + 1] = color.g;
      out[offset + 2] = color.b;
      out[offset + 3] = Math.round((color.a * hits) / total);
    }
  }
  return out;
}

/**
 * Генерирует `icon.png`/`icon.ico` (окно/таскбар/установщик) и трей-глифы.
 * Возвращает метаданные для логов/тестов.
 */
export function generateIcons({ buildDir, trayDir }) {
  mkdirSync(buildDir, { recursive: true });
  const images = ICO_SIZES.map((size) => ({ size, png: encodePng(size, renderRgba(size)) }));
  writeFileSync(resolve(buildDir, 'icon.png'), encodePng(ICON_PNG_SIZE, renderRgba(ICON_PNG_SIZE)));
  writeFileSync(resolve(buildDir, 'icon.ico'), encodeIco(images));

  mkdirSync(trayDir, { recursive: true });
  writeFileSync(
    resolve(trayDir, 'tray-glyph-dark.png'),
    encodePng(TRAY_GLYPH_SIZE, renderGlyph(TRAY_GLYPH_SIZE, TRAY_LIGHT_GLYPH)),
  );
  writeFileSync(
    resolve(trayDir, 'tray-glyph-light.png'),
    encodePng(TRAY_GLYPH_SIZE, renderGlyph(TRAY_GLYPH_SIZE, TRAY_DARK_GLYPH)),
  );

  return { buildDir, trayDir, icoSizes: [...ICO_SIZES], pngSize: ICON_PNG_SIZE };
}

const isEntryPoint =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const here = dirname(fileURLToPath(import.meta.url));
  const appRoot = resolve(here, '..');
  const result = generateIcons({
    buildDir: resolve(appRoot, 'build'),
    trayDir: resolve(appRoot, 'resources', 'tray'),
  });
  console.log(
    `[icons] brand mark → ${resolve(result.buildDir, 'icon.png')} (${result.pngSize}px) + icon.ico [${result.icoSizes.join('/')}]`,
  );
  console.log(`[icons] tray glyphs → ${result.trayDir} (dark/light)`);
}
