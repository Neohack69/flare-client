import { describe, expect, it } from 'vitest';

import {
  touchdownPreviewRequestSchema,
  touchdownPreviewResponseSchema,
  type TouchdownPreviewResponse,
} from './touchdown-preview.js';

function validRequest(): Record<string, unknown> {
  return {
    seq: 1,
    touchdown_at: '2026-10-15T12:00:00.000Z',
    lat: 59.8,
    lon: 30.27,
    heading_deg: 280,
    vs_fpm: -135,
    g_force: 1.24,
    pitch_deg: 5.5,
    bank_deg: -1.2,
    bounce_count: 0,
    aircraft_icao: 'B738',
    runway_icao: '28R',
    airport_icao: 'ULLI',
  };
}

function validResponse(): TouchdownPreviewResponse {
  return {
    data: {
      seq: 1,
      score: 84,
      grade: 'good',
      components: { vertical_speed: 95, g_force: 90, centreline: 80 },
      score_version: '1.0.0',
      segmentation_version: '1.1.0',
      preliminary: true,
      resolved: true,
      runway: {
        airport_icao: 'ULLI',
        designator: '28R',
        length_m: 3780,
        width_m: 60,
        heading_deg: 280,
        source: 'ourairports',
      },
      metrics: {
        vs_fpm: -135,
        g_force: 1.24,
        bounce_count: 0,
        bounced: false,
        centreline_offset_m: 4.2,
        touchdown_zone: 'TDZ',
      },
    },
  };
}

describe('contracts — touchdown-preview', () => {
  it('accepts a valid request; applies bounce_count default', () => {
    const parsed = touchdownPreviewRequestSchema.parse({
      seq: 2,
      touchdown_at: '2026-10-15T12:00:00.000Z',
      lat: 1,
      lon: 2,
      heading_deg: 0,
      vs_fpm: -100,
      g_force: 1.1,
    });
    expect(parsed.bounce_count).toBe(0);
    expect(parsed.pitch_deg).toBeUndefined();
  });

  it('accepts the full request with null-ish optional geometry', () => {
    const parsed = touchdownPreviewRequestSchema.parse({
      ...validRequest(),
      pitch_deg: null,
      bank_deg: null,
      runway_icao: null,
      airport_icao: null,
      aircraft_icao: null,
    });
    expect(parsed.pitch_deg).toBeNull();
    expect(parsed.runway_icao).toBeNull();
  });

  it('accepts heading_deg: null (sparse window < 3 valid samples)', () => {
    const parsed = touchdownPreviewRequestSchema.parse({
      ...validRequest(),
      heading_deg: null,
    });
    expect(parsed.heading_deg).toBeNull();
  });

  it('rejects client geometry fields (strict): geometry is server-computed only (R4)', () => {
    expect(
      touchdownPreviewRequestSchema.safeParse({ ...validRequest(), centreline_offset_m: 0 }).success,
    ).toBe(false);
    expect(
      touchdownPreviewRequestSchema.safeParse({ ...validRequest(), touchdown_zone: 'TDZ' }).success,
    ).toBe(false);
  });

  it('rejects out-of-range lat/lon/vs/g and bad seq', () => {
    expect(touchdownPreviewRequestSchema.safeParse({ ...validRequest(), lat: 91 }).success).toBe(false);
    expect(touchdownPreviewRequestSchema.safeParse({ ...validRequest(), lon: -181 }).success).toBe(false);
    expect(touchdownPreviewRequestSchema.safeParse({ ...validRequest(), vs_fpm: -6001 }).success).toBe(false);
    expect(touchdownPreviewRequestSchema.safeParse({ ...validRequest(), g_force: 6 }).success).toBe(false);
    expect(touchdownPreviewRequestSchema.safeParse({ ...validRequest(), bounce_count: 65 }).success).toBe(false);
    expect(touchdownPreviewRequestSchema.safeParse({ ...validRequest(), seq: 0 }).success).toBe(false);
    expect(touchdownPreviewRequestSchema.safeParse({ ...validRequest(), heading_deg: 361 }).success).toBe(false);
  });

  it('rejects bad runway_icao / aircraft_icao / timestamp and unknown keys (strict)', () => {
    expect(touchdownPreviewRequestSchema.safeParse({ ...validRequest(), runway_icao: '' }).success).toBe(false);
    expect(touchdownPreviewRequestSchema.safeParse({ ...validRequest(), runway_icao: '123456789' }).success).toBe(false);
    expect(touchdownPreviewRequestSchema.safeParse({ ...validRequest(), aircraft_icao: 'X' }).success).toBe(false);
    expect(
      touchdownPreviewRequestSchema.safeParse({ ...validRequest(), touchdown_at: '2026-10-15 12:00' }).success,
    ).toBe(false);
    expect(
      touchdownPreviewRequestSchema.safeParse({ ...validRequest(), runway_icao: '28R', extra: 1 }).success,
    ).toBe(false);
  });

  it('accepts a resolved response with runway and metrics', () => {
    expect(touchdownPreviewResponseSchema.parse(validResponse())).toEqual(validResponse());
  });

  it('accepts an unresolved response with null runway and neutral metrics', () => {
    const body = {
      data: {
        ...validResponse().data,
        score: 70,
        resolved: false,
        runway: null,
        metrics: {
          vs_fpm: -135,
          g_force: 1.24,
          bounce_count: 0,
          bounced: false,
        },
      },
    };
    expect(touchdownPreviewResponseSchema.safeParse(body).success).toBe(true);
  });

  it('rejects preliminary other than true and PII-shaped extras (strict)', () => {
    const withPreliminaryFalse = {
      ...validResponse(),
      data: { ...validResponse().data, preliminary: false },
    };
    expect(touchdownPreviewResponseSchema.safeParse(withPreliminaryFalse).success).toBe(false);

    const withPii = {
      ...validResponse(),
      data: { ...validResponse().data, email: 'a@b.c', device_id: 'x' },
    };
    expect(touchdownPreviewResponseSchema.safeParse(withPii).success).toBe(false);

    const withUnknownTop = { ...validResponse(), meta: {} };
    expect(touchdownPreviewResponseSchema.safeParse(withUnknownTop).success).toBe(false);
  });
});
