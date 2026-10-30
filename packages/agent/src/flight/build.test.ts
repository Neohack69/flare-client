import {
  TRACK_G_MAX,
  TRACK_REAL_SAFE_MAX,
  TRACK_SPEED_MAX_KT,
  flightEventSchema,
  trackPointSchema,
} from '@flightlog/contracts';
import { describe, expect, it } from 'vitest';

import { normalizeHeading, toFlightEvent, toTrackPoint } from './build.js';
import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';
import { seededUuidGenerator } from '../util/id.js';

const TS = isoAt(BASE_MS, 0);
const nextClientPointId = seededUuidGenerator();

describe('toTrackPoint', () => {
  it('формирует валидный TrackPoint по схеме contracts', () => {
    const sample = makeSample(TS, {
      lat: 55.972,
      lon: 37.414,
      alt_ft: 850.4,
      agl_ft: 120.2,
      gs_kt: 145.6,
      ias_kt: 140.1,
      vs_fpm: -650.4,
      heading_deg: 245.1,
      pitch_deg: 2.1,
      bank_deg: -0.4,
      g: 1.02,
      on_ground: false,
    });
    const point = toTrackPoint(sample, 1, { clientPointId: nextClientPointId() });

    expect(trackPointSchema.safeParse(point).success).toBe(true);
    expect(point.seq).toBe(1);
    expect(point.vs_fpm).toBe(-650);
    expect(point.quality).toBe(0);
  });

  it('нормализует heading и отбрасывает nullish-опции', () => {
    const point = toTrackPoint(
      makeSample(TS, { heading_deg: 370, agl_ft: null, ias_kt: null, vs_fpm: null }),
      7,
      { clientPointId: nextClientPointId() },
    );
    expect(point.heading_deg).toBe(10);
    expect(point.agl_ft).toBeUndefined();
    expect(point.ias_kt).toBeUndefined();
    expect(point.vs_fpm).toBeUndefined();
  });

  it('санитизирует выходящие за схему значения', () => {
    const point = toTrackPoint(
      makeSample(TS, { pitch_deg: 120, bank_deg: 200, gs_kt: -3, g: -1 }),
      1,
      { clientPointId: nextClientPointId() },
    );
    expect(point.pitch_deg).toBe(90);
    expect(point.bank_deg).toBe(180);
    expect(point.gs_kt).toBe(0);
    expect(point.g).toBe(0);
  });

  it('обнуляет денормализованные и не-конечные значения (регресс: float4 underflow)', () => {
    const point = toTrackPoint(
      makeSample(TS, {
        lat: 1.8e-43,
        lon: -1.8e-43,
        alt_ft: 1.8e-43,
        agl_ft: 1.8e-43,
        gs_kt: 1.8e-43,
        ias_kt: 1.8e-43,
        vs_fpm: 1.8e-43,
        heading_deg: 1.8e-43,
        pitch_deg: Number.NaN,
        bank_deg: Number.POSITIVE_INFINITY,
        g: 1.8e-43,
        wind_dir_deg: 1.8e-43,
        wind_speed_kt: Number.NaN,
        temp_c: 1.8e-43,
        qnh_hpa: 1.8e-43,
        precip: 1.8e-43,
        visibility_m: 1.8e-43,
      }),
      1,
      { clientPointId: nextClientPointId() },
    );

    expect(trackPointSchema.safeParse(point).success).toBe(true);
    expect(point).toMatchObject({
      lat: 0,
      lon: 0,
      alt_ft: 0,
      agl_ft: 0,
      gs_kt: 0,
      ias_kt: 0,
      vs_fpm: 0,
      heading_deg: 0,
      pitch_deg: 0,
      bank_deg: 0,
      g: 0,
      wind_dir_deg: 0,
      temp_c: 0,
      qnh_hpa: 0,
      precip: 0,
      visibility_m: 0,
    });
    expect(point.wind_speed_kt).toBeUndefined();
  });

  it('зажимает большие значения в безопасный диапазон real', () => {
    const point = toTrackPoint(makeSample(TS, { alt_ft: 1e300, gs_kt: 1e300, g: 1e300 }), 1, {
      clientPointId: nextClientPointId(),
    });
    expect(trackPointSchema.safeParse(point).success).toBe(true);
    expect(point.alt_ft).toBe(TRACK_REAL_SAFE_MAX);
    expect(point.gs_kt).toBe(TRACK_SPEED_MAX_KT);
    expect(point.g).toBe(TRACK_G_MAX);
  });

  it('помечает slew-сэмплы качеством > 0', () => {
    const point = toTrackPoint(makeSample(TS, { slew: true }), 1, {
      clientPointId: nextClientPointId(),
      quality: 1,
    });
    expect(point.quality).toBe(1);
  });

  it('переносит погоду из сэмпла (SimVar → TrackPoint)', () => {
    const point = toTrackPoint(
      makeSample(TS, {
        wind_dir_deg: 250,
        wind_speed_kt: 14.5,
        temp_c: 12.3,
        qnh_hpa: 1012,
        precip: 4,
        visibility_m: 8000,
      }),
      1,
      { clientPointId: nextClientPointId() },
    );
    expect(trackPointSchema.safeParse(point).success).toBe(true);
    expect(point).toMatchObject({
      wind_dir_deg: 250,
      wind_speed_kt: 14.5,
      temp_c: 12.3,
      qnh_hpa: 1012,
      precip: 4,
      visibility_m: 8000,
      wind_gust_kt: undefined,
    });
  });

  it('без погоды поля точки остаются пустыми (обратная совместимость)', () => {
    const point = toTrackPoint(makeSample(TS), 1, { clientPointId: nextClientPointId() });
    expect(point.wind_dir_deg).toBeUndefined();
    expect(point.wind_speed_kt).toBeUndefined();
    expect(point.temp_c).toBeUndefined();
  });
});

describe('normalizeHeading', () => {
  it.each([
    [0, 0],
    [360, 0],
    [370, 10],
    [-10, 350],
    [720.5, 0.5],
  ])('%s° → %s°', (input, expected) => {
    expect(normalizeHeading(input)).toBeCloseTo(expected);
  });
});

describe('toFlightEvent', () => {
  it('формирует валидный FlightEvent по схеме contracts', () => {
    const event = toFlightEvent(
      'touchdown',
      makeSample(TS),
      { vs_fpm: -142, g: 1.3 },
      '123e4567-e89b-42d3-a456-426614174000',
      2,
    );
    expect(flightEventSchema.safeParse(event).success).toBe(true);
    expect(event.type).toBe('touchdown');
    expect(event.severity).toBe(2);
    expect(event.data).toEqual({ vs_fpm: -142, g: 1.3 });
  });

  it('бросает ошибку на невалидный client_event_id', () => {
    expect(() => toFlightEvent('taxi', makeSample(TS), {}, 'not-a-uuid')).toThrow();
  });
});
