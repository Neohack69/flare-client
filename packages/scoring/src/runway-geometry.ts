import {
  QUALITY_BITS,
  type LandingMetricsResponse,
  type Runway,
  type TouchdownPoint,
  type TouchdownZone,
} from '@flightlog/contracts';

/**
 * R-01 residual (F-04): `centreline_offset_m` и `touchdown_zone` вычисляются из
 * трека (точка касания + порог/ось ВПП), а не берутся из недоверенного события
 * `touchdown`. Модуль — чистая детерминированная функция: без I/O, `Date.now`,
 * `Math.random`. Событие остаётся **якорем `ts`** и источником `vs`/`g`/`pitch`/
 * `bank`; геометрические поля сверяются с треком, при расхождении — `SLEW`.
 */

/** Координаты точки касания из трека (WGS84). */
export interface TouchdownFix {
  latitude: number;
  longitude: number;
}

/**
 * Минимальная геометрия ВПП для расчёта метрик касания. Структурно совместима с
 * контрактным `Runway` (порог — опционально: OurAirports может не отдать его).
 */
export type RunwayGeometry = Pick<Runway, 'heading_deg' | 'length_m'> & {
  threshold_lat?: number | null;
  threshold_lon?: number | null;
  /** Координаты дальнего торца (конца оси в направлении посадки). */
  end_lat?: number | null;
  end_lon?: number | null;
  /** Истинный курс оси; при наличии координат пересчитывается из них. */
  heading_deg_true?: number | null;
};

/** Геометрия касания, вычисленная из трека и оси/порога ВПП. */
export interface TouchdownGeometry extends TouchdownFix {
  /** Модуль бокового смещения от осевой, м (≥ 0). */
  centreline_offset_m: number;
  /** Знаковое боковое смещение, м (`+` — справа от осевой). */
  centreline_signed_m: number;
  /** Продольное расстояние от порога вдоль оси ВПП, м (< 0 — до порога). */
  distance_from_threshold_m: number;
  /** Зона касания по геометрии: `before` | `TDZ` | `after`. */
  touchdown_zone: TouchdownZone;
}

/**
 * Пороги классификации зоны касания. TDZ — первая треть полосы, но не дальше
 * 900 м от порога (стандартная протяжённость маркировки TDZ). Значения —
 * детерминированные константы; переопределяются только в тестах.
 */
export const TOUCHDOWN_GEOMETRY_DEFAULTS = {
  tdzMaxLengthM: 900,
  tdzFraction: 1 / 3,
  /** Стандартное удаление маркера точки прицеливания от порога, м. */
  aimingPointM: 300,
} as const;

/** Допуски сверки события и трека (R-01). */
export const TOUCHDOWN_RECONCILE_DEFAULTS = {
  /**
   * Абсолютный допуск расхождения `centreline_offset_m` события и трека (м).
   * Реальный шум метрики/порога не должен давать ложный `SLEW`.
   */
  centrelineToleranceM: 5,
  /** Дополнительный относительный допуск (доля от трекового смещения). */
  centrelineRelativeTolerance: 0.25,
} as const;

const METERS_PER_DEG_LAT = 111_320;
const DEG_TO_RAD = Math.PI / 180;

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizeHeading(value: number): number {
  const wrapped = ((value % 360) + 360) % 360;
  return wrapped >= 360 ? 0 : wrapped;
}

/** Допустимое расхождение длины по координатам и справочной длины полосы. */
const RUNWAY_LENGTH_TOLERANCE = 0.1;

export interface RunwayTrueHeadingInput {
  thresholdLat?: number | null;
  thresholdLon?: number | null;
  endLat?: number | null;
  endLon?: number | null;
  lengthM?: number | null;
  fallbackHeadingDeg?: number | null;
}

/**
 * Истинный курс оси ВПП по координатам торца и дальнего конца полосы.
 *
 * `heading_deg` справочника OurAirports на практике магнитный, поэтому для
 * геометрии/ветра нужен курс из координат. Беринг — плоская аппроксимация
 * `atan2(Δlon·cos(midLat), Δlat)` (полоса — сотни метров..километры).
 *
 * Координат нет **или** их длина расходится со справочной `lengthM` больше чем
 * на 10% (битая/перепутанная пара) → доверенный `fallbackHeadingDeg`.
 * Возвращает нормализованный курс `[0, 360)`.
 */
