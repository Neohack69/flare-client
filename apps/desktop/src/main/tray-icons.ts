/**
 * Генерация иконки трея без внешних ассетов (T105 §2, brand.md §9): бренд-знак
 * «Контакт» в монохроме + цветная точка-статус. Пятно контакта в трее — тоже
 * `currentColor`: единственный цветовой сигнал остаётся у status dot.
 * Рендерим сырой BGRA-растор на каждый размер, а `tray.ts` оборачивает его в
 * `nativeImage` (16px + @2x). Так точка-статус всегда совпадает с состоянием
 * агента и не требует набора PNG в дистрибутиве.
 *
 * T117: два варианта глифа под тему ОС. `dark` — тёмная панель задач (светлый
 * знак, текущее поведение), `light` — светлая панель (инверсный тёмный знак).
 * Выбор — по `nativeTheme.shouldUseDarkColors` в main (`selectTrayVariant`).
 */

import { agentStatusMap, type TrayStatusKind } from '@flightlog/contracts';

export type TrayState = TrayStatusKind;

/** Вариант глифа: по теме ОС (`dark` = тёмная тема/панель). */
export type TrayIconVariant = 'dark' | 'light';

export const DEFAULT_TRAY_ICON_VARIANT: TrayIconVariant = 'dark';

/** `nativeTheme.shouldUseDarkColors` → вариант иконки. */
export function selectTrayVariant(shouldUseDarkColors: boolean): TrayIconVariant {
  return shouldUseDarkColors ? 'dark' : 'light';
}

/**
 * Цвета точки-статуса — производные от единого `agentStatusMap`
 * (desktop-client.md §3): палитра трея и сайта не может разойтись.
 */
export const TRAY_STATE_COLORS: Record<TrayState, string> = {
  not_started: agentStatusMap.not_started.trayGlyph,
  auth_required: agentStatusMap.auth_required.trayGlyph,
  sim_waiting: agentStatusMap.sim_waiting.trayGlyph,
  connected_idle: agentStatusMap.connected_idle.trayGlyph,
  recording: agentStatusMap.recording.trayGlyph,
  touchdown: agentStatusMap.touchdown.trayGlyph,
  syncing: agentStatusMap.syncing.trayGlyph,
  sync_ok: agentStatusMap.sync_ok.trayGlyph,
  sync_error: agentStatusMap.sync_error.trayGlyph,
  agent_error: agentStatusMap.agent_error.trayGlyph,
};

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Rgba extends Rgb {
  a: number;
}

const GLYPH_LIGHT: Rgba = { r: 232, g: 237, b: 247, a: 255 };
const GLYPH_DARK: Rgba = { r: 11, g: 18, b: 32, a: 255 };

/** Цвет знака для варианта: тёмная панель → светлый знак, светлая → тёмный. */
export function trayGlyphColor(variant: TrayIconVariant): Rgb {
  const color = variant === 'dark' ? GLYPH_LIGHT : GLYPH_DARK;
  return { r: color.r, g: color.g, b: color.b };
}

/** Цвет обводки/кольца-разделителя — контрастен знаку и точке. */
function trayOutlineColor(variant: TrayIconVariant): Rgba {
  return variant === 'dark' ? GLYPH_DARK : GLYPH_LIGHT;
}

/* Геометрия упрощённого знака A в 16-сетке (brand.md §3/§4). */
const GROUND_Y = 11;
const RUNWAY_X0 = 1.8;
const RUNWAY_X1 = 14.2;
const TIRE_CX = 8;
const TIRE_CY = 7.87;
const TIRE_R = 3.45;
const STROKE_HALF = 0.65;
const CONTACT_X0 = 6.55;
const CONTACT_X1 = 9.45;
const CONTACT_HALF = 0.95;
/* Открытый низ кольца (зона пятна контакта): углы хорды в экранных координатах. */
const TIRE_GAP_FROM = 65.1;
const TIRE_GAP_TO = 114.9;

export function parseHexColor(hex: string): Rgb {
  const normalized = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error(`invalid hex color: ${hex}`);
  }
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function onSegment(px: number, py: number, x0: number, x1: number, y: number, half: number): boolean {
  return py >= y - half && py <= y + half && px >= x0 && px <= x1;
}

/** Кольцо шины: длинная дуга, открытая снизу (пятно контакта). */
function inTire(px: number, py: number): boolean {
  const dx = px - TIRE_CX;
  const dy = py - TIRE_CY;
  const dist = Math.hypot(dx, dy);
  if (Math.abs(dist - TIRE_R) > STROKE_HALF) return false;
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  return angle <= TIRE_GAP_FROM || angle >= TIRE_GAP_TO;
}

/** Знак A (моно): ВПП + шина + пятно контакта. */
function inMark(px: number, py: number): boolean {
  if (onSegment(px, py, RUNWAY_X0, RUNWAY_X1, GROUND_Y, STROKE_HALF)) return true;
  if (onSegment(px, py, CONTACT_X0, CONTACT_X1, GROUND_Y, CONTACT_HALF)) return true;
  return inTire(px, py);
}

function markAt(x: number, y: number, size: number): boolean {
  const px = ((x + 0.5) / size) * 16;
  const py = ((y + 0.5) / size) * 16;
  return inMark(px, py);
}

function writePixel(buffer: Buffer, size: number, x: number, y: number, color: Rgba): void {
  const offset = (y * size + x) * 4;
  buffer[offset] = color.b;
  buffer[offset + 1] = color.g;
  buffer[offset + 2] = color.r;
  buffer[offset + 3] = color.a;
}

export interface TrayBitmap {
  width: number;
  height: number;
  /** Сырой BGRA (Windows). */
  buffer: Buffer;
}

/**
 * Растор иконки трея: прозрачный фон, бренд-знак в обводке, цветная точка-статус
 * в правом нижнем углу. `variant` выбирает цвет знака под тему ОС.
 */
export function renderTrayBitmap(
  state: TrayState,
  size = 16,
  variant: TrayIconVariant = DEFAULT_TRAY_ICON_VARIANT,
): TrayBitmap {
  const buffer = Buffer.alloc(size * size * 4);
  const dot = parseHexColor(TRAY_STATE_COLORS[state]);
  const dotColor: Rgba = { ...dot, a: 255 };
  const glyphColor: Rgba = { ...trayGlyphColor(variant), a: 255 };
  const outlineColor = trayOutlineColor(variant);
  const dotCx = size * 0.72;
  const dotCy = size * 0.72;
  const dotRadius = size * 0.19;
  const ringRadius = size * 0.26;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x + 0.5 - dotCx;
      const dy = y + 0.5 - dotCy;
      const distToDot = Math.hypot(dx, dy);
      if (distToDot <= dotRadius) {
        writePixel(buffer, size, x, y, dotColor);
        continue;
      }
      if (distToDot <= ringRadius) {
        writePixel(buffer, size, x, y, outlineColor);
        continue;
      }

      if (markAt(x, y, size)) {
        writePixel(buffer, size, x, y, glyphColor);
        continue;
      }
      const outlined =
        markAt(x - 1, y, size) ||
        markAt(x + 1, y, size) ||
        markAt(x, y - 1, size) ||
        markAt(x, y + 1, size);
      if (outlined) writePixel(buffer, size, x, y, outlineColor);
    }
  }

  return { width: size, height: size, buffer };
}
