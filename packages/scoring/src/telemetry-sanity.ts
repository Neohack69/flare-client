/**
 * Детерминированные проверки правдоподобия телеметрии (P0, data integrity).
 *
 * Зачем: при загрузке сима/в меню выбора ВС SimConnect отдаёт «мусорные» кадры
 * — нулевые/sentinel-координаты (null island `(0,0)`, `lat≈0`, `lon≈90`),
 * произвольные `alt`/`agl` при `on_ground=false`. Раньше такие кадры проходили
 * проверку отрыва (`agl ≥ 30`) и рождали фиктивный рейс с посадкой.
 *
 * Модуль — листовой и чистый (без I/O, `Date.now`, `Math.random`). Общий для
 * агента (первый барьер — не стартовать рейс и не писать мусор) и API
 * (defense-in-depth: старый/враждебный клиент не станет хранимым рейсом).
 */

/** Пороги правдоподобия телеметрии. Комментарии обязательны — это контракт. */
export const TELEMETRY_SANITY_LIMITS = {
  /** Диапазон WGS84 (градусы). */
  maxAbsLat: 90,
  maxAbsLon: 180,
  /**
   * Эпсилон (градусы) распознавания «пустой» (неинициализированной)
   * координаты. Sentinel старта/меню: `lat≈0` при `lon≈0/±90/±180`.
   * Малый эпсилон — намеренно, реальные координаты в этих точках не встречаются.
   */
  emptyCoordEpsDeg: 0.01,
  /** Потолки значений — выше любого реального ВС MSFS (запас на запас). */
  maxAbsAltFt: 60_000,
  maxAbsAglFt: 60_000,
  maxGsKt: 1_500,
  maxIasKt: 2_000,
} as const;

/** Причина отбраковки кадра. */
export type TelemetrySanityReason =
  | 'lat_lon_non_finite'
  | 'lat_out_of_range'
  | 'lon_out_of_range'
  | 'null_island'
  | 'alt_non_finite'
  | 'alt_out_of_range'
  | 'agl_non_finite'
  | 'agl_out_of_range'
  | 'gs_non_finite'
  | 'gs_out_of_range'
  | 'ias_non_finite'
  | 'ias_out_of_range'
  | 'vs_non_finite';

export interface TelemetrySanityResult {
  ok: boolean;
  reason: TelemetrySanityReason | null;
}

/** Нормализованный сэмпл для проверки (подмножество `TelemetrySample`). */
export interface TelemetrySanityInput {
  lat: number;
  lon: number;
  alt_ft: number;
  agl_ft?: number | null;
  gs_kt: number;
  ias_kt?: number | null;
  vs_fpm?: number | null;
}

const OK: TelemetrySanityResult = { ok: true, reason: null };

function fail(reason: TelemetrySanityReason): TelemetrySanityResult {
  return { ok: false, reason };
}

/**
 * Достоверная позиция: конечные числа в диапазоне WGS84 и не sentinel-мусор.
 *
 * Sentinel-паттерны (P0):
 *  - `lat === 0` / `lon === ±90` — точные значения неинициализированной телеметрии;
 *  - `|lat| ≈ 0` при `|lon| ≈ 0/90/180` — null island и стартовые значения.
 *
 * Согласовано с `PLAUSIBLE_POSITION_SQL` в `apps/api/src/track/track.repository.ts`.
 */
export function isPlausibleCoordinate(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > TELEMETRY_SANITY_LIMITS.maxAbsLat) return false;
  if (Math.abs(lon) > TELEMETRY_SANITY_LIMITS.maxAbsLon) return false;
  // Точные sentinel-значения (в реальной телеметрии не встречаются).
  if (lat === 0) return false;
  if (lon === 90 || lon === -90) return false;
  const eps = TELEMETRY_SANITY_LIMITS.emptyCoordEpsDeg;
  if (Math.abs(lat) <= eps) {
    return !(
      Math.abs(lon) <= eps ||
      Math.abs(Math.abs(lon) - 90) <= eps ||
      Math.abs(Math.abs(lon) - 180) <= eps
    );
  }
  return true;
}

/**
 * Проверка одного сэмпла: координаты, высоты, скорости. Возвращает первую
 * найденную причину (детерминированный порядок), `ok:true` — кадр правдоподобен.
 */