export function runwayTrueHeading(input: RunwayTrueHeadingInput): number {
  const fallback = finite(input.fallbackHeadingDeg);
  const fallbackHeading = fallback === null ? 0 : normalizeHeading(fallback);
  const thresholdLat = finite(input.thresholdLat);
  const thresholdLon = finite(input.thresholdLon);
  const endLat = finite(input.endLat);
  const endLon = finite(input.endLon);
  const lengthM = finite(input.lengthM);
  if (
    thresholdLat === null ||
    thresholdLon === null ||
    endLat === null ||
    endLon === null ||
    lengthM === null ||
    lengthM <= 0
  ) {
    return fallbackHeading;
  }

  const midLat = (thresholdLat + endLat) / 2;
  const northM = (endLat - thresholdLat) * METERS_PER_DEG_LAT;
  const eastM =
    (endLon - thresholdLon) * METERS_PER_DEG_LAT * Math.cos(midLat * DEG_TO_RAD);
  const derivedLengthM = Math.hypot(northM, eastM);
  if (!(derivedLengthM > 0)) return fallbackHeading;
  if (Math.abs(derivedLengthM - lengthM) > lengthM * RUNWAY_LENGTH_TOLERANCE) {
    return fallbackHeading;
  }

  const bearingDeg = Math.atan2(eastM, northM) / DEG_TO_RAD;
  return Number.isFinite(bearingDeg) ? normalizeHeading(bearingDeg) : fallbackHeading;
}

/** Курс оси с учётом координат торцов и сохранённого истинного курса. */
function runwayAxisHeading(runway: RunwayGeometry): number | null {
  const fallback = finite(runway.heading_deg_true) ?? finite(runway.heading_deg);
  if (fallback === null) return null;
  return runwayTrueHeading({
    thresholdLat: runway.threshold_lat,
    thresholdLon: runway.threshold_lon,
    endLat: runway.end_lat,
    endLon: runway.end_lon,
    lengthM: runway.length_m,
    fallbackHeadingDeg: fallback,
  });
}

/**
 * Геометрия касания: плоская аппроксимация вокруг порога (на масштабе полосы
 * ошибка сферической модели пренебрежимо мала). Ось ВПП — истинный курс
 * (`runwayTrueHeading`, при отсутствии координат — `heading_deg_true`/
 * `heading_deg`); `north`/`east` — локальные метры, `along` — вдоль оси,
 * `cross` — вправо от оси (положительно). `null`, если нет порога/курса/длины.
 */
export function computeTouchdownGeometry(
  fix: TouchdownFix | null | undefined,
  runway: RunwayGeometry | null | undefined,
  options: { tdzMaxLengthM?: number; tdzFraction?: number } = {},
): TouchdownGeometry | null {
  if (!fix || !runway) return null;
  const lat = finite(fix.latitude);
  const lon = finite(fix.longitude);
  const thresholdLat = finite(runway.threshold_lat);
  const thresholdLon = finite(runway.threshold_lon);
  const heading = runwayAxisHeading(runway);
  const lengthM = finite(runway.length_m);
  if (lat === null || lon === null || thresholdLat === null || thresholdLon === null) return null;
  if (heading === null || lengthM === null || lengthM <= 0) return null;

  const headingRad = heading * DEG_TO_RAD;
  const north = (lat - thresholdLat) * METERS_PER_DEG_LAT;
  const east = (lon - thresholdLon) * METERS_PER_DEG_LAT * Math.cos(thresholdLat * DEG_TO_RAD);
  const along = east * Math.sin(headingRad) + north * Math.cos(headingRad);
  const cross = east * Math.cos(headingRad) - north * Math.sin(headingRad);

  const tdzMaxLengthM = options.tdzMaxLengthM ?? TOUCHDOWN_GEOMETRY_DEFAULTS.tdzMaxLengthM;
  const tdzFraction = options.tdzFraction ?? TOUCHDOWN_GEOMETRY_DEFAULTS.tdzFraction;
  const tdzLengthM = Math.min(tdzMaxLengthM, lengthM * tdzFraction);

  const zone: TouchdownZone =
    along < 0 ? 'before' : along <= tdzLengthM ? 'TDZ' : 'after';

  return {
    latitude: lat,
    longitude: lon,
    centreline_offset_m: round1(Math.abs(cross)),
    centreline_signed_m: round1(cross),
    distance_from_threshold_m: round1(along),
    touchdown_zone: zone,
  };
}

/**
 * Каноническая точка касания для `landings.analysis.touchdown_point` из
 * геометрии трека. `null`, если у ВПП нет длины/курса. `relative_z_m` — signed
 * расстояние от порога, `relative_x_m` — signed боковое смещение.
 */
