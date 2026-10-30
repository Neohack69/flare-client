import { QUALITY_BITS, landingMetricsSchema, type LandingMetrics } from '@flightlog/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildTouchdownPoint,
  computeTouchdownGeometry,
  isTouchdownOnRunway,
  reconcileTouchdownGeometry,
  runwayTrueHeading,
  TOUCHDOWN_GEOMETRY_DEFAULTS,
} from './runway-geometry.js';

/** Порог в точке (0, 0); курс 0° (север); полоса 3000 м. */
const RUNWAY = {
  heading_deg: 0,
  length_m: 3000,
  width_m: 45,
  threshold_lat: 0,
  threshold_lon: 0,
};

/** EDDS 07/25 из сида OurAirports: heading_deg магнитный (72/252). */
const EDDS_07 = {
  heading_deg: 72,
  heading_deg_true: 73.9,
  length_m: 3345,
  width_m: 45,
  threshold_lat: 48.685699462890625,
  threshold_lon: 9.200130462646484,
  end_lat: 48.694000244140625,
  end_lon: 9.243800163269043,
};

const DEG_TO_RAD = Math.PI / 180;
const METERS_PER_DEG_LAT = 111320;

/** Точка на оси полосы в `distanceM` от порога (для проверки cross = 0). */
function alongRunway(
  runway: typeof EDDS_07,
  distanceM: number,
): { latitude: number; longitude: number } {
  const heading = runwayTrueHeading({
    thresholdLat: runway.threshold_lat,
    thresholdLon: runway.threshold_lon,
    endLat: runway.end_lat,
    endLon: runway.end_lon,
    lengthM: runway.length_m,
    fallbackHeadingDeg: runway.heading_deg,
  });
  const north = distanceM * Math.cos(heading * DEG_TO_RAD);
  const east = distanceM * Math.sin(heading * DEG_TO_RAD);
  return {
    latitude: runway.threshold_lat + north / METERS_PER_DEG_LAT,
    longitude:
      runway.threshold_lon +
      east / (METERS_PER_DEG_LAT * Math.cos(runway.threshold_lat * DEG_TO_RAD)),
  };
}

function metrics(overrides: Partial<LandingMetrics> = {}): LandingMetrics {
  return landingMetricsSchema.parse({
    vs_fpm: -150,
    g_force: 1.2,
    bounce_count: 0,
    bounced: false,
    ...overrides,
  });
}

/** Смещение по широте от экватора, м → градусы (приближение). */
function latOffsetM(m: number): number {
  return m / 111_320;
}

/** Смещение по долготе от (0,0), м → градусы (на экваторе). */
function lonOffsetM(m: number): number {
  return m / 111_320;
}

