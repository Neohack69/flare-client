import { describe, expect, it } from 'vitest';

import {
  TELEMETRY_SANITY_LIMITS,
  TRACK_SANITY_LIMITS,
  assessTrackSanity,
  checkTelemetrySample,
  isImplausibleTrack,
  isPlausibleCoordinate,
} from './telemetry-sanity.js';

const OK_SAMPLE = {
  lat: 55.972,
  lon: 37.414,
  alt_ft: 850,
  agl_ft: 120,
  gs_kt: 145,
  ias_kt: 140,
  vs_fpm: -650,
} as const;

describe('isPlausibleCoordinate', () => {
  it('принимает реальные координаты', () => {
    expect(isPlausibleCoordinate(55.972, 37.414)).toBe(true);
    expect(isPlausibleCoordinate(-33.94, 151.18)).toBe(true);
    expect(isPlausibleCoordinate(0.5, -180)).toBe(true);
  });

  it('отбрасывает null island и sentinel-паттерны', () => {
    expect(isPlausibleCoordinate(0, 0)).toBe(false);
    expect(isPlausibleCoordinate(0, 90)).toBe(false); // прод-инцидент: lat 0 / lon 90
    expect(isPlausibleCoordinate(0, -90)).toBe(false);
    expect(isPlausibleCoordinate(0.0004, 0.0004)).toBe(false);
    expect(isPlausibleCoordinate(0.0004, 90.0004)).toBe(false);
    expect(isPlausibleCoordinate(0, 45)).toBe(false); // точный lat === 0
    expect(isPlausibleCoordinate(45, 90)).toBe(false); // точный lon === ±90
  });

  it('отбрасывает выход за диапазон и нечисловые значения', () => {
    expect(isPlausibleCoordinate(90.0001, 0)).toBe(false);
    expect(isPlausibleCoordinate(0, 180.0001)).toBe(false);
    expect(isPlausibleCoordinate(Number.NaN, 0)).toBe(false);
    expect(isPlausibleCoordinate(0, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('checkTelemetrySample', () => {
  it('принимает правдоподобный кадр', () => {
    expect(checkTelemetrySample(OK_SAMPLE)).toEqual({ ok: true, reason: null });
    expect(checkTelemetrySample({ ...OK_SAMPLE, agl_ft: null, ias_kt: null, vs_fpm: null }).ok).toBe(
      true,
    );
  });

  it('отбрасывает null island с указанием причины', () => {
    const result = checkTelemetrySample({ ...OK_SAMPLE, lat: 0, lon: 90 });
    expect(result).toEqual({ ok: false, reason: 'null_island' });
  });

  it('отбрасывает нечисловые обязательные поля', () => {
    expect(checkTelemetrySample({ ...OK_SAMPLE, lat: Number.NaN }).reason).toBe(
      'lat_lon_non_finite',
    );
    expect(checkTelemetrySample({ ...OK_SAMPLE, alt_ft: Number.POSITIVE_INFINITY }).reason).toBe(
      'alt_non_finite',
    );
    expect(checkTelemetrySample({ ...OK_SAMPLE, gs_kt: Number.NaN }).reason).toBe('gs_non_finite');
    expect(checkTelemetrySample({ ...OK_SAMPLE, vs_fpm: Number.NaN }).reason).toBe('vs_non_finite');
  });

  it('отбрасывает неабсурдные по модулю значения выше потолков', () => {
    expect(checkTelemetrySample({ ...OK_SAMPLE, alt_ft: 60_001 }).reason).toBe('alt_out_of_range');
    expect(checkTelemetrySample({ ...OK_SAMPLE, agl_ft: 60_001 }).reason).toBe('agl_out_of_range');
    expect(checkTelemetrySample({ ...OK_SAMPLE, gs_kt: 1_501 }).reason).toBe('gs_out_of_range');
    expect(checkTelemetrySample({ ...OK_SAMPLE, ias_kt: 2_001 }).reason).toBe('ias_out_of_range');
    expect(checkTelemetrySample({ ...OK_SAMPLE, alt_ft: -60_001 }).reason).toBe(
      'alt_out_of_range',
    );
  });

  it('границы диапазонов включительны', () => {
    expect(checkTelemetrySample({ ...OK_SAMPLE, alt_ft: 60_000 }).ok).toBe(true);
    expect(checkTelemetrySample({ ...OK_SAMPLE, gs_kt: 1_500 }).ok).toBe(true);
    expect(checkTelemetrySample({ ...OK_SAMPLE, ias_kt: 2_000 }).ok).toBe(true);
  });

  it('фиксирует потолки-константы', () => {
    expect(TELEMETRY_SANITY_LIMITS.maxAbsAltFt).toBe(60_000);
    expect(TELEMETRY_SANITY_LIMITS.maxGsKt).toBe(1_500);
    expect(TELEMETRY_SANITY_LIMITS.maxIasKt).toBe(2_000);
  });
});

describe('assessTrackSanity / isImplausibleTrack', () => {
  const valid = { lat: 25.267, lon: 51.613 };

  it('пустой трек не считается неправдоподобным (нет данных ≠ мусор)', () => {
    const assessment = assessTrackSanity([]);
    expect(assessment.total).toBe(0);
    expect(assessment.no_valid_coordinates).toBe(false);
    expect(isImplausibleTrack(assessment)).toBe(false);
  });

  it('трек только из null island отбрасывается', () => {
    const points = Array.from({ length: 10 }, () => ({ lat: 0, lon: 90 }));
    const assessment = assessTrackSanity(points);
    expect(assessment.no_valid_coordinates).toBe(true);
    expect(assessment.implausible_ratio).toBe(1);
    expect(isImplausibleTrack(assessment)).toBe(true);
  });

  it('валидный трек не затрагивается', () => {
    const points = Array.from({ length: 10 }, () => valid);
    const assessment = assessTrackSanity(points);
    expect(assessment.implausible_ratio).toBe(0);
    expect(isImplausibleTrack(assessment)).toBe(false);
  });

  it('несколько sentinel-точек в валидном треке не отбраковывают рейс', () => {
    const points = [
      ...Array.from({ length: 40 }, () => valid),
      ...Array.from({ length: 10 }, () => ({ lat: 0, lon: 0 })),
    ];
    const assessment = assessTrackSanity(points);
    expect(assessment.implausible_coordinates).toBe(10);
    expect(assessment.no_valid_coordinates).toBe(false);
    expect(assessment.implausible_ratio).toBeCloseTo(0.2, 5);
    expect(isImplausibleTrack(assessment)).toBe(false);
  });

  it('порог доли высокий: рейс с горсткой sentinel-точек сохраняется', () => {
    // Регресс BUG-track-route: 35 bogus-точек старта + 10 реальных (≈78 % мусора).
    const da62 = [
      ...Array.from({ length: 35 }, () => ({ lat: -2.15e-7, lon: 90.0003 })),
      ...Array.from({ length: 10 }, () => valid),
    ];
    const assessment = assessTrackSanity(da62);
    expect(assessment.implausible_ratio).toBeCloseTo(35 / 45, 5);
    expect(isImplausibleTrack(assessment)).toBe(false);
  });

  it('порог доли строгий: 90% проходит, больше — отбраковка', () => {
    const atThreshold = [
      ...Array.from({ length: 20 }, () => valid),
      ...Array.from({ length: 180 }, () => ({ lat: 0, lon: 0 })),
    ];
    expect(assessTrackSanity(atThreshold).implausible_ratio).toBe(
      TRACK_SANITY_LIMITS.maxImplausibleRatio,
    );
    expect(isImplausibleTrack(assessTrackSanity(atThreshold))).toBe(false);

    const majority = [
      ...Array.from({ length: 9 }, () => valid),
      ...Array.from({ length: 191 }, () => ({ lat: 0, lon: 0 })),
    ];
    expect(isImplausibleTrack(assessTrackSanity(majority))).toBe(true);
  });
});