export function buildTouchdownPoint(
  geometry: TouchdownGeometry | null | undefined,
  runway: (RunwayGeometry & Pick<Runway, 'width_m'>) | null | undefined,
  options: { aimingPointM?: number } = {},
): TouchdownPoint | null {
  if (!geometry || !runway) return null;
  const lengthM = finite(runway.length_m);
  const heading = runwayAxisHeading(runway);
  if (lengthM === null || lengthM <= 0 || heading === null) return null;
  const aimingPointM = Math.max(
    0,
    Math.min(options.aimingPointM ?? TOUCHDOWN_GEOMETRY_DEFAULTS.aimingPointM, lengthM - 1),
  );
  const along = geometry.distance_from_threshold_m;
  return {
    relative_x_m: round1(geometry.centreline_signed_m),
    relative_z_m: along,
    aiming_x_m: 0,
    aiming_z_m: round1(aimingPointM),
    start_distance_m: along,
    end_distance_m: round1(lengthM - along),
    heading_deg_true: round1(heading),
    length_m: lengthM,
    width_m: finite(runway.width_m),
  };
}

/**
 * Лежит ли точка касания в пределах полотна ВПП. `null` — нельзя судить
 * (нет длины/ширины); `false` — продольно вне полосы или поперёк за кромкой.
 */
export function isTouchdownOnRunway(
  geometry: TouchdownGeometry | null | undefined,
  runway: Pick<Runway, 'length_m' | 'width_m'> | null | undefined,
): boolean | null {
  if (!geometry || !runway) return null;
  const lengthM = finite(runway.length_m);
  if (lengthM === null || lengthM <= 0) return null;
  if (geometry.distance_from_threshold_m < 0 || geometry.distance_from_threshold_m > lengthM) {
    return false;
  }
  const widthM = finite(runway.width_m);
  if (widthM === null) return null;
  return Math.abs(geometry.centreline_signed_m) <= widthM / 2;
}

/** Результат сверки события `touchdown` с геометрией трека. */
export interface TouchdownGeometryReconciliation {
  /** Метрики с геометрией из трека, когда она доступна (иначе — как пришли). */
  metrics: LandingMetricsResponse;
  /** Вычисленная геометрия трека; `null` — метрики не применялись. */
  geometry: TouchdownGeometry | null;
  /** Дополнительные quality-биты: `SLEW` при расхождении события и трека. */
  flags: number;
  /** Геометрия ВПП/точки касания вычислена и применена. */
  applied: boolean;
  /** Событие противоречит геометрии трека (накрутка). */
  eventContradicts: boolean;
}

/**
 * Применяет геометрию трека к метрикам и сверяет её с событием (R-01).
 *
 * - Нет геометрии (нет ВПП/порога/точки касания) → фолбэк на событие,
 *   **без ложного флага** (`applied=false`, `flags=0`).
 * - Геометрия есть → `centreline_offset_m`/`touchdown_zone` берутся из трека.
 * - Событие задаёт геометрическое поле и расходится с треком за допуском →
 *   `flags |= SLEW`; посадка исключается из лидерборда (value-бит).
 *
 * Детерминированная чистая функция: одинаковый вход → побитово одинаковый выход.
 */
export function reconcileTouchdownGeometry(
  metrics: LandingMetricsResponse,
  fix: TouchdownFix | null | undefined,
  runway: RunwayGeometry | null | undefined,
  options: {
    tdzMaxLengthM?: number;
    tdzFraction?: number;
    centrelineToleranceM?: number;
    centrelineRelativeTolerance?: number;
  } = {},
): TouchdownGeometryReconciliation {
  const geometry = computeTouchdownGeometry(fix, runway, options);
  if (!geometry) {
    return {
      metrics,
      geometry: null,
      flags: 0,
      applied: false,
      eventContradicts: false,
    };
  }

  const applied: LandingMetricsResponse = {
    ...metrics,
    centreline_offset_m: geometry.centreline_offset_m,
    touchdown_zone: geometry.touchdown_zone,
  };

  const eventCentreline = finite(metrics.centreline_offset_m);
  const eventZone = metrics.touchdown_zone ?? null;
  const toleranceM = Math.max(
    options.centrelineToleranceM ?? TOUCHDOWN_RECONCILE_DEFAULTS.centrelineToleranceM,
    geometry.centreline_offset_m *
      (options.centrelineRelativeTolerance ??
        TOUCHDOWN_RECONCILE_DEFAULTS.centrelineRelativeTolerance),
  );
  const centrelineContradicts =
    eventCentreline !== null && Math.abs(eventCentreline - geometry.centreline_offset_m) > toleranceM;
  const zoneContradicts = eventZone !== null && eventZone !== geometry.touchdown_zone;
  const eventContradicts = centrelineContradicts || zoneContradicts;

  return {
    metrics: applied,
    geometry,
    flags: eventContradicts ? QUALITY_BITS.SLEW : 0,
    applied: true,
    eventContradicts,
  };
}
