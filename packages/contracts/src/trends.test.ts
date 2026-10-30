import { describe, expect, it } from 'vitest';

import { meTrendsQuerySchema, meTrendsSchema } from './trends.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

function scope(overrides: Record<string, unknown> = {}) {
  return {
    landings: 6,
    percentile: 67,
    best_score: 95,
    worst_score: 50,
    avg_score: 79.5,
    avg_vs_fpm: -150,
    avg_g_force: 1.2,
    thin: false,
    ...overrides,
  };
}

function metric(overrides: Record<string, unknown> = {}) {
  return { delta: -12.5, direction: 'improving', samples: 6, ...overrides };
}

function trendsFixture(overrides: Record<string, unknown> = {}) {
  return {
    flight_id: UUID,
    landing_seq: 1,
    window_days: 90,
    max_landings: 200,
    from: '2026-07-16T12:00:00.000Z',
    overall: scope(),
    aircraft: scope(),
    runway: null,
    metrics: { vs_fpm: metric(), centreline_m: metric(), bounce: metric() },
    ...overrides,
  };
}

describe('meTrendsQuerySchema', () => {
  it('приводит seq из строки и допускает его отсутствие', () => {
    expect(meTrendsQuerySchema.safeParse({ flight_id: UUID, seq: '3' }).data).toEqual({
      flight_id: UUID,
      seq: 3,
    });
    expect(meTrendsQuerySchema.safeParse({ flight_id: UUID }).success).toBe(true);
  });

  it('отклоняет неизвестные поля и невалидный uuid', () => {
    expect(meTrendsQuerySchema.safeParse({ flight_id: UUID, x: 1 }).success).toBe(false);
    expect(meTrendsQuerySchema.safeParse({ flight_id: 'nope' }).success).toBe(false);
    expect(meTrendsQuerySchema.safeParse({ flight_id: UUID, seq: '0' }).success).toBe(false);
  });
});

describe('meTrendsSchema', () => {
  it('принимает полный ответ, включая null-скопы и unknown-тренд', () => {
    expect(meTrendsSchema.safeParse(trendsFixture()).success).toBe(true);
    expect(
      meTrendsSchema.safeParse(
        trendsFixture({
          overall: null,
          aircraft: null,
          runway: null,
          metrics: null,
          landing_seq: null,
        }),
      ).success,
    ).toBe(true);
    expect(
      meTrendsSchema.safeParse(
        trendsFixture({
          metrics: {
            vs_fpm: { delta: null, direction: null, samples: 0 },
            centreline_m: { delta: null, direction: null, samples: 0 },
            bounce: { delta: null, direction: null, samples: 0 },
          },
        }),
      ).success,
    ).toBe(true);
  });

  it('отклоняет перцентиль вне 0..100 и неизвестные ключи', () => {
    expect(meTrendsSchema.safeParse(trendsFixture({ overall: scope({ percentile: 120 }) })).success).toBe(
      false,
    );
    expect(meTrendsSchema.safeParse(trendsFixture({ extra: true })).success).toBe(false);
  });
});
