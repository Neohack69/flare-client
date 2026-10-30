import { describe, expect, it } from 'vitest';

import { trackPointSchema, type TrackPoint } from './flight.js';
import {
  TRACK_MIN_MAGNITUDE,
  TRACK_NUMBER_RULES,
  TRACK_REAL_SAFE_MAX,
  sanitizeNumber,
  sanitizeOptionalNumber,
  sanitizeRequiredNumber,
  sanitizeTrackPointNumbers,
} from './sanitize.js';

const DENORMAL = 1.8e-43;
const DENORMAL_TEXT = '0.0000000000000000000000000000000000000000001810387726327326';

const basePoint: TrackPoint = trackPointSchema.parse({
  client_point_id: '123e4567-e89b-42d3-a456-426614174000',
  seq: 1,
  ts: '2026-09-23T12:00:00.000Z',
  lat: 55.972,
  lon: 37.414,
  alt_ft: 850.4,
  agl_ft: 120.2,
  gs_kt: 145.6,
  ias_kt: 140.1,
  vs_fpm: -650,
  heading_deg: 245.1,
  pitch_deg: 2.1,
  bank_deg: -0.4,
  g: 1.02,
  on_ground: false,
  quality: 0,
});

describe('sanitizeNumber', () => {
  it('обнуляет денормализованные и вырожденно-малые значения', () => {
    expect(sanitizeNumber(DENORMAL)).toBe(0);
    expect(sanitizeNumber(Number(DENORMAL_TEXT))).toBe(0);
    expect(sanitizeNumber(1e-46)).toBe(0);
    expect(sanitizeNumber(-1e-320)).toBe(0);
    expect(sanitizeNumber(TRACK_MIN_MAGNITUDE / 2)).toBe(0);
  });

  it('NaN/±Infinity → fallback (null по умолчанию, 0 для обязательных)', () => {
    expect(sanitizeNumber(Number.NaN)).toBeNull();
    expect(sanitizeNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(sanitizeNumber(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(sanitizeNumber(Number.NaN, { fallback: 0 })).toBe(0);
    expect(sanitizeRequiredNumber(Number.POSITIVE_INFINITY, { fallback: 0 })).toBe(0);
  });

  it('сохраняет отсутствие для опциональных полей', () => {
    expect(sanitizeOptionalNumber(null, { min: 0 })).toBeUndefined();
    expect(sanitizeOptionalNumber(undefined, { min: 0 })).toBeUndefined();
    expect(sanitizeOptionalNumber(Number.NaN, { min: 0 })).toBeUndefined();
  });

  it('округляет до заданной точности', () => {
    expect(sanitizeNumber(55.97123456789, { decimals: 7 })).toBe(55.9712346);
    expect(sanitizeNumber(1.23456, { decimals: 4 })).toBe(1.2346);
    expect(sanitizeNumber(2.789, { decimals: 0 })).toBe(3);
  });

  it('зажимает в границы контракта и безопасный диапазон real', () => {
    expect(sanitizeNumber(120, { min: -90, max: 90 })).toBe(90);
    expect(sanitizeNumber(-200, { min: -180, max: 180 })).toBe(-180);
    expect(sanitizeNumber(1e300, { max: TRACK_REAL_SAFE_MAX })).toBe(TRACK_REAL_SAFE_MAX);
    expect(sanitizeNumber(-1e300, { min: -TRACK_REAL_SAFE_MAX })).toBe(-TRACK_REAL_SAFE_MAX);
    // Округление огромного числа не должно выпускать Infinity.
    expect(sanitizeNumber(1.5e308, { decimals: 1 })).toBe(TRACK_REAL_SAFE_MAX);
    expect(sanitizeNumber(-1.5e308, { decimals: 1 })).toBe(-TRACK_REAL_SAFE_MAX);
  });
});

describe('sanitizeTrackPointNumbers', () => {
  it('обнуляет вырожденные значения точки и оставляет её валидной по схеме', () => {
    const point = sanitizeTrackPointNumbers({
      ...basePoint,
      lat: DENORMAL,
      lon: -DENORMAL,
      alt_ft: DENORMAL,
      agl_ft: DENORMAL,
      gs_kt: DENORMAL,
      ias_kt: DENORMAL,
      heading_deg: DENORMAL,
      pitch_deg: DENORMAL,
      bank_deg: -DENORMAL,
      g: DENORMAL,
      wind_dir_deg: DENORMAL,
      wind_speed_kt: DENORMAL,
      wind_gust_kt: DENORMAL,
      temp_c: DENORMAL,
      qnh_hpa: DENORMAL,
      visibility_m: DENORMAL,
    });

    expect(point).toMatchObject({
      lat: 0,
      lon: 0,
      alt_ft: 0,
      agl_ft: 0,
      gs_kt: 0,
      ias_kt: 0,
      heading_deg: 0,
      pitch_deg: 0,
      bank_deg: 0,
      g: 0,
      wind_dir_deg: 0,
      wind_speed_kt: 0,
      wind_gust_kt: 0,
      temp_c: 0,
      qnh_hpa: 0,
      visibility_m: 0,
    });
    expect(trackPointSchema.safeParse(point).success).toBe(true);
  });

  it('NaN/Infinity в обязательных полях → 0, в опциональных → null', () => {
    const point = sanitizeTrackPointNumbers({
      ...basePoint,
      lat: Number.NaN,
      lon: Number.POSITIVE_INFINITY,
      alt_ft: Number.NEGATIVE_INFINITY,
      gs_kt: Number.NaN,
      g: Number.POSITIVE_INFINITY,
      wind_speed_kt: Number.NaN,
    });

    expect(point.lat).toBe(0);
    expect(point.lon).toBe(0);
    expect(point.alt_ft).toBe(0);
    expect(point.gs_kt).toBe(0);
    expect(point.g).toBe(0);
    expect(point.wind_speed_kt).toBeUndefined();
    expect(trackPointSchema.safeParse(point).success).toBe(true);
  });

  it('зажимает большие/выходящие за контракт значения', () => {
    const point = sanitizeTrackPointNumbers({
      ...basePoint,
      lat: 1e300,
      lon: -1e300,
      pitch_deg: 1e300,
      bank_deg: -1e300,
      heading_deg: 1e300,
      gs_kt: -1e300,
      vs_fpm: 1e300,
      precip: 1e300,
      quality: 1e300,
    });

    expect(point.lat).toBe(90);
    expect(point.lon).toBe(-180);
    expect(point.pitch_deg).toBe(90);
    expect(point.bank_deg).toBe(-180);
    expect(point.heading_deg).toBe(360);
    expect(point.gs_kt).toBe(0);
    expect(point.vs_fpm).toBe(TRACK_NUMBER_RULES.vs_fpm.max);
    expect(point.precip).toBe(TRACK_NUMBER_RULES.precip.max);
    expect(point.quality).toBe(TRACK_NUMBER_RULES.quality.max);
    expect(trackPointSchema.safeParse(point).success).toBe(true);
  });

  it('любое real-поле после санитизации в безопасном диапазоне float4', () => {
    const point = sanitizeTrackPointNumbers({
      ...basePoint,
      alt_ft: 1e38,
      agl_ft: -1e38,
      ias_kt: 1e38,
      temp_c: 1e38,
      qnh_hpa: 1e38,
      wind_speed_kt: -1e38,
    });
    const realFields = [
      point.lat,
      point.lon,
      point.alt_ft,
      point.agl_ft,
      point.gs_kt,
      point.ias_kt,
      point.heading_deg,
      point.pitch_deg,
      point.bank_deg,
      point.g,
      point.temp_c,
      point.qnh_hpa,
      point.wind_speed_kt,
    ].filter((value): value is number => typeof value === 'number');
    for (const value of realFields) {
      expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(value)).toBeLessThanOrEqual(TRACK_REAL_SAFE_MAX);
      expect(Math.abs(value) === 0 || Math.abs(value) >= TRACK_MIN_MAGNITUDE).toBe(true);
    }
  });
});