export function checkTelemetrySample(input: TelemetrySanityInput): TelemetrySanityResult {
  const { lat, lon, alt_ft, agl_ft, gs_kt, ias_kt, vs_fpm } = input;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return fail('lat_lon_non_finite');
  if (Math.abs(lat) > TELEMETRY_SANITY_LIMITS.maxAbsLat) return fail('lat_out_of_range');
  if (Math.abs(lon) > TELEMETRY_SANITY_LIMITS.maxAbsLon) return fail('lon_out_of_range');
  if (!isPlausibleCoordinate(lat, lon)) return fail('null_island');

  if (!Number.isFinite(alt_ft)) return fail('alt_non_finite');
  if (Math.abs(alt_ft) > TELEMETRY_SANITY_LIMITS.maxAbsAltFt) return fail('alt_out_of_range');

  if (agl_ft !== null && agl_ft !== undefined) {
    if (!Number.isFinite(agl_ft)) return fail('agl_non_finite');
    if (Math.abs(agl_ft) > TELEMETRY_SANITY_LIMITS.maxAbsAglFt) return fail('agl_out_of_range');
  }

  if (!Number.isFinite(gs_kt)) return fail('gs_non_finite');
  if (gs_kt < 0 || gs_kt > TELEMETRY_SANITY_LIMITS.maxGsKt) return fail('gs_out_of_range');

  if (ias_kt !== null && ias_kt !== undefined) {
    if (!Number.isFinite(ias_kt)) return fail('ias_non_finite');
    if (ias_kt < 0 || ias_kt > TELEMETRY_SANITY_LIMITS.maxIasKt) return fail('ias_out_of_range');
  }

  if (vs_fpm !== null && vs_fpm !== undefined && !Number.isFinite(vs_fpm)) {
    return fail('vs_non_finite');
  }

  return OK;
}

/** Точка трека для серверной оценки правдоподобия (только координаты). */
export interface TrackCoordinatePoint {
  lat?: number | null;
  lon?: number | null;
}

export interface TrackSanityAssessment {
  total: number;
  plausible_coordinates: number;
  implausible_coordinates: number;
  /** Нет ни одной достоверной координаты (при `total > 0`). */
  no_valid_coordinates: boolean;
  /** Доля недостоверных координат (0 при пустом треке). */
  implausible_ratio: number;
}

/** Политика отбраковки рейса по треку. */
export const TRACK_SANITY_LIMITS = {
  /**
   * Доля недостоверных точек, выше которой трек считается мусорным. Порог
   * намеренно высокий: реальный полёт мог записать много sentinel-кадров старта
   * (регресс BUG-track-route: DA62 с 35 bogus-точками среди 45, `lat≈0`/`lon≈90`)
   * — такой рейс сохраняется, если в нём есть настоящие координаты. Отбраковка
   * наступает только когда мусор подавляющий (> 90 %) либо валидных координат
   * нет вовсе (`no_valid_coordinates`).
   */
  maxImplausibleRatio: 0.9,
} as const;

/** Считает доли достоверных/недостоверных координат трека (без I/O). */
export function assessTrackSanity(
  points: readonly TrackCoordinatePoint[],
): TrackSanityAssessment {
  let plausible = 0;
  let implausible = 0;
  for (const point of points) {
    const lat = point.lat;
    const lon = point.lon;
    const valid =
      typeof lat === 'number' &&
      typeof lon === 'number' &&
      isPlausibleCoordinate(lat, lon);
    if (valid) plausible += 1;
    else implausible += 1;
  }
  const total = points.length;
  return {
    total,
    plausible_coordinates: plausible,
    implausible_coordinates: implausible,
    no_valid_coordinates: total > 0 && plausible === 0,
    implausible_ratio: total === 0 ? 0 : implausible / total,
  };
}

/**
 * Неправдоподобный трек: нет ни одной достоверной координаты (все null island)
 * либо недостоверных точек больше `maxImplausibleRatio` (> 90 %). Порог высокий
 * намеренно: рейс с несколькими sentinel-кадрами старта (но реальными
 * координатами) сохраняется. Пустой трек сюда НЕ попадает — отсутствие данных
 * обрабатывается отдельно.
 */
export function isImplausibleTrack(assessment: TrackSanityAssessment): boolean {
  if (assessment.total === 0) return false;
  return (
    assessment.no_valid_coordinates ||
    assessment.implausible_ratio > TRACK_SANITY_LIMITS.maxImplausibleRatio
  );
}
