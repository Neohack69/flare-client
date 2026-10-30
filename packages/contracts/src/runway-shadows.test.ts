import { describe, expect, it } from 'vitest';

import {
  RUNWAY_SHADOWS_K_BUCKET,
  RUNWAY_SHADOWS_K_RUNWAY,
  RUNWAY_SHADOWS_WINDOW_DAYS,
  SCORE_BINS_FREE,
  SCORE_BINS_PRO,
  runwayShadowsQuerySchema,
  runwayShadowsResponseSchema,
} from './runway-shadows.js';

describe('contracts — runway-shadows (T182)', () => {
  it('bin constants: Free 4 / Pro 7, contiguous 0–100', () => {
    expect(SCORE_BINS_FREE).toHaveLength(4);
    expect(SCORE_BINS_PRO).toHaveLength(7);
    expect(SCORE_BINS_FREE[0]?.score_min).toBe(0);
    expect(SCORE_BINS_FREE.at(-1)?.score_max).toBe(100);
    expect(SCORE_BINS_PRO[0]?.score_min).toBe(0);
    expect(SCORE_BINS_PRO.at(-1)?.score_max).toBe(100);
    expect(RUNWAY_SHADOWS_K_BUCKET).toBe(5);
    expect(RUNWAY_SHADOWS_K_RUNWAY).toBe(5);
    expect(RUNWAY_SHADOWS_WINDOW_DAYS).toBe(90);
  });

  it('query: airport+runway required; empty filters → undefined', () => {
    const ok = runwayShadowsQuerySchema.parse({ airport: 'ulli', runway: '28l' });
    expect(ok).toEqual({ airport: 'ULLI', runway: '28L' });

    const withEmpty = runwayShadowsQuerySchema.parse({
      airport: 'ULLI',
      runway: '28L',
      aircraft_icao: '',
      wind: '',
    });
    expect(withEmpty.aircraft_icao).toBeUndefined();
    expect(withEmpty.wind).toBeUndefined();

    const filtered = runwayShadowsQuerySchema.parse({
      airport: 'ULLI',
      runway: '28L',
      aircraft_icao: 'c172',
      wind: 'calm',
    });
    expect(filtered).toEqual({
      airport: 'ULLI',
      runway: '28L',
      aircraft_icao: 'C172',
      wind: 'calm',
    });
  });

  it('query rejects invalid airport / wind / unknown fields', () => {
    expect(runwayShadowsQuerySchema.safeParse({ airport: 'MOW', runway: '28L' }).success).toBe(
      false,
    );
    expect(
      runwayShadowsQuerySchema.safeParse({ airport: 'ULLI', runway: '28L', wind: 'gale' }).success,
    ).toBe(false);
    expect(
      runwayShadowsQuerySchema.safeParse({
        airport: 'ULLI',
        runway: '28L',
        user_id: 'x',
      }).success,
    ).toBe(false);
  });

  it('response schema accepts histogram and rejects PII-shaped extras', () => {
    const body = {
      data: {
        destination_icao: 'ULLI',
        runway_icao: '28L',
        window_days: 90,
        insufficient: false,
        total: 12,
        bins: 'free_coarse' as const,
        buckets: [
          { id: '0-49', score_min: 0, score_max: 49, count: 0 },
          { id: '50-69', score_min: 50, score_max: 69, count: 0 },
          { id: '70-84', score_min: 70, score_max: 84, count: 6 },
          { id: '85-100', score_min: 85, score_max: 100, count: 6 },
        ],
        filters_applied: { aircraft_icao: null, wind: null },
      },
      meta: {
        your_score: 88,
        your_bin_id: '85-100',
        k_bucket: 5,
        k_runway: 5,
        pro_filters_available: false,
      },
    };
    expect(runwayShadowsResponseSchema.parse(body)).toEqual(body);

    const withPii = {
      ...body,
      data: {
        ...body.data,
        handle: 'ace',
        user_id: '11111111-1111-4111-8111-111111111111',
        token: 'sharetoken123',
      },
    };
    expect(runwayShadowsResponseSchema.safeParse(withPii).success).toBe(false);
  });

  it('insufficient → total null + empty buckets', () => {
    const ok = runwayShadowsResponseSchema.safeParse({
      data: {
        destination_icao: 'ULLI',
        runway_icao: '28L',
        window_days: 90,
        insufficient: true,
        total: null,
        bins: 'pro_fine',
        buckets: [],
        filters_applied: { aircraft_icao: 'C172', wind: 'strong' },
      },
      meta: {
        your_score: null,
        your_bin_id: null,
        k_bucket: 5,
        k_runway: 5,
        pro_filters_available: true,
      },
    });
    expect(ok.success).toBe(true);

    const leakTotal = runwayShadowsResponseSchema.safeParse({
      data: {
        destination_icao: 'ULLI',
        runway_icao: '28L',
        window_days: 90,
        insufficient: true,
        total: 3,
        bins: 'free_coarse',
        buckets: [],
        filters_applied: { aircraft_icao: null, wind: null },
      },
      meta: {
        your_score: null,
        your_bin_id: null,
        k_bucket: 5,
        k_runway: 5,
        pro_filters_available: false,
      },
    });
    expect(leakTotal.success).toBe(false);
  });
});
