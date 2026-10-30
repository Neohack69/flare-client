import { describe, expect, it } from 'vitest';

import {
  analyticsQuerySchema,
  clubAnalyticsSchema,
  mePeriodTrendsSchema,
} from './analytics.js';
import { meTrendsRequestSchema, meTrendsResponseSchema } from './trends.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

function clubAnalytics(overrides: Record<string, unknown> = {}) {
  return {
    period: 'month',
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-19T12:00:00.000Z',
    totals: { flights: 2, landings: 3, pilots: 1 },
    pilots: [
      {
        user_id: UUID,
        handle: 'pilot',
        display_name: 'Pilot',
        flights: 2,
        best_score: 90,
        avg_score: 85,
        avg_vs_fpm: 140.5,
      },
    ],
    aircraft: [{ aircraft_icao: 'A320', count: 3, best_score: 90, avg_score: 85 }],
    runways: [
      {
        destination_icao: 'UUEE',
        runway_icao: '24L',
        count: 3,
        best_score: 90,
        avg_score: 85,
      },
    ],
    ...overrides,
  };
}

function periodTrends(overrides: Record<string, unknown> = {}) {
  return {
    period: 'month',
    bucket: 'day',
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-19T12:00:00.000Z',
    totals: { flights: 2, landings: 3, pilots: 1 },
    avg_score: 85,
    best_score: 90,
    points: [
      {
        bucket_start: '2026-10-01T00:00:00.000Z',
        flights: 1,
        landings: 2,
        avg_score: 85,
        best_score: 90,
      },
    ],
    records: {
      runways: [
        {
          destination_icao: 'UUEE',
          runway_icao: '24L',
          count: 2,
          best_score: 90,
          avg_score: 85,
        },
      ],
      aircraft: [{ aircraft_icao: 'A320', count: 3, best_score: 90, avg_score: 85 }],
    },
    consistency: 7.07,
    consistency_thin: false,
    ...overrides,
  };
}

describe('analyticsQuerySchema', () => {
  it('период по умолчанию — month; 90d валиден', () => {
    expect(analyticsQuerySchema.parse({})).toEqual({ period: 'month' });
    expect(analyticsQuerySchema.parse({ period: '90d' })).toEqual({ period: '90d' });
  });

  it('неизвестный период и лишние параметры отклоняются', () => {
    expect(analyticsQuerySchema.safeParse({ period: 'week' }).success).toBe(false);
    expect(analyticsQuerySchema.safeParse({ period: 'month', x: 1 }).success).toBe(false);
  });
});

describe('clubAnalyticsSchema', () => {
  it('принимает полный payload и не более 3 top-строк', () => {
    expect(clubAnalyticsSchema.safeParse(clubAnalytics()).success).toBe(true);
    expect(
      clubAnalyticsSchema.safeParse(
        clubAnalytics({
          aircraft: Array.from({ length: 4 }, (_, i) => ({
            aircraft_icao: ['A320', 'B738', 'C172', 'A21N'][i],
            count: 1,
            best_score: 80,
            avg_score: 80,
          })),
        }),
      ).success,
    ).toBe(false);
  });

  it('отклоняет баллы вне 0..100 и неизвестные ключи', () => {
    expect(
      clubAnalyticsSchema.safeParse(
        clubAnalytics({ totals: { flights: 1, landings: 1, pilots: 1 }, extra: true }),
      ).success,
    ).toBe(false);
    expect(
      clubAnalyticsSchema.safeParse(
        clubAnalytics({
          aircraft: [{ aircraft_icao: 'A320', count: 1, best_score: 101, avg_score: 80 }],
        }),
      ).success,
    ).toBe(false);
  });
});

describe('mePeriodTrendsSchema', () => {
  it('принимает точки с null-бакетами и consistency = null', () => {
    expect(mePeriodTrendsSchema.safeParse(periodTrends()).success).toBe(true);
    expect(
      mePeriodTrendsSchema.safeParse(
        periodTrends({
          avg_score: null,
          best_score: null,
          points: [
            {
              bucket_start: '2026-10-01T00:00:00.000Z',
              flights: 0,
              landings: 0,
              avg_score: null,
              best_score: null,
            },
          ],
          records: { runways: [], aircraft: [] },
          consistency: null,
          consistency_thin: true,
        }),
      ).success,
    ).toBe(true);
  });

  it('union запроса разделяет legacy flight_id и period', () => {
    expect(meTrendsRequestSchema.safeParse({ flight_id: UUID }).success).toBe(true);
    expect(meTrendsRequestSchema.safeParse({ period: '90d' }).success).toBe(true);
    expect(meTrendsRequestSchema.parse({})).toEqual({ period: 'month' });
    expect(meTrendsRequestSchema.safeParse({ period: '90d', flight_id: UUID }).success).toBe(false);
  });

  it('union ответа принимает оба режима и отклоняет смесь', () => {
    expect(meTrendsResponseSchema.safeParse(periodTrends()).success).toBe(true);
    expect(
      meTrendsResponseSchema.safeParse({
        ...periodTrends(),
        flight_id: UUID,
      }).success,
    ).toBe(false);
  });
});
