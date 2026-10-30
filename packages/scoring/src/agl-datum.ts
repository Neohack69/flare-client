import { AGL_DATUM_VERSION } from '@flightlog/contracts';

/**
 * FOQA-DATUM-1: калибровка датума AGL.
 *
 * Записанный `agl_ft` / `RADIO HEIGHT` — это высота **опорной точки** модели над
 * землёй, а не колёс. У A220-300/BCS3 (MSFS 2024) на стоянке `agl_ft` = 10.0–10.1
 * ft при колёсах на полосе (9.9 ft на холодном старте), на кадре касания —
 * 12.1–12.4 ft (обжатие стоек ≈2 ft). Поэтому любая метрика «над землёй»
 * завышена на этот сдвиг, а пороги в футах зависят от ВС (у C172 сдвиг ≈0–2 ft).
 *
 * Модуль измеряет сдвиг детерминированно по наземной площадке рейса и переводит
 * высоту опорной точки в высоту колёс. Чистый: без I/O, `Date.now`, `Math.random`.
 * Версия правил — `AGL_DATUM_VERSION` (`@flightlog/contracts`).
 */
export { AGL_DATUM_VERSION };

export const AGL_DATUM_DEFAULTS = {
  /**
   * Наземные сэмплы с путевой скоростью выше этого порога не описывают датум
   * стоянки (разбег/пробег уже с поднятой стойкой) — исключаются.
   */
  groundMaxGsKt: 30,
  /** Минимум наземных сэмплов, при котором площадке можно верить. */
  minGroundSamples: 5,
  /** Сдвиги вне [0, maxOffsetFt] неправдоподобны → калибровка не удалась. */
  maxOffsetFt: 50,
  /** Округление хранимого сдвига и корректированных высот (ft). */
  decimals: 1,
} as const;

/** Наземный сэмпл для измерения датума (подмножество `TelemetrySample`/точки). */
export interface GroundHeightSample {
  on_ground: boolean;
  groundspeed_kt?: number | null;
  agl_ft?: number | null;
}

export interface AglDatumOptions {
  groundMaxGsKt?: number;
  minGroundSamples?: number;
  maxOffsetFt?: number;
  decimals?: number;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Датум-сдвиг рейса, ft: **медиана** `agl_ft` наземных сэмплов с низкой путевой
 * скоростью (стоянка на старте или пробег после посадки). Детерминированная
 * чистая функция. `null`, если пригодных сэмплов меньше `minGroundSamples` или
 * медиана неправдоподобна — вызывающий обязан трактовать `null` как
 * «не откалибровано», никогда как 0.
 */
export function measureAglDatumOffset(
  samples: readonly GroundHeightSample[],
  options: AglDatumOptions = {},
): number | null {
  const groundMaxGsKt = options.groundMaxGsKt ?? AGL_DATUM_DEFAULTS.groundMaxGsKt;
  const minGroundSamples = options.minGroundSamples ?? AGL_DATUM_DEFAULTS.minGroundSamples;
  const maxOffsetFt = options.maxOffsetFt ?? AGL_DATUM_DEFAULTS.maxOffsetFt;
  const decimals = options.decimals ?? AGL_DATUM_DEFAULTS.decimals;

  const values: number[] = [];
  for (const sample of samples) {
    if (!sample.on_ground) continue;
    const agl = finite(sample.agl_ft);
    if (agl === null) continue;
    const gs = finite(sample.groundspeed_kt);
    if (gs !== null && gs > groundMaxGsKt) continue;
    values.push(agl);
  }
  if (values.length < minGroundSamples) return null;

  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
  if (!(median >= 0) || median > maxOffsetFt) return null;
  return round(median, decimals);
}

/**
 * Высота опорной точки → высота колёс: `max(0, height − offset)`, ft.
 *
 * - `height = null` (измерения нет) → `{ value: null, calibrated }`.
 * - `offset = null` (рейс не откалиброван) → `{ value: null, calibrated: false }`
 *   — значение **не подделывается**; сырую высоту потребитель берёт из исходного
 *   поля (`flare_height_ft`/`radio_height_touchdown_ft`), а не отсюда.
 * - иначе → `{ value, calibrated: true }`.
 */
export function toWheelHeightFt(
  referenceHeightFt: number | null | undefined,
  datumOffsetFt: number | null,
  options: { decimals?: number } = {},
): { value: number | null; calibrated: boolean } {
  const decimals = options.decimals ?? AGL_DATUM_DEFAULTS.decimals;
  const height = finite(referenceHeightFt);
  if (height === null) return { value: null, calibrated: datumOffsetFt !== null };
  if (datumOffsetFt === null) return { value: null, calibrated: false };
  return { value: round(Math.max(0, height - datumOffsetFt), decimals), calibrated: true };
}
