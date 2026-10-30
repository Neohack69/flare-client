import type { TrackPoint } from './flight.js';

/**
 * Санитизация чисел телеметрии перед записью в PostgreSQL.
 *
 * PostgreSQL `real` (float4) отвергает денормализованные/слишком малые значения
 * (ошибка `22003`, "is out of range for type real", "value out of range:
 * underflow"): порог срабатывания зависит от версии/сборки сервера и лежит около
 * минимального subnormal (~1.4e-45), но защищаться нужно с запасом. Симы могут
 * отдавать шум вида `1.8e-43`. Поэтому числа:
 *   - `NaN`/`±Infinity` → `null` (или `0` для обязательных полей);
 *   - по модулю меньше `TRACK_MIN_MAGNITUDE` → `0` (вырожденный шум);
 *   - округляются до разумной точности (меньше данных, стабильные сравнения);
 *   - зажимаются в диапазоны контракта / безопасный диапазон `real`.
 *
 * Модуль листовой и детерминированный: применяется и агентом при формировании
 * точки (первый барьер), и API перед вставкой (defense-in-depth — старые
 * агенты/прямые клиенты).
 */
export const TRACK_MIN_MAGNITUDE = 1e-6;

/** Безопасный максимум для `real`-колонок без физического диапазона в контракте. */
export const TRACK_REAL_SAFE_MAX = 1e30;

/** Максимум `integer` (`vertical_speed_fpm`). */
export const TRACK_INT_MAX = 2_147_483_647;

/** Максимум `smallint` (`quality`, `precip`). */
export const TRACK_SMALLINT_MAX = 32_767;

/**
 * Разумные верхние границы «физических» полей (INC-UPLOAD1). Валидные значения
 * вне этих границ аномальны (баг сима/сценария), поэтому клампятся, а не
 * отклоняются: `g` реального ВС не превышает ~10, путевая/приборная скорость —
 * 800 kt (выше любого гражданского/GA-ВС MSFS; скоринг отдельно допускает до
 * 1200 kt для отсева телепортов).
 */
export const TRACK_G_MAX = 10;
export const TRACK_SPEED_MAX_KT = 800;

export interface SanitizeNumberOptions {
  /** Нижняя граница (включительно). */
  min?: number;
  /** Верхняя граница (включительно). */
  max?: number;
  /** Число знаков после запятой (0 — целое). */
  decimals?: number;
  /** Значение при `NaN`/`±Infinity`; по умолчанию `null`. */
  fallback?: number | null;
}

/** Округление и зажатие одного числа в допустимый диапазон. */
export function sanitizeNumber(
  value: number | null | undefined,
  options: SanitizeNumberOptions = {},
): number | null {
  const fallback = options.fallback === undefined ? null : options.fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  let result = value;
  if (options.decimals !== undefined) {
    const factor = 10 ** options.decimals;
    result = Math.round(result * factor) / factor;
    // Округление огромного `value` может переполнить double — не выпускаем ∞.
    if (!Number.isFinite(result)) result = value > 0 ? TRACK_REAL_SAFE_MAX : -TRACK_REAL_SAFE_MAX;
  }
  if (Math.abs(result) < TRACK_MIN_MAGNITUDE) result = 0;
  if (options.min !== undefined && result < options.min) result = options.min;
  if (options.max !== undefined && result > options.max) result = options.max;
  return result;
}

/** Обязательное число: нечисловое/не-конечное → `fallback` правила (обычно 0). */
export function sanitizeRequiredNumber(
  value: number | null | undefined,
  options: SanitizeNumberOptions,
): number {
  return sanitizeNumber(value, options) ?? 0;
}

/**
 * Опциональное число: отсутствие (`null`/`undefined`) сохраняется как
 * `undefined`, не-конечное значение тоже отбрасывается (`undefined`).
 */
export function sanitizeOptionalNumber(
  value: number | null | undefined,
  options: SanitizeNumberOptions,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  return sanitizeNumber(value, options) ?? undefined;
}

/**
 * Правила полей `TrackPoint`: диапазоны из `trackPointSchema` там, где они
 * заданы контрактом, иначе — безопасный диапазон `real`. Точность — компромисс
 * «достаточно для скоринга/карты, мало для хранения».
 */
