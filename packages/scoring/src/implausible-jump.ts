/**
 * Детерминированный guard против «фантомных» посадок после загрузки/телепорта
 * (P2). На треке, записанном из меню загрузки сима, высота может рухнуть с
 * крейсерских десятков тысяч футов до земли за один кадр — формально это
 * переход `air → ground`, но физически это не касание.
 *
 * Модуль листовой и чистый: только `ts`/`altitude_ft`/`lat`/`lon`, без I/O,
 * `Date.now` и `Math.random`. Общий для API (`/complete`) и тестов.
 */

import { isPlausibleCoordinate } from './telemetry-sanity.js';

/** Пороги отбраковки неправдоподобного скачка. Комментарии — контракт. */
export const IMPLAUSIBLE_JUMP_LIMITS = {
  /** Скачок высоты за один кадр (ft), выше любого реального снижения. */
  maxAltitudeJumpFt: 5_000,
  /** Горизонтальный скачок за один кадр (м). */
  maxHorizontalJumpM: 5_000,
  /**
   * Кадры считаются последовательными, только если между ними не больше этого
   * интервала: длинная пауза — это разрыв записи, а не телепорт.
   */
  maxGapS: 2,
  /** Окно до касания, в котором ищется скачок (с). */
  preTouchdownWindowS: 30,
  /** Порог «низколетящего» рейса по максимальной высоте (ft). */
  shortFlightMaxAltitudeFt: 5_000,
  /** Порог «короткого» рейса (с). */
  shortFlightMaxDurationS: 120,
} as const;


const EARTH_RADIUS_M = 6_371_000;

/** Точка трека, достаточная для проверки скачка. */
export interface JumpGuardPoint {
  ts: string;
  alt_ft?: number | null;
  altitude_ft?: number | null;
  lat?: number | null;
  lon?: number | null;
  latitude?: number | null;
  longitude?: number | null;
}

/** Результат проверки пары соседних точек. */
export interface ImplausibleJump {
  detected: boolean;
  kind: 'altitude' | 'horizontal' | null;
  /** Модуль изменения высоты (ft); `null` — высота не измерена. */
  deltaFt: number | null;
  /** Горизонтальное расстояние (м); `null` — координаты не измерены. */
  distanceM: number | null;
  /** Интервал между точками (с). */
  dtS: number | null;
  fromTs: string | null;
  toTs: string | null;
}

const NO_JUMP: ImplausibleJump = {
  detected: false,
  kind: null,
  deltaFt: null,
  distanceM: null,
  dtS: null,
  fromTs: null,
  toTs: null,
};

function altitudeOf(point: JumpGuardPoint): number | null {
  const value = point.alt_ft ?? point.altitude_ft;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function latitudeOf(point: JumpGuardPoint): number | null {
  const value = point.lat ?? point.latitude;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function longitudeOf(point: JumpGuardPoint): number | null {
  const value = point.lon ?? point.longitude;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function byTs(a: JumpGuardPoint, b: JumpGuardPoint): number {
  return Date.parse(a.ts) - Date.parse(b.ts);
}

function checkPair(previous: JumpGuardPoint, current: JumpGuardPoint): ImplausibleJump {
  const previousMs = Date.parse(previous.ts);
  const currentMs = Date.parse(current.ts);
  if (!Number.isFinite(previousMs) || !Number.isFinite(currentMs)) return NO_JUMP;
  const dtS = (currentMs - previousMs) / 1000;
  if (!(dtS > 0) || dtS > IMPLAUSIBLE_JUMP_LIMITS.maxGapS) return NO_JUMP;

  const previousLat = latitudeOf(previous);
  const previousLon = longitudeOf(previous);
  const currentLat = latitudeOf(current);
  const currentLon = longitudeOf(current);
  // Sentinel-координаты (null island) — уже известный мусор старта/меню;
  // их обрабатывает `assessTrackSanity`, и высота там произвольна. Пара с
  // такой координатой не должна «телепортировать» настоящий рейс.
  if (
    (previousLat !== null && previousLon !== null &&
      !isPlausibleCoordinate(previousLat, previousLon)) ||
    (currentLat !== null && currentLon !== null &&
      !isPlausibleCoordinate(currentLat, currentLon))
  ) {
    return NO_JUMP;
  }

  const previousAlt = altitudeOf(previous);
  const currentAlt = altitudeOf(current);
  const deltaFt =
    previousAlt !== null && currentAlt !== null ? Math.abs(currentAlt - previousAlt) : null;
  if (deltaFt !== null && deltaFt > IMPLAUSIBLE_JUMP_LIMITS.maxAltitudeJumpFt) {
    return {
      detected: true,
      kind: 'altitude',
      deltaFt,
      distanceM: null,
      dtS,
      fromTs: previous.ts,
      toTs: current.ts,
    };
  }

  const distanceM =
    previousLat !== null && previousLon !== null && currentLat !== null && currentLon !== null
      ? haversineMeters(previousLat, previousLon, currentLat, currentLon)
      : null;
  if (distanceM !== null && distanceM > IMPLAUSIBLE_JUMP_LIMITS.maxHorizontalJumpM) {
    return {
      detected: true,
      kind: 'horizontal',
      deltaFt,
      distanceM,
      dtS,
      fromTs: previous.ts,
      toTs: current.ts,
    };
  }

  return { ...NO_JUMP, deltaFt, distanceM, dtS, fromTs: previous.ts, toTs: current.ts };
}

/**
 * Первый неправдоподобный скачок между соседними по времени точками трека.
 * Точки сортируются детерминированно по `ts`; некорректные/отсутствующие
 * значения высоты или координат не считаются скачком.
 */
export function detectImplausibleJump(
  points: readonly JumpGuardPoint[],
): ImplausibleJump {
  if (points.length < 2) return NO_JUMP;
  const sorted = points
    .filter((point) => Number.isFinite(Date.parse(point.ts)))
    .slice()
    .sort(byTs);
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (!previous || !current) continue;
    const jump = checkPair(previous, current);
    if (jump.detected) return jump;
  }
  return NO_JUMP;
}

/**
 * Скачок в окне `windowS` до касания (включительно). Если касаний несколько,
 * проверяется каждое; возвращается первый найденный скачок.
 */
export function detectImplausibleJumpBeforeTouch(
  points: readonly JumpGuardPoint[],
  touchdownTs: string,
  windowS: number = IMPLAUSIBLE_JUMP_LIMITS.preTouchdownWindowS,
): ImplausibleJump {
  const anchor = Date.parse(touchdownTs);
  if (!Number.isFinite(anchor)) return NO_JUMP;
  const from = anchor - windowS * 1000;
  const window = points.filter((point) => {
    const ts = Date.parse(point.ts);
    return Number.isFinite(ts) && ts >= from && ts <= anchor;
  });
  return detectImplausibleJump(window);
}

/** Короткий рейс, «побывавший» выше 5 000 ft, — признак загрузки/телепорта. */
export function isImplausibleShortFlight(
  maxAltitudeFt: number | null,
  durationS: number | null,
): boolean {
  return (
    typeof maxAltitudeFt === 'number' &&
    Number.isFinite(maxAltitudeFt) &&
    maxAltitudeFt > IMPLAUSIBLE_JUMP_LIMITS.shortFlightMaxAltitudeFt &&
    typeof durationS === 'number' &&
    Number.isFinite(durationS) &&
    durationS < IMPLAUSIBLE_JUMP_LIMITS.shortFlightMaxDurationS
  );
}
