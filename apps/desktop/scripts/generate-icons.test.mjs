import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BRAND_ACCENT,
  ICON_PNG_SIZE,
  ICO_SIZES,
  generateIcons,
  renderRgba,
} from './generate-icons.mjs';

function hasPixel(rgba, color) {
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (
      rgba[offset] === color.r &&
      rgba[offset + 1] === color.g &&
      rgba[offset + 2] === color.b &&
      rgba[offset + 3] === 255
    ) {
      return true;
    }
  }
  return false;
}

function parseIcoSizes(buffer) {
  expect(buffer.readUInt16LE(0)).toBe(0);
  expect(buffer.readUInt16LE(2)).toBe(1); // type: icon
  const count = buffer.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    sizes.push(buffer[6 + i * 16] || 256);
  }
  return sizes;
}

function readPngSize(buffer) {
  expect(buffer.readUInt32BE(0).toString(16)).toBe('89504e47');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const tempDirs = [];

function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), 'flightlog-icons-'));
  tempDirs.push(root);
  return { buildDir: join(root, 'build'), trayDir: join(root, 'tray') };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('generate-icons', () => {
  it('пишет multi-size .ico (16/24/32/48/64/128/256)', () => {
    const { buildDir, trayDir } = makeDirs();
    generateIcons({ buildDir, trayDir });
    const ico = readFileSync(join(buildDir, 'icon.ico'));
    expect(parseIcoSizes(ico)).toEqual(ICO_SIZES);
    expect(ICO_SIZES).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });

  it('пишет icon.png не меньше 512px (окно/таскбар)', () => {
    const { buildDir, trayDir } = makeDirs();
    generateIcons({ buildDir, trayDir });
    const png = readFileSync(join(buildDir, 'icon.png'));
    const { width, height } = readPngSize(png);
    expect(width).toBe(ICON_PNG_SIZE);
    expect(height).toBe(ICON_PNG_SIZE);
    expect(width).toBeGreaterThanOrEqual(512);
    expect(png.length).toBeGreaterThan(1_000);
  });

  it('DESKTOP-UX-POLISH: акцент знака — фирменный #5B9FD4', () => {
    expect(BRAND_ACCENT).toEqual({ r: 0x5b, g: 0x9f, b: 0xd4, a: 255 });
    expect(hasPixel(renderRgba(64), BRAND_ACCENT)).toBe(true);
  });

  it('трей-глифы dark/light непустые и различаются', () => {
    const { buildDir, trayDir } = makeDirs();
    generateIcons({ buildDir, trayDir });
    const dark = readFileSync(join(trayDir, 'tray-glyph-dark.png'));
    const light = readFileSync(join(trayDir, 'tray-glyph-light.png'));
    expect(dark.length).toBeGreaterThan(50);
    expect(light.length).toBeGreaterThan(50);
    expect(dark.equals(light)).toBe(false);
  });
});