describe('computeTouchdownGeometry (R-01 residual)', () => {
  it('точка на осевой, на пороге → offset 0, TDZ', () => {
    const geometry = computeTouchdownGeometry({ latitude: 0, longitude: 0 }, RUNWAY);
    expect(geometry).not.toBeNull();
    expect(geometry?.centreline_offset_m).toBe(0);
    expect(geometry?.distance_from_threshold_m).toBe(0);
    expect(geometry?.touchdown_zone).toBe('TDZ');
  });

  it('боковое смещение к востоку при курсе 0° → offset = восточное расстояние', () => {
    const geometry = computeTouchdownGeometry(
      { latitude: 0, longitude: lonOffsetM(8) },
      RUNWAY,
    );
    expect(geometry?.centreline_offset_m).toBeCloseTo(8, 1);
    expect(geometry?.centreline_signed_m).toBeCloseTo(8, 1);
    expect(geometry?.distance_from_threshold_m).toBeCloseTo(0, 1);
    expect(geometry?.touchdown_zone).toBe('TDZ');
  });

  it('точка вдоль оси при курсе 90° → offset 0, distance по долготе', () => {
    const geometry = computeTouchdownGeometry(
      { latitude: 0, longitude: lonOffsetM(200) },
      { ...RUNWAY, heading_deg: 90 },
    );
    expect(geometry?.centreline_offset_m).toBeCloseTo(0, 1);
    expect(geometry?.distance_from_threshold_m).toBeCloseTo(200, 0);
    expect(geometry?.touchdown_zone).toBe('TDZ');
  });

  it('касание до порога → zone before (отрицательное расстояние)', () => {
    const geometry = computeTouchdownGeometry(
      { latitude: latOffsetM(-120), longitude: 0 },
      RUNWAY,
    );
    expect(geometry?.distance_from_threshold_m).toBeCloseTo(-120, 1);
    expect(geometry?.touchdown_zone).toBe('before');
  });

  it('касание дальше TDZ (первая треть / 900 м) → zone after', () => {
    const geometry = computeTouchdownGeometry(
      { latitude: latOffsetM(1200), longitude: 0 },
      RUNWAY,
    );
    expect(geometry?.touchdown_zone).toBe('after');
    expect(geometry?.distance_from_threshold_m).toBeCloseTo(1200, 0);
  });

  it('короткая полоса: TDZ = треть длины, а не 900 м', () => {
    const geometry = computeTouchdownGeometry(
      { latitude: latOffsetM(500), longitude: 0 },
      { ...RUNWAY, length_m: 1200 },
    );
    // 500 м > 1200/3 = 400 → after.
    expect(geometry?.touchdown_zone).toBe('after');
    expect(TOUCHDOWN_GEOMETRY_DEFAULTS.tdzMaxLengthM).toBe(900);
  });

  it('нет порога/курса/длины → null (фолбэк на событие)', () => {
    expect(computeTouchdownGeometry({ latitude: 0, longitude: 0 }, null)).toBeNull();
    expect(
      computeTouchdownGeometry(
        { latitude: 0, longitude: 0 },
        { heading_deg: 0, length_m: 3000 },
      ),
    ).toBeNull();
    expect(computeTouchdownGeometry(null, RUNWAY)).toBeNull();
  });

  it('детерминирован: одинаковый вход → одинаковый выход', () => {
    const fix = { latitude: latOffsetM(300), longitude: lonOffsetM(12) };
    expect(computeTouchdownGeometry(fix, RUNWAY)).toEqual(computeTouchdownGeometry(fix, RUNWAY));
  });
});

describe('runwayTrueHeading (T1: true axis from coordinates)', () => {
  it('EDDS 07: курс из координат (73.9°), а не магнитный heading_deg (72°)', () => {
    const heading = runwayTrueHeading({
      thresholdLat: EDDS_07.threshold_lat,
      thresholdLon: EDDS_07.threshold_lon,
      endLat: EDDS_07.end_lat,
      endLon: EDDS_07.end_lon,
      lengthM: EDDS_07.length_m,
      fallbackHeadingDeg: EDDS_07.heading_deg,
    });
    expect(heading).toBeCloseTo(73.9, 1);
  });

  it('зеркальный торец 25: порог = he, конец = le, курс ≈ 253.9°', () => {
    const heading = runwayTrueHeading({
      thresholdLat: EDDS_07.end_lat,
      thresholdLon: EDDS_07.end_lon,
      endLat: EDDS_07.threshold_lat,
      endLon: EDDS_07.threshold_lon,
      lengthM: EDDS_07.length_m,
      fallbackHeadingDeg: 252,
    });
    expect(heading).toBeCloseTo(253.9, 1);
  });

  it('UUEE 06L: 64° магнитный → ≈75.1° истинный', () => {
    const heading = runwayTrueHeading({
      thresholdLat: 55.980999,
      thresholdLon: 37.328899,
      endLat: 55.9884,
      endLon: 37.378502,
      lengthM: 3200,
      fallbackHeadingDeg: 64,
    });
    expect(heading).toBeCloseTo(75.1, 1);
  });

  it('нет координат дальнего торца → fallback', () => {
    expect(
      runwayTrueHeading({
        thresholdLat: EDDS_07.threshold_lat,
        thresholdLon: EDDS_07.threshold_lon,
        lengthM: EDDS_07.length_m,
        fallbackHeadingDeg: 72,
      }),
    ).toBe(72);
  });

  it('длина по координатам расходится со справочной >10% → fallback', () => {
    expect(
      runwayTrueHeading({
        thresholdLat: EDDS_07.threshold_lat,
        thresholdLon: EDDS_07.threshold_lon,
        endLat: EDDS_07.end_lat,
        endLon: EDDS_07.end_lon,
        lengthM: 10_000,
        fallbackHeadingDeg: 72,
      }),
    ).toBe(72);
  });

  it('точка на осевой EDDS 07 → |cross| < 0.5 м (фантомные 28.6 м устранены)', () => {
    const geometry = computeTouchdownGeometry(alongRunway(EDDS_07, 600), EDDS_07);
    expect(geometry).not.toBeNull();
    expect(geometry!.centreline_offset_m).toBeLessThan(0.5);
    expect(geometry!.distance_from_threshold_m).toBeCloseTo(600, 0);
    expect(geometry!.touchdown_zone).toBe('TDZ');
  });

  it('buildTouchdownPoint: heading_deg_true — истинный курс из координат', () => {
    const geometry = computeTouchdownGeometry(alongRunway(EDDS_07, 600), EDDS_07);
    const point = buildTouchdownPoint(geometry, EDDS_07);
    expect(point?.heading_deg_true).toBeCloseTo(73.9, 1);
  });
});

