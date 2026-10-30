import { describe, expect, it } from 'vitest';

import { normalizeTrackPoint, normalizeTrackPoints, trackBatchIngestSchema } from './ingest.js';
import { TRACK_G_MAX, TRACK_NUMBER_RULES, TRACK_SPEED_MAX_KT, type TrackPoint } from './index.js';

const POINT_UUID = '223e4567-e89b-42d3-a456-426614174000';
const TS = '2026-09-23T12:00:00.000Z';

function rawPoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_point_id: POINT_UUID,
    seq: 1,
    ts: TS,
    lat: 55.972,
    lon: 37.414,
    alt_ft: 850,
    gs_kt: 145,
    heading_deg: 245.1,
    pitch_deg: 2.1,
    bank_deg: -0.4,
    g: 1.02,
    on_ground: false,
    quality: 0,
    ...overrides,
  };
}

describe('normalizeTrackPoint — толерантный приём исторических точек (INC-UPLOAD1)', () => {
  it('дробный vs_fpm округляется до целого и не отбрасывает точку', () => {
    const zero = normalizeTrackPoint(rawPoint({ vs_fpm: 0.000142 }));
    expect(zero).not.toBeNull();
    expect(zero?.point.vs_fpm).toBe(0);
    expect(zero?.changed).toBe(true);

    const inFlight = normalizeTrackPoint(rawPoint({ vs_fpm: -142.3 }));
    expect(inFlight?.point.vs_fpm).toBe(-142);
    expect(inFlight?.changed).toBe(true);

    const up = normalizeTrackPoint(rawPoint({ vs_fpm: 2.7 }));
    expect(up?.point.vs_fpm).toBe(3);
  });

  it('null/отсутствие опциональных полей — не ошибка (безопасный дефолт)', () => {
    const nulled = normalizeTrackPoint(
      rawPoint({ alt_ft: null, agl_ft: null, vs_fpm: null, gs_kt: null, g: null }),
    );
    expect(nulled).not.toBeNull();
    // Обязательные в каноне поля получают безопасный дефолт.
    expect(nulled?.point.alt_ft).toBe(0);
    expect(nulled?.point.gs_kt).toBe(0);
    expect(nulled?.point.g).toBe(0);
    // Опциональные — отсутствие сохраняется (`undefined`), не «0».
    expect(nulled?.point.agl_ft).toBeUndefined();
    expect(nulled?.point.vs_fpm).toBeUndefined();

    const minimal = normalizeTrackPoint({ client_point_id: POINT_UUID, ts: TS, lat: 1, lon: 2 });
    expect(minimal).not.toBeNull();
    expect(minimal?.point.seq).toBe(1);
    expect(minimal?.point.on_ground).toBe(false);
    expect(minimal?.point.quality).toBe(0);
  });

  it('диапазоны клампятся, а не отклоняются', () => {
    const clamped = normalizeTrackPoint(
      rawPoint({
        g: 15,
        gs_kt: 1200,
        ias_kt: -5,
        heading_deg: 370,
        pitch_deg: 100,
        bank_deg: -200,
        lat: 91,
        lon: -181,
      }),
    );
    expect(clamped).not.toBeNull();
    expect(clamped?.point.g).toBe(TRACK_G_MAX);
    expect(clamped?.point.gs_kt).toBe(TRACK_SPEED_MAX_KT);
    expect(clamped?.point.ias_kt).toBe(0);
    expect(clamped?.point.pitch_deg).toBe(90);
    expect(clamped?.point.bank_deg).toBe(-180);
    expect(clamped?.point.lat).toBe(90);
    expect(clamped?.point.lon).toBe(-180);
    expect(clamped?.changed).toBe(true);
  });

  it('отрицательные значения клампятся к 0 для неотрицательных полей', () => {
    const point = normalizeTrackPoint(rawPoint({ g: -1, gs_kt: -20, quality: -3 }));
    expect(point?.point.g).toBe(0);
    expect(point?.point.gs_kt).toBe(0);
    expect(point?.point.quality).toBe(0);
  });

  it('heading/wind_dir нормализуются по кругу в [0, 360]', () => {
    expect(normalizeTrackPoint(rawPoint({ heading_deg: 370 }))?.point.heading_deg).toBe(10);
    expect(normalizeTrackPoint(rawPoint({ heading_deg: -10 }))?.point.heading_deg).toBe(350);
    expect(normalizeTrackPoint(rawPoint({ heading_deg: 720 }))?.point.heading_deg).toBe(0);
    expect(normalizeTrackPoint(rawPoint({ heading_deg: 360 }))?.point.heading_deg).toBe(360);
    expect(normalizeTrackPoint(rawPoint({ wind_dir_deg: 365 }))?.point.wind_dir_deg).toBe(5);
  });

  it('NaN/Infinity санитизируются, точка остаётся', () => {
    const point = normalizeTrackPoint(
      rawPoint({
        lat: Number.NaN,
        lon: Number.POSITIVE_INFINITY,
        alt_ft: Number.NEGATIVE_INFINITY,
        vs_fpm: Number.POSITIVE_INFINITY,
        heading_deg: Number.NaN,
        wind_speed_kt: Number.NaN,
        g: Number.POSITIVE_INFINITY,
      }),
    );
    expect(point).not.toBeNull();
    expect(point?.point.lat).toBe(0);
    expect(point?.point.lon).toBe(0);
    expect(point?.point.alt_ft).toBe(0);
    // `vs_fpm` в правилах санитайза имеет fallback 0 (целочисленная колонка):
    // не-конечное значение становится безопасным нулём, а не «пустотой».
    expect(point?.point.vs_fpm).toBe(0);
    expect(point?.point.heading_deg).toBe(0);
    expect(point?.point.g).toBe(0);
    expect(point?.changed).toBe(true);
  });

  it('огромные числа клампятся в безопасный диапазон', () => {
    const point = normalizeTrackPoint(rawPoint({ alt_ft: 1e300, temp_c: -1e300, g: 1e300 }));
    expect(point?.point.alt_ft).toBe(TRACK_NUMBER_RULES.alt_ft.max);
    expect(point?.point.temp_c).toBe(-TRACK_NUMBER_RULES.temp_c.max);
    expect(point?.point.g).toBe(TRACK_G_MAX);
  });

  it('валидная точка не меняется (изменений нет)', () => {
    const point = normalizeTrackPoint(rawPoint());
    expect(point?.changed).toBe(false);
    expect(point?.point).toMatchObject({
      lat: 55.972,
      lon: 37.414,
      alt_ft: 850,
      gs_kt: 145,
      heading_deg: 245.1,
      g: 1.02,
    });
  });

  it('неизвестные поля отбрасываются, а не отклоняют точку', () => {
    const point = normalizeTrackPoint(rawPoint({ future_metric: 42, qnh_mb: 1013 }));
    expect(point).not.toBeNull();
    expect(point?.point).not.toHaveProperty('future_metric');
    expect(point?.point).not.toHaveProperty('qnh_mb');
  });

  it('непригодная точка (нет lat/lon/ts/client_point_id) отбрасывается', () => {
    expect(normalizeTrackPoint(rawPoint({ lat: null }))).toBeNull();
    expect(normalizeTrackPoint(rawPoint({ lon: 'abc' }))).toBeNull();
    expect(normalizeTrackPoint({ client_point_id: POINT_UUID, ts: TS })).toBeNull();
    expect(normalizeTrackPoint({ ts: TS, lat: 1, lon: 2 })).toBeNull();
    expect(normalizeTrackPoint(rawPoint({ ts: 'not-a-date' }))).toBeNull();
  });
});