export const TRACK_NUMBER_RULES = {
  lat: { min: -90, max: 90, decimals: 7, fallback: 0 },
  lon: { min: -180, max: 180, decimals: 7, fallback: 0 },
  alt_ft: { min: -TRACK_REAL_SAFE_MAX, max: TRACK_REAL_SAFE_MAX, decimals: 1, fallback: 0 },
  agl_ft: { min: -TRACK_REAL_SAFE_MAX, max: TRACK_REAL_SAFE_MAX, decimals: 1 },
  gs_kt: { min: 0, max: TRACK_SPEED_MAX_KT, decimals: 1, fallback: 0 },
  ias_kt: { min: 0, max: TRACK_SPEED_MAX_KT, decimals: 1 },
  vs_fpm: { min: -TRACK_INT_MAX, max: TRACK_INT_MAX, decimals: 0, fallback: 0 },
  heading_deg: { min: 0, max: 360, decimals: 3, fallback: 0 },
  pitch_deg: { min: -90, max: 90, decimals: 3, fallback: 0 },
  bank_deg: { min: -180, max: 180, decimals: 3, fallback: 0 },
  g: { min: 0, max: TRACK_G_MAX, decimals: 4, fallback: 0 },
  quality: { min: 0, max: TRACK_SMALLINT_MAX, decimals: 0, fallback: 0 },
  wind_dir_deg: { min: 0, max: 360, decimals: 1 },
  wind_speed_kt: { min: 0, max: TRACK_REAL_SAFE_MAX, decimals: 1 },
  wind_gust_kt: { min: 0, max: TRACK_REAL_SAFE_MAX, decimals: 1 },
  temp_c: { min: -TRACK_REAL_SAFE_MAX, max: TRACK_REAL_SAFE_MAX, decimals: 1 },
  qnh_hpa: { min: 0, max: TRACK_REAL_SAFE_MAX, decimals: 1 },
  precip: { min: 0, max: TRACK_SMALLINT_MAX, decimals: 0 },
  visibility_m: { min: 0, max: TRACK_REAL_SAFE_MAX, decimals: 0 },
} as const satisfies Record<string, SanitizeNumberOptions>;

/** Санитизирует числовые поля точки, сохраняя остальные поля как есть. */
export function sanitizeTrackPointNumbers(point: TrackPoint): TrackPoint {
  const rules = TRACK_NUMBER_RULES;
  return {
    ...point,
    lat: sanitizeRequiredNumber(point.lat, rules.lat),
    lon: sanitizeRequiredNumber(point.lon, rules.lon),
    alt_ft: sanitizeRequiredNumber(point.alt_ft, rules.alt_ft),
    agl_ft: sanitizeOptionalNumber(point.agl_ft, rules.agl_ft),
    gs_kt: sanitizeRequiredNumber(point.gs_kt, rules.gs_kt),
    ias_kt: sanitizeOptionalNumber(point.ias_kt, rules.ias_kt),
    vs_fpm: sanitizeOptionalNumber(point.vs_fpm, rules.vs_fpm),
    heading_deg: sanitizeRequiredNumber(point.heading_deg, rules.heading_deg),
    pitch_deg: sanitizeRequiredNumber(point.pitch_deg, rules.pitch_deg),
    bank_deg: sanitizeRequiredNumber(point.bank_deg, rules.bank_deg),
    g: sanitizeRequiredNumber(point.g, rules.g),
    quality: sanitizeRequiredNumber(point.quality, rules.quality),
    wind_dir_deg: sanitizeOptionalNumber(point.wind_dir_deg, rules.wind_dir_deg),
    wind_speed_kt: sanitizeOptionalNumber(point.wind_speed_kt, rules.wind_speed_kt),
    wind_gust_kt: sanitizeOptionalNumber(point.wind_gust_kt, rules.wind_gust_kt),
    temp_c: sanitizeOptionalNumber(point.temp_c, rules.temp_c),
    qnh_hpa: sanitizeOptionalNumber(point.qnh_hpa, rules.qnh_hpa),
    precip: sanitizeOptionalNumber(point.precip, rules.precip),
    visibility_m: sanitizeOptionalNumber(point.visibility_m, rules.visibility_m),
  };
}