describe('reconcileTouchdownGeometry (R-01 residual)', () => {
  it('геометрия трека совпадает с событием — без флага, метрики из трека', () => {
    const fix = { latitude: latOffsetM(100), longitude: lonOffsetM(6.5) };
    const event = metrics({ centreline_offset_m: 6.5, touchdown_zone: 'TDZ' });
    const result = reconcileTouchdownGeometry(event, fix, RUNWAY);
    expect(result.applied).toBe(true);
    expect(result.eventContradicts).toBe(false);
    expect(result.flags).toBe(0);
    expect(result.metrics.centreline_offset_m).toBeCloseTo(6.5, 1);
    expect(result.metrics.touchdown_zone).toBe('TDZ');
  });

  it('событие расходится с треком — SLEW, метрики из трека', () => {
    // Реальное смещение 25 м, событие заявляет 0 — накрутка.
    const fix = { latitude: latOffsetM(100), longitude: lonOffsetM(25) };
    const event = metrics({ centreline_offset_m: 0, touchdown_zone: 'TDZ' });
    const result = reconcileTouchdownGeometry(event, fix, RUNWAY);
    expect(result.eventContradicts).toBe(true);
    expect(result.flags & QUALITY_BITS.SLEW).toBe(QUALITY_BITS.SLEW);
    expect(result.metrics.centreline_offset_m).toBeCloseTo(25, 1);
  });

  it('расхождение зоны касания (событие TDZ, трек after) → SLEW', () => {
    const fix = { latitude: latOffsetM(1500), longitude: 0 };
    const event = metrics({ touchdown_zone: 'TDZ' });
    const result = reconcileTouchdownGeometry(event, fix, RUNWAY);
    expect(result.eventContradicts).toBe(true);
    expect(result.flags & QUALITY_BITS.SLEW).toBe(QUALITY_BITS.SLEW);
    expect(result.metrics.touchdown_zone).toBe('after');
  });

  it('небольшое расхождение offset в пределах допуска — не флаг', () => {
    const fix = { latitude: latOffsetM(100), longitude: lonOffsetM(3) };
    const event = metrics({ centreline_offset_m: 0, touchdown_zone: 'TDZ' });
    const result = reconcileTouchdownGeometry(event, fix, RUNWAY);
    expect(result.eventContradicts).toBe(false);
    expect(result.flags).toBe(0);
  });

  it('нет геометрии ВПП → фолбэк на событие без ложного флага', () => {
    const event = metrics({ centreline_offset_m: 0, touchdown_zone: 'TDZ' });
    const result = reconcileTouchdownGeometry(event, { latitude: 0, longitude: 0 }, null);
    expect(result.applied).toBe(false);
    expect(result.geometry).toBeNull();
    expect(result.eventContradicts).toBe(false);
    expect(result.flags).toBe(0);
    expect(result.metrics).toEqual(event);
  });

  it('нет точки касания (неподтверждённая посадка) → фолбэк на событие', () => {
    const event = metrics({ centreline_offset_m: 12.5 });
    const result = reconcileTouchdownGeometry(event, null, RUNWAY);
    expect(result.applied).toBe(false);
    expect(result.flags).toBe(0);
    expect(result.metrics.centreline_offset_m).toBe(12.5);
  });

  it('событие без геометрических полей → метрики только из трека', () => {
    const fix = { latitude: latOffsetM(100), longitude: lonOffsetM(20) };
    const event = metrics();
    const result = reconcileTouchdownGeometry(event, fix, RUNWAY);
    expect(result.eventContradicts).toBe(false);
    expect(result.flags).toBe(0);
    expect(result.metrics.centreline_offset_m).toBeCloseTo(20, 1);
    expect(result.metrics.touchdown_zone).toBe('TDZ');
  });
});

