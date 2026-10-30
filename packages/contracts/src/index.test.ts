import { describe, expect, it } from 'vitest';

import {
  activityResponseSchema,
  aircraftCategorySchema,
  aircraftModelKeySchema,
  aircraftSummarySchema,
  devicePreviewRequestSchema,
  devicePreviewResponseSchema,
  embeddedScoreSchema,
  flightCreateSchema,
  flightSchema,
  landingMetricsResponseSchema,
  landingMetricsSchema,
  landingScoreSchema,
  landingSummarySchema,
  problemDetailSchema,
  QUALITY_BITS,
  registerSchema,
  safetyHistoryPointSchema,
  safetyHistoryQuerySchema,
  safetyHistoryResponseSchema,
  schemas,
  trackPointSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './index';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = '2026-09-23T12:34:56Z';

describe('contracts — примитивы', () => {
  it('валидирует UTC-даты и отклоняет non-UTC', () => {
    expect(utcDateTimeSchema.safeParse(NOW).success).toBe(true);
    expect(utcDateTimeSchema.safeParse('2026-09-23T12:34:56.000Z').success).toBe(true);
    expect(utcDateTimeSchema.safeParse('2026-09-23T12:34:56+05:00').success).toBe(false);
    expect(utcDateTimeSchema.safeParse('2026-09-23T12:34:56').success).toBe(false);
  });

  it('валидирует UUID v4 и отклоняет не-v4', () => {
    expect(uuidSchema.safeParse(UUID).success).toBe(true);
    expect(uuidSchema.safeParse('123e4567-e89b-12d3-a456-426614174000').success).toBe(false);
    expect(uuidSchema.safeParse('not-a-uuid').success).toBe(false);
  });
});

describe('contracts — flight/track', () => {
  it('принимает валидный POST /flights и отбрасывает неизвестные поля (forward-compat §13.3)', () => {
    const valid = {
      client_flight_id: UUID,
      aircraft_icao: 'B738',
      origin_icao: 'UUEE',
      destination_icao: 'ULLI',
      started_at: NOW,
      device_id: UUID,
    };
    expect(flightCreateSchema.safeParse(valid).success).toBe(true);

    const withExtra = { ...valid, foo: 1 };
    const parsed = flightCreateSchema.safeParse(withExtra);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).not.toHaveProperty('foo');
  });

  it('отклоняет некорректный ICAO-код аэропорта', () => {
    const bad = {
      client_flight_id: UUID,
      aircraft_icao: 'B738',
      origin_icao: 'MOSCOW',
      started_at: NOW,
    };
    expect(flightCreateSchema.safeParse(bad).success).toBe(false);
  });

  it('валидирует диапазоны lat/lon и finite у track point', () => {
    const valid = {
      client_point_id: UUID,
      seq: 1,
      ts: NOW,
      lat: 55.972,
      lon: 37.414,
      alt_ft: 850,
      gs_kt: 145,
      heading_deg: 245.1,
      pitch_deg: 2.1,
      bank_deg: -0.4,
      g: 1.02,
      on_ground: false,
    };
    expect(trackPointSchema.safeParse(valid).success).toBe(true);
    expect(trackPointSchema.safeParse({ ...valid, lat: 91 }).success).toBe(false);
    expect(trackPointSchema.safeParse({ ...valid, lon: -181 }).success).toBe(false);
    expect(trackPointSchema.safeParse({ ...valid, g: NaN }).success).toBe(false);
    // quality имеет default 0
    expect(trackPointSchema.parse(valid).quality).toBe(0);
  });

  it('требует client_point_id (UUID v4) у track point', () => {
    const withoutId = {
      seq: 1,
      ts: NOW,
      lat: 55.972,
      lon: 37.414,
      alt_ft: 850,
      gs_kt: 145,
      heading_deg: 245.1,
      pitch_deg: 2.1,
      bank_deg: -0.4,
      g: 1.02,
      on_ground: false,
    };
    expect(trackPointSchema.safeParse(withoutId).success).toBe(false);
    expect(trackPointSchema.safeParse({ ...withoutId, client_point_id: 'bad' }).success).toBe(
      false,
    );
  });

  it('применяет quality-флаги рейса по умолчанию и принимает битовую маску', () => {
    const parsed = flightSchema.parse({
      id: UUID,
      user_id: UUID,
      device_id: null,
      client_flight_id: UUID,
      aircraft_icao: 'B738',
      callsign: null,
      origin_icao: null,
      destination_icao: null,
      started_at: NOW,
      server_received_at: NOW,
      ended_at: null,
      duration_s: null,
      distance_m: null,
      max_altitude_ft: null,
      touchdown_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
    expect(parsed.paused_total_s).toBe(0);
    expect(parsed.is_partial).toBe(false);
    expect(parsed.leaderboard_eligible).toBe(true);
    expect(parsed.quality_flags).toBe(0);

    const masked = flightSchema.parse({
      ...parsed,
      quality_flags: QUALITY_BITS.LOW_RATE_WINDOW | QUALITY_BITS.GAP_BEFORE,
      is_partial: true,
      leaderboard_eligible: false,
    });
    expect(masked.quality_flags).toBe(24);
  });

  it('применяет default-ы на flight (status/visibility/point_count)', () => {
    const parsed = flightSchema.parse({
      id: UUID,
      user_id: UUID,
      device_id: null,
      client_flight_id: UUID,
      aircraft_icao: 'B738',
      callsign: null,
      origin_icao: null,
      destination_icao: null,
      started_at: NOW,
      server_received_at: NOW,
      ended_at: null,
      duration_s: null,
      distance_m: null,
      max_altitude_ft: null,
      touchdown_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
    expect(parsed.status).toBe('in_progress');
    expect(parsed.visibility).toBe('private');
    expect(parsed.point_count).toBe(0);
  });
});

describe('contracts — aircraft catalog (ADR-0009)', () => {
  it('валидирует AircraftSummary и отклоняет неизвестные поля (strict)', () => {
    const summary = {
      icao_type: 'B738',
      manufacturer: 'Boeing',
      model: '737-800',
      category: 'narrowbody',
      model_key: 'narrowbody_b738',
      length_m: 39.5,
      wingspan_m: 35.8,
      height_m: 12.5,
      engines: 2,
      engine_type: 'jet',
      wing_config: 'low_wing',
      vs_soft_fpm: -250,
      vs_hard_fpm: -700,
    };
    expect(aircraftSummarySchema.safeParse(summary).success).toBe(true);
    expect(aircraftSummarySchema.safeParse({ ...summary, model_key: 'unknown_key' }).success).toBe(
      false,
    );
    expect(aircraftSummarySchema.safeParse({ ...summary, category: 'spaceship' }).success).toBe(
      false,
    );
    expect(aircraftSummarySchema.safeParse({ ...summary, extra: 1 }).success).toBe(false);
  });

  it('принимает unknown-объект (ZZZZ) с null-полями', () => {
    const unknown = {
      icao_type: 'ZZZZ',
      manufacturer: null,
      model: null,
      category: 'unknown',
      model_key: null,
      length_m: null,
      wingspan_m: null,
      height_m: null,
      engines: null,
      engine_type: null,
      wing_config: null,
      vs_soft_fpm: null,
      vs_hard_fpm: null,
    };
    expect(aircraftSummarySchema.safeParse(unknown).success).toBe(true);
  });

  it('category/model_key — закрытые наборы', () => {
    expect(aircraftCategorySchema.options).toContain('very_large');
    expect(aircraftModelKeySchema.options).toContain('widebody_b747');
    expect(aircraftModelKeySchema.options).toContain('ga_single_c172');
  });

  it('flightSchema: aircraft аддитивен, по умолчанию null', () => {
    const parsed = flightSchema.parse({
      id: UUID,
      user_id: UUID,
      device_id: null,
      client_flight_id: UUID,
      aircraft_icao: 'B738',
      callsign: null,
      origin_icao: null,
      destination_icao: null,
      started_at: NOW,
      server_received_at: NOW,
      ended_at: null,
      duration_s: null,
      distance_m: null,
      max_altitude_ft: null,
      touchdown_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
    expect(parsed.aircraft).toBeNull();

    const withAircraft = flightSchema.parse({
      ...parsed,
      aircraft: {
        icao_type: 'B738',
        manufacturer: 'Boeing',
        model: '737-800',
        category: 'narrowbody',
        model_key: 'narrowbody_b738',
        length_m: 39.5,
        wingspan_m: 35.8,
        height_m: 12.5,
        engines: 2,
        engine_type: 'jet',
        wing_config: 'low_wing',
        vs_soft_fpm: -250,
        vs_hard_fpm: -700,
      },
    });
    expect(withAircraft.aircraft?.category).toBe('narrowbody');
  });

  it('flightSchema: aircraft_icao nullable — ответ с NULL валиден (T63/BUG-REG-02)', () => {
    const parsed = flightSchema.parse({
      id: UUID,
      user_id: UUID,
      device_id: null,
      client_flight_id: UUID,
      aircraft_icao: null,
      callsign: null,
      origin_icao: null,
      destination_icao: null,
      started_at: NOW,
      server_received_at: NOW,
      ended_at: null,
      duration_s: null,
      distance_m: null,
      max_altitude_ft: null,
      touchdown_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
    expect(parsed.aircraft_icao).toBeNull();
    expect(parsed.aircraft).toBeNull();
  });
});

describe('contracts — scoring/auth/errors', () => {
  it('принимает нормализованные landing metrics и score', () => {
    const metrics = {
      vs_fpm: -312,
      g_force: 1.62,
      bounce_count: 1,
      bounced: true,
    };
    expect(landingMetricsSchema.safeParse(metrics).success).toBe(true);
    expect(landingMetricsSchema.parse(metrics).bounce_count).toBe(1);

    expect(
      landingScoreSchema.safeParse({
        score: 72,
        grade: 'firm',
        components: { vertical_speed: 76.45 },
        score_version: '1.0.0',
      }).success,
    ).toBe(true);
    expect(
      landingScoreSchema.safeParse({
        score: 101,
        grade: 'firm',
        components: {},
        score_version: '1.0.0',
      }).success,
    ).toBe(false);
  });

  it('P0 data-honesty: scoring-input metrics требуют реальную VS/G (не null)', () => {
    expect(
      landingMetricsSchema.safeParse({ vs_fpm: null, g_force: null }).success,
    ).toBe(false);
    expect(
      landingMetricsSchema.safeParse({ vs_fpm: -150, g_force: 1.2 }).success,
    ).toBe(true);
  });

  it('P0 data-honesty: response metrics допускают null (absent, не 0/1.0)', () => {
    const parsed = landingMetricsResponseSchema.parse({ vs_fpm: null, g_force: null });
    expect(parsed.vs_fpm).toBeNull();
    expect(parsed.g_force).toBeNull();
    // Числовое значение по-прежнему принимается без изменений.
    expect(landingMetricsResponseSchema.parse({ vs_fpm: -114, g_force: 1.2 }).vs_fpm).toBe(-114);
  });

  it('P0 data-honesty: landingSummary принимает посадку без измеренной VS', () => {
    const base = {
      id: UUID,
      seq: 1,
      touchdown_at: NOW,
      touch_and_go: false,
      ground_contact_s: null,
      score: 88,
      grade: 'good',
      components: { vertical_speed: 0, g_force: 0 },
      score_version: '1.0.0',
      segmentation_version: '1.2.0',
      confidence: 1,
      eligible: false,
      verified: true,
      quality_flags: 0,
    } as const;
    const nullMetrics = landingSummarySchema.safeParse({
      ...base,
      metrics: { vs_fpm: null, g_force: null },
    });
    expect(nullMetrics.success).toBe(true);
    expect(nullMetrics.success && nullMetrics.data.metrics.vs_fpm).toBeNull();

    const embedded = embeddedScoreSchema.safeParse({
      score: 88,
      grade: 'good',
      score_version: '1.0.0',
      components: { vertical_speed: 0 },
      confidence: null,
      eligible: false,
      metrics: { vs_fpm: null, g_force: null },
    });
    expect(embedded.success).toBe(true);
    expect(embedded.success && embedded.data.metrics.g_force).toBeNull();
  });

  it('валидирует register (email/password)', () => {
    expect(
      registerSchema.safeParse({
        email: 'a@b.co',
        password: 'longenough',
        display_name: 'Ivan',
        handle: 'ivan',
      })
        .success,
    ).toBe(true);
    expect(
      registerSchema.safeParse({ email: 'bad', password: 'short', display_name: 'Ivan' }).success,
    ).toBe(false);
  });

  it('валидирует preview устройства (F-103) и делает user_code обязательным', () => {
    expect(devicePreviewRequestSchema.safeParse({ user_code: 'WXYZ-1234' }).success).toBe(true);
    expect(devicePreviewRequestSchema.safeParse({ user_code: 'nope' }).success).toBe(false);
    expect(devicePreviewRequestSchema.safeParse({}).success).toBe(false);

    const preview = {
      client_name: 'Домашний ПК',
      platform: 'win32',
      expires_at: NOW,
      status: 'pending',
    };
    expect(devicePreviewResponseSchema.safeParse(preview).success).toBe(true);
    expect(devicePreviewResponseSchema.safeParse({ ...preview, platform: null }).success).toBe(true);
    expect(devicePreviewResponseSchema.safeParse({ ...preview, status: 'approved' }).success).toBe(
      false,
    );
    // device_code не должен попадать в preview-ответ (strict).
    expect(devicePreviewResponseSchema.safeParse({ ...preview, device_code: 'x' }).success).toBe(
      false,
    );
  });

  it('валидирует RFC 7807 problem detail', () => {
    expect(
      problemDetailSchema.safeParse({
        type: 'https://api.flightlog.app/problems/validation-error',
        title: 'Validation failed',
        status: 422,
        code: 'VALIDATION_ERROR',
        detail: 'track.points[3].ts must be ISO-8601',
        instance: '/v1/flights/8f/track/batch',
        trace_id: '01J',
        errors: [{ path: 'track.points[3].ts', message: 'must be ISO-8601' }],
      }).success,
    ).toBe(true);
  });
});

describe('contracts — schemas namespace (gamification)', () => {
  it('safetyHistory* и activity* схемы зарегистрированы в `schemas`', () => {
    expect(schemas.safetyHistoryPointSchema).toBe(safetyHistoryPointSchema);
    expect(schemas.safetyHistoryQuerySchema).toBe(safetyHistoryQuerySchema);
    expect(schemas.safetyHistoryResponseSchema).toBe(safetyHistoryResponseSchema);
    expect(schemas.activityResponseSchema).toBe(activityResponseSchema);
  });
});
