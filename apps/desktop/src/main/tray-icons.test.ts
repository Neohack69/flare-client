import { describe, expect, it } from 'vitest';

import { agentStatusMap } from '@flightlog/contracts';

import {
  parseHexColor,
  renderTrayBitmap,
  selectTrayVariant,
  TRAY_STATE_COLORS,
  trayGlyphColor,
  type TrayState,
} from './tray-icons';

function hasColor(buffer: Buffer, r: number, g: number, b: number): boolean {
  for (let offset = 0; offset < buffer.length; offset += 4) {
    if (buffer[offset] === b && buffer[offset + 1] === g && buffer[offset + 2] === r) {
      return true;
    }
  }
  return false;
}

function pixelAt(bitmap: { buffer: Buffer }, size: number, x: number, y: number): number[] {
  const offset = (y * size + x) * 4;
  return [
    bitmap.buffer[offset + 2] ?? 0,
    bitmap.buffer[offset + 1] ?? 0,
    bitmap.buffer[offset] ?? 0,
  ];
}

const LIGHT_GLYPH = [232, 237, 247];
const DARK_GLYPH = [11, 18, 32];

const ALL_STATES = Object.keys(TRAY_STATE_COLORS) as TrayState[];

describe('tray-icons (T105 §2)', () => {
  it('рендерит BGRA-растор заданного размера', () => {
    const bitmap = renderTrayBitmap('recording', 16);
    expect(bitmap.width).toBe(16);
    expect(bitmap.height).toBe(16);
    expect(bitmap.buffer).toHaveLength(16 * 16 * 4);
  });

  it('содержит цветную точку-статус своего состояния', () => {
    const state = 'recording';
    const { r, g, b } = parseHexColor(TRAY_STATE_COLORS[state]);
    const bitmap = renderTrayBitmap(state, 32);
    expect(hasColor(bitmap.buffer, r, g, b)).toBe(true);
  });

  it('разные состояния дают разные цвета точки', () => {
    const recording = parseHexColor(TRAY_STATE_COLORS.recording);
    const idle = parseHexColor(TRAY_STATE_COLORS.connected_idle);
    const recordingBitmap = renderTrayBitmap('recording', 16);
    const idleBitmap = renderTrayBitmap('connected_idle', 16);
    expect(hasColor(recordingBitmap.buffer, idle.r, idle.g, idle.b)).toBe(false);
    expect(hasColor(idleBitmap.buffer, recording.r, recording.g, recording.b)).toBe(false);
  });

  it('фон прозрачный, силуэт непрозрачный', () => {
    const bitmap = renderTrayBitmap('connected_idle', 16);
    expect(bitmap.buffer[3]).toBe(0);
    expect(hasColor(bitmap.buffer, 232, 237, 247)).toBe(true);
  });

  it('отклоняет невалидный hex', () => {
    expect(() => parseHexColor('nope')).toThrow();
  });

  it('рисует бренд-знак: линия ВПП и шина в монохроме (brand.md §9)', () => {
    const size = 16;
    const bitmap = renderTrayBitmap('connected_idle', size);
    // Левая часть ВПП (y=11 в 16-сетке, вне status dot) — светлый пиксель знака.
    expect(pixelAt(bitmap, size, 3, 11)).toEqual(LIGHT_GLYPH);
    // Верх кольца шины (около y=4.4) — тоже светлый.
    expect(pixelAt(bitmap, size, 8, 4)).toEqual(LIGHT_GLYPH);
  });
});

describe('T117 — инверсная иконка под тему ОС', () => {
  it('selectTrayVariant: dark-тема → dark-вариант, light-тема → light-вариант', () => {
    expect(selectTrayVariant(true)).toBe('dark');
    expect(selectTrayVariant(false)).toBe('light');
  });

  it('trayGlyphColor: тёмная панель — светлый знак, светлая — тёмный', () => {
    expect(trayGlyphColor('dark')).toEqual({ r: 232, g: 237, b: 247 });
    expect(trayGlyphColor('light')).toEqual({ r: 11, g: 18, b: 32 });
  });

  it('dark-вариант рисует светлый глиф, light-вариант — инверсный тёмный', () => {
    const size = 16;
    const dark = renderTrayBitmap('connected_idle', size, 'dark');
    const light = renderTrayBitmap('connected_idle', size, 'light');
    expect(pixelAt(dark, size, 3, 11)).toEqual(LIGHT_GLYPH);
    expect(pixelAt(light, size, 3, 11)).toEqual(DARK_GLYPH);
  });

  it('status dot не зависит от варианта (единственный цветовой сигнал)', () => {
    const { r, g, b } = parseHexColor(TRAY_STATE_COLORS.recording);
    const dark = renderTrayBitmap('recording', 32, 'dark');
    const light = renderTrayBitmap('recording', 32, 'light');
    expect(hasColor(dark.buffer, r, g, b)).toBe(true);
    expect(hasColor(light.buffer, r, g, b)).toBe(true);
  });
});

describe('T117 — маппинг статус-дот ← agentStatusMap', () => {
  it.each(ALL_STATES)('%s: цвет точки совпадает с trayGlyph', (state) => {
    expect(TRAY_STATE_COLORS[state]).toBe(agentStatusMap[state].trayGlyph);
    const { r, g, b } = parseHexColor(TRAY_STATE_COLORS[state]);
    for (const variant of ['dark', 'light'] as const) {
      expect(hasColor(renderTrayBitmap(state, 32, variant).buffer, r, g, b)).toBe(true);
    }
  });

  it('все состояния имеют точку своего цвета', () => {
    for (const state of ALL_STATES) {
      const { r, g, b } = parseHexColor(TRAY_STATE_COLORS[state]);
      expect(hasColor(renderTrayBitmap(state, 32).buffer, r, g, b)).toBe(true);
    }
  });
});