describe('normalizeTrackPoints / trackBatchIngestSchema — батч (INC-UPLOAD1)', () => {
  it('считает sanitized/dropped поштучно и не валит батч из-за одной битой точки', () => {
    const batch = normalizeTrackPoints([
      rawPoint({
        seq: 1,
        vs_fpm: 0.000142,
        client_point_id: 'a23e4567-e89b-42d3-a456-426614174000',
      }),
      rawPoint({ seq: 2, lat: null, client_point_id: 'b23e4567-e89b-42d3-a456-426614174000' }),
      rawPoint({ seq: 3, client_point_id: 'c23e4567-e89b-42d3-a456-426614174000' }),
    ]);
    expect(batch.points).toHaveLength(2);
    expect(batch.sanitized).toBe(1);
    expect(batch.dropped).toBe(1);
  });

  it('схема батча принимает «грязный» батч старого буфера (аналог 201)', () => {
    const parsed = trackBatchIngestSchema.safeParse({
      points: [
        rawPoint({
          seq: 1,
          vs_fpm: 0.000142,
          client_point_id: 'a23e4567-e89b-42d3-a456-426614174000',
        }),
        rawPoint({
          seq: 2,
          alt_ft: null,
          heading_deg: 370,
          g: 15,
          future_simvar: 1,
          client_point_id: 'b23e4567-e89b-42d3-a456-426614174000',
        }),
      ],
      source: 'msfs-plugin',
      version: '0.1.17',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.points).toHaveLength(2);
      expect(parsed.data.sanitized).toBe(2);
      expect(parsed.data.dropped).toBe(0);
      expect(parsed.data.source).toBe('msfs-plugin');
      expect(parsed.data.points[1]?.heading_deg).toBe(10);
      expect(parsed.data.points[1]?.g).toBe(TRACK_G_MAX);
      expect(parsed.data.points[1]).not.toHaveProperty('future_simvar');
    }
  });

  it('батч без единой пригодной точки → ошибка (несовместимость формы §13.2)', () => {
    const parsed = trackBatchIngestSchema.safeParse({
      points: [rawPoint({ lat: null }), rawPoint({ lon: 'x', seq: 2 })],
    });
    expect(parsed.success).toBe(false);
  });

  it('пустой батч и батч без points → ошибка', () => {
    expect(trackBatchIngestSchema.safeParse({ points: [] }).success).toBe(false);
    expect(trackBatchIngestSchema.safeParse({}).success).toBe(false);
  });

  it('валидные точки проходят как раньше (без изменений)', () => {
    const parsed = trackBatchIngestSchema.safeParse({ points: [rawPoint()] });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sanitized).toBe(0);
      expect(parsed.data.dropped).toBe(0);
      const point = parsed.data.points[0] as TrackPoint;
      expect(point.lat).toBe(55.972);
      expect(point.gs_kt).toBe(145);
      expect(point.vs_fpm).toBeUndefined();
    }
  });
});
