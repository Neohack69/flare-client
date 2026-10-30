import type { TelemetrySample } from '../sim/types.js';

/**
 * Пороги детекта телепорта/загрузки по агентскому сэмплу (P2).
 *
 * Имплицитная путевая скорость `расстояние / dt` сравнивается с заведомо
 * недостижимым для нормального полёта пределом: порог намеренно выше серверного
 * `TRACK_INTEGRITY_LIMITS.maxImpliedSpeedKt`, потому что ложное срабатывание
 * пропустило бы валидный кадр фаз/касания.
 *
 * Дополнительно ловим «прыжок» высоты/позиции, который не выражается в
 * скорости (загрузка сима ставит самолёт на землю, оставляя правдоподобную
 * горизонтальную позицию): скачок >5 000 ft или >5 км за <2 с — телепорт.
 *
 * `maxGapS` намеренно оставлен: разрыв записи длиннее интервала — это пауза/гэп
 * (как и серверный `maxContinuityGapS`), за которую позиция меняется штатно, а не
 * телепорт; имплицитная скорость по такой паре не оценивается. Пропуск скачка
 * из-за устаревшей базы (`previousSample` старше `maxGapS`) не является обходом
 * защиты: детекторы фазы/касания ведут собственный флаг `teleportedSinceGround`,
 * который выставляется на **кадрах slew** (их `previousSample` намеренно не
 * двигает) и держится до первого обработанного наземного кадра. Поэтому длинный
 * slew со «слепой» базой всё равно не даёт ложный отрыв/посадку.
 */
export const TELEPORT_JUMP_LIMITS = {
  /** Предел имплицитной путевой скорости (kt); любой серийный самолёт ниже. */
  maxImpliedSpeedKt: 2500,
  /** Микродрожание GPS ниже этого расстояния телепортом не считается (м). */
  minDistanceM: 100,
  /** Разрыв записи длиннее этого интервала — пауза/гэп, а не телепорт (с). */
  maxGapS: 5,
  /** Скачок высоты за один кадр (ft), выше любого реального снижения. */
  maxAltitudeJumpFt: 5_000,
  /** Горизонтальный скачок за один кадр (м). */
  maxHorizontalJumpM: 5_000,
  /** Окно, в котором скачок позиции считается мгновенным (с). */
  jumpWindowS: 2,
} as const;

const EARTH_RADIUS_M = 6_371_000;
const METRES_PER_SECOND_TO_KNOTS = 1.943844;

function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Детали обнаруженного скачка — для единственного лога на рейс. */
export interface TeleportDetection {
  detected: boolean;
  kind: 'altitude' | 'horizontal' | null;
  /** Модуль изменения высоты (ft). */
  altitudeDeltaFt: number | null;
  /** Горизонтальное расстояние (м). */
  horizontalM: number | null;
  /** Интервал между кадрами (с). */
  dtS: number | null;
}

const NO_TELEPORT: TeleportDetection = {
  detected: false,
  kind: null,
  altitudeDeltaFt: null,
  horizontalM: null,
  dtS: null,
};

/**
 * Неправдоподобный мгновенный скачок между двумя сэмплами (телепорт/загрузка),
 * в том числе кадр сразу после выключения slew, когда флаг `slew` уже сброшен.
 * Чистая детерминированная функция: только `lat`/`lon`/`alt_ft`/`ts`, без
 * таймеров, `Date.now` и `Math.random`.
 */
export function detectTeleport(
  previous: TelemetrySample | null,
  current: TelemetrySample,
): TeleportDetection {
  if (previous === null) return NO_TELEPORT;
  const previousMs = Date.parse(previous.ts);
  const currentMs = Date.parse(current.ts);
  if (!Number.isFinite(previousMs) || !Number.isFinite(currentMs)) return NO_TELEPORT;
  const dtS = (currentMs - previousMs) / 1000;
  if (!(dtS > 0) || dtS > TELEPORT_JUMP_LIMITS.maxGapS) return NO_TELEPORT;

  const altitudeDeltaFt =
    Number.isFinite(previous.alt_ft) && Number.isFinite(current.alt_ft)
      ? Math.abs(current.alt_ft - previous.alt_ft)
      : null;
  if (altitudeDeltaFt !== null && altitudeDeltaFt > TELEPORT_JUMP_LIMITS.maxAltitudeJumpFt) {
    return {
      detected: true,
      kind: 'altitude',
      altitudeDeltaFt,
      horizontalM: null,
      dtS,
    };
  }

  const distanceM = haversineMeters(previous.lat, previous.lon, current.lat, current.lon);
  const insideJumpWindow = dtS < TELEPORT_JUMP_LIMITS.jumpWindowS;
  if (
    insideJumpWindow &&
    distanceM > TELEPORT_JUMP_LIMITS.maxHorizontalJumpM
  ) {
    return {
      detected: true,
      kind: 'horizontal',
      altitudeDeltaFt,
      horizontalM: distanceM,
      dtS,
    };
  }

  if (distanceM < TELEPORT_JUMP_LIMITS.minDistanceM) {
    return { ...NO_TELEPORT, altitudeDeltaFt, horizontalM: distanceM, dtS };
  }
  const impliedKt = (distanceM / dtS) * METRES_PER_SECOND_TO_KNOTS;
  return {
    detected: impliedKt > TELEPORT_JUMP_LIMITS.maxImpliedSpeedKt,
    kind: impliedKt > TELEPORT_JUMP_LIMITS.maxImpliedSpeedKt ? 'horizontal' : null,
    altitudeDeltaFt,
    horizontalM: distanceM,
    dtS,
  };
}

/** Совместимая обёртка: `true` — кадр неправдоподобен (телепорт/загрузка). */
export function isImplausiblePositionJump(
  previous: TelemetrySample | null,
  current: TelemetrySample,
): boolean {
  return detectTeleport(previous, current).detected;
}