describe('buildTouchdownPoint (server-side runway geometry)', () => {
  const runway = { ...RUNWAY, width_m: 45 };

  it('строит signed X/Z, aiming point и дистанции от порога', () => {
    const geometry = computeTouchdownGeometry(
      { latitude: 0, longitude: lonOffsetM(400) },
      { ...runway, heading_deg: 90 },
    );
    const point = buildTouchdownPoint(geometry, { ...runway, heading_deg: 90 });
    expect(point).toMatchObject({
      relative_x_m: 0,
      relative_z_m: 400,
      aiming_x_m: 0,
      aiming_z_m: 300,
      start_distance_m: 400,
      end_distance_m: 2600,
      heading_deg_true: 90,
      length_m: 3000,
      width_m: 45,
    });
    expect(isTouchdownOnRunway(geometry, runway)).toBe(true);
  });

  it('сохраняет знак бокового смещения (справа — +)', () => {
    const geometry = computeTouchdownGeometry(
      { latitude: 0, longitude: lonOffsetM(8) },
      RUNWAY,
    );
    const point = buildTouchdownPoint(geometry, { ...RUNWAY, width_m: 45 });
    expect(point?.relative_x_m).toBeCloseTo(8, 1);
  });

  it('касание до порога — отрицательный relative_z и start_distance', () => {
    const geometry = computeTouchdownGeometry(
      { latitude: latOffsetM(-120), longitude: 0 },
      RUNWAY,
    );
    const point = buildTouchdownPoint(geometry, { ...RUNWAY, width_m: 45 });
    expect(point?.relative_z_m).toBeCloseTo(-120, 0);
    expect(point?.start_distance_m).toBeCloseTo(-120, 0);
    expect(point?.end_distance_m).toBeCloseTo(3120, 0);
    expect(isTouchdownOnRunway(geometry, { ...RUNWAY, width_m: 45 })).toBe(false);
  });

  it('без порога/длины → null (не фабрикуем координаты)', () => {
    expect(buildTouchdownPoint(null, RUNWAY)).toBeNull();
    expect(
      buildTouchdownPoint(computeTouchdownGeometry({ latitude: 0, longitude: 0 }, RUNWAY), null),
    ).toBeNull();
  });

  it('aiming point не выходит за пределы короткой полосы', () => {
    const short = { ...RUNWAY, length_m: 200, width_m: 45 };
    const geometry = computeTouchdownGeometry({ latitude: latOffsetM(100), longitude: 0 }, short);
    const point = buildTouchdownPoint(geometry, short);
    expect(point?.aiming_z_m).toBe(199);
  });
});
