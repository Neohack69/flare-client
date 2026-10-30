import { describe, expect, it } from 'vitest';

import { CONDITIONS_VERSION } from '@flightlog/contracts';

import { assessConditions, conditionsTier, type ConditionsInput } from './conditions.js';

function input(overrides: Partial<ConditionsInput> = {}): ConditionsInput {
  return {
    crosswind_kt: 0,
    wind_speed_kt: 10,
    wind_gust_kt: 10,
    visibility_m: 10000,
    precip: 2,
    surface_condition: 0,
    wind_shear: { max_wind_speed_delta_kt: 0, max_wind_dir_delta_deg: 0 },
    ...overrides,
  };
}

function factor(conditions: ReturnType<typeof assessConditions>, key: string) {
  return conditions.factors.find((entry) => entry.key === key);
}

describe('assessConditions (conditions-v1)', () => {
  it('is deterministic for the same input', () => {
    const sample = input({ crosswind_kt: 14, visibility_m: 2500 });
    expect(assessConditions(sample, 77)).toEqual(assessConditions(sample, 77));
  });

  it('calm weather scores 0 and keeps the raw score in adjusted_score', () => {
    const result = assessConditions(input(), 88);
    expect(result.version).toBe(CONDITIONS_VERSION);
    expect(result.index).toBe(0);
    expect(result.tier).toBe('mild');
    expect(result.coverage).toBe(1);
    expect(result.adjusted_score).toBe(88);
  });

  it('crosswind difficulty uses the absolute value (both signs equal)', () => {
    const left = assessConditions(input({ crosswind_kt: 12 }), 70);
    const right = assessConditions(input({ crosswind_kt: -12 }), 70);
    expect(left.index).toBe(right.index);
    expect(left.index).toBeGreaterThan(0);
    expect(factor(left, 'crosswind')?.value).toBe(12);
    expect(factor(right, 'crosswind')?.value).toBe(-12);
  });

  it('snow + low visibility + shear produce a hard landing environment', () => {
    const result = assessConditions(
      input({
        crosswind_kt: 10,
        visibility_m: 800,
        precip: 8,
        surface_condition: 2,
        wind_shear: { max_wind_speed_delta_kt: 15, max_wind_dir_delta_deg: 0 },
      }),
      80,
    );
    expect(result.coverage).toBe(1);
    expect(result.index).toBe(59);
    expect(result.tier).toBe('hard');
    expect(factor(result, 'precip')?.sub_index).toBe(75);
    expect(factor(result, 'surface')?.sub_index).toBe(75);
    expect(result.adjusted_score).toBe(85);
  });

  it('surface_condition maps dry/wet/snow/ice and unknown stays unknown', () => {
    expect(factor(assessConditions(input({ surface_condition: 0 }), 50), 'surface')).toMatchObject({
      status: 'observed',
      sub_index: 0,
    });
    expect(factor(assessConditions(input({ surface_condition: 1 }), 50), 'surface')).toMatchObject({
      status: 'observed',
      sub_index: 35,
    });
    expect(factor(assessConditions(input({ surface_condition: 2 }), 50), 'surface')).toMatchObject({
      status: 'observed',
      sub_index: 75,
    });
    expect(factor(assessConditions(input({ surface_condition: 3 }), 50), 'surface')).toMatchObject({
      status: 'observed',
      sub_index: 100,
    });
    expect(
      factor(assessConditions(input({ surface_condition: null }), 50), 'surface'),
    ).toMatchObject({ status: 'unknown', sub_index: null, value: null });
  });

  it('a missing gust is unknown, never a zero, and does not block the index', () => {
    const result = assessConditions(input({ wind_gust_kt: null }), 90);
    expect(factor(result, 'gust')).toMatchObject({
      status: 'unknown',
      sub_index: null,
      value: null,
    });
    expect(result.coverage).toBe(0.9);
    expect(result.index).toBe(0);
    expect(result.adjusted_score).toBe(90);
  });

  it('X-Plane style null surface is unknown and renormalises the index', () => {
    const result = assessConditions(input({ surface_condition: null, crosswind_kt: 20 }), 60);
    expect(factor(result, 'surface')?.status).toBe('unknown');
    expect(result.coverage).toBe(0.9);
    // Crosswind 80 with weight 0.3 over observed weight 0.9.
    expect(result.index).toBe(Math.round((0.3 * 80) / 0.9));
  });

  it('coverage below 0.6 nulls index/tier/adjusted but keeps observed factors', () => {
    const result = assessConditions(
      input({
        crosswind_kt: 10,
        wind_shear: { max_wind_speed_delta_kt: 0, max_wind_dir_delta_deg: 0 },
        wind_speed_kt: null,
        wind_gust_kt: null,
        visibility_m: null,
        precip: null,
        surface_condition: null,
      }),
      42,
    );
    expect(result.coverage).toBe(0.5);
    expect(result.index).toBeNull();
    expect(result.tier).toBeNull();
    expect(result.adjusted_score).toBeNull();
    expect(factor(result, 'crosswind')?.sub_index).toBe(25);
    expect(factor(result, 'visibility')?.status).toBe('unknown');
  });

  it('coverage exactly 0.6 is enough for an index', () => {
    const result = assessConditions(
      input({
        crosswind_kt: 10,
        wind_shear: { max_wind_speed_delta_kt: 0, max_wind_dir_delta_deg: 0 },
        surface_condition: 0,
        wind_speed_kt: null,
        wind_gust_kt: null,
        visibility_m: null,
        precip: null,
      }),
      50,
    );
    expect(result.coverage).toBe(0.6);
    expect(result.index).toBe(Math.round((0.3 * 25) / 0.6));
    expect(result.adjusted_score).not.toBeNull();
  });

  it('adjusted_score is display-only: between raw and 100, raw is untouched', () => {
    const raw = 80;
    const result = assessConditions(
      input({
        crosswind_kt: 10,
        visibility_m: 800,
        precip: 8,
        surface_condition: 2,
        wind_shear: { max_wind_speed_delta_kt: 15, max_wind_dir_delta_deg: 0 },
      }),
      raw,
    );
    expect(raw).toBe(80);
    expect(result.adjusted_score).toBeGreaterThanOrEqual(raw);
    expect(result.adjusted_score).toBeLessThanOrEqual(100);
    expect(result.index).not.toBe(result.adjusted_score);
  });

  it('tier thresholds are <20 mild, <45 moderate, <70 hard, >=70 severe', () => {
    expect(conditionsTier(0)).toBe('mild');
    expect(conditionsTier(19)).toBe('mild');
    expect(conditionsTier(20)).toBe('moderate');
    expect(conditionsTier(44)).toBe('moderate');
    expect(conditionsTier(45)).toBe('hard');
    expect(conditionsTier(69)).toBe('hard');
    expect(conditionsTier(70)).toBe('severe');
  });

  it('no observed factor yields coverage 0 and null index', () => {
    const result = assessConditions(
      {
        crosswind_kt: null,
        wind_speed_kt: null,
        wind_gust_kt: null,
        visibility_m: null,
        precip: null,
        surface_condition: null,
        wind_shear: null,
      },
      95,
    );
    expect(result.coverage).toBe(0);
    expect(result.index).toBeNull();
    expect(result.adjusted_score).toBeNull();
    expect(result.factors.every((entry) => entry.status === 'unknown')).toBe(true);
  });
});
