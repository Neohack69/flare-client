import { CONDITIONS_VERSION } from '@flightlog/contracts';
import type {
  Conditions,
  ConditionsFactor,
  ConditionsFactorKey,
  ConditionsTier,
} from '@flightlog/contracts';

/**
 * Deterministic complex-weather difficulty model (conditions-v1). Pure: no
 * I/O, no `Date.now`, no `Math.random`. The raw landing score is never changed;
 * `adjusted_score` is a display-only bonus.
 */
export const CONDITIONS_WEIGHTS: Readonly<Record<ConditionsFactorKey, number>> = {
  crosswind: 0.3,
  wind_shear: 0.2,
  visibility: 0.15,
  precip: 0.15,
  surface: 0.1,
  gust: 0.1,
};

export const CONDITIONS_MIN_COVERAGE = 0.6;

export interface ConditionsWindShearInput {
  max_wind_speed_delta_kt: number | null;
  max_wind_dir_delta_deg: number | null;
}

export interface ConditionsInput {
  crosswind_kt: number | null;
  wind_speed_kt: number | null;
  wind_gust_kt: number | null;
  visibility_m: number | null;
  precip: number | null;
  surface_condition: number | null;
  wind_shear: ConditionsWindShearInput | null;
}

interface Threshold {
  readonly x: number;
  readonly y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function interpolate(value: number, points: readonly Threshold[]): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return 0;
  if (value <= first.x) return first.y;
  if (value >= last.x) return last.y;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (!previous || !current) continue;
    if (value <= current.x) {
      const span = current.x - previous.x;
      if (span <= 0) return current.y;
      const ratio = (value - previous.x) / span;
      return previous.y + (current.y - previous.y) * ratio;
    }
  }
  return last.y;
}

function observed(key: ConditionsFactorKey, value: number, subIndex: number): ConditionsFactor {
  return {
    key,
    value,
    status: 'observed',
    sub_index: Math.round(clamp(subIndex, 0, 100)),
  };
}

function unknown(key: ConditionsFactorKey, value: number | null): ConditionsFactor {
  return { key, value, status: 'unknown', sub_index: null };
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const CROSSWIND_CURVE: readonly Threshold[] = [
  { x: 0, y: 0 },
  { x: 5, y: 0 },
  { x: 10, y: 25 },
  { x: 15, y: 55 },
  { x: 20, y: 80 },
  { x: 30, y: 100 },
];

const GUST_CURVE: readonly Threshold[] = [
  { x: 0, y: 0 },
  { x: 5, y: 20 },
  { x: 10, y: 50 },
  { x: 15, y: 75 },
  { x: 20, y: 100 },
];

const VISIBILITY_CURVE: readonly Threshold[] = [
  { x: 0, y: 100 },
  { x: 500, y: 100 },
  { x: 800, y: 85 },
  { x: 2000, y: 55 },
  { x: 5000, y: 25 },
  { x: 10000, y: 0 },
];

function crosswindFactor(value: number | null): ConditionsFactor {
  if (value === null) return unknown('crosswind', null);
  return observed('crosswind', value, interpolate(Math.abs(value), CROSSWIND_CURVE));
}

function gustFactor(gust: number | null, speed: number | null): ConditionsFactor {
  if (gust === null || speed === null) return unknown('gust', null);
  const excess = Math.max(0, gust - speed);
  return observed('gust', excess, interpolate(excess, GUST_CURVE));
}

function windShearFactor(shear: ConditionsWindShearInput | null): ConditionsFactor {
  if (shear === null) return unknown('wind_shear', null);
  const speedDelta = finiteOrNull(shear.max_wind_speed_delta_kt);
  const dirDelta = finiteOrNull(shear.max_wind_dir_delta_deg);
  if (speedDelta === null && dirDelta === null) return unknown('wind_shear', null);
  const ratio = Math.max(
    speedDelta === null ? 0 : Math.abs(speedDelta) / 15,
    dirDelta === null ? 0 : Math.abs(dirDelta) / 45,
  );
  return observed('wind_shear', ratio, clamp(ratio, 0, 1) * 100);
}

function visibilityFactor(value: number | null): ConditionsFactor {
  if (value === null) return unknown('visibility', null);
  return observed('visibility', value, interpolate(clamp(value, 0, 10000), VISIBILITY_CURVE));
}

const PRECIP_INDEX: Readonly<Record<number, number>> = { 2: 0, 4: 45, 8: 75 };

function precipFactor(value: number | null): ConditionsFactor {
  if (value === null) return unknown('precip', null);
  const index = PRECIP_INDEX[value];
  if (index === undefined) return unknown('precip', value);
  return observed('precip', value, index);
}

const SURFACE_INDEX: Readonly<Record<number, number>> = { 0: 0, 1: 35, 2: 75, 3: 100 };

function surfaceFactor(value: number | null): ConditionsFactor {
  if (value === null) return unknown('surface', null);
  const index = SURFACE_INDEX[value];
  if (index === undefined) return unknown('surface', value);
  return observed('surface', value, index);
}

export function conditionsTier(index: number): ConditionsTier {
  if (index < 20) return 'mild';
  if (index < 45) return 'moderate';
  if (index < 70) return 'hard';
  return 'severe';
}

/** Rounds to 4 decimals so persisted/JSON values are stable across platforms. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function assessConditions(input: ConditionsInput, rawScore: number): Conditions {
  const factors: ConditionsFactor[] = [
    crosswindFactor(finiteOrNull(input.crosswind_kt)),
    windShearFactor(input.wind_shear),
    visibilityFactor(finiteOrNull(input.visibility_m)),
    precipFactor(finiteOrNull(input.precip)),
    surfaceFactor(finiteOrNull(input.surface_condition)),
    gustFactor(finiteOrNull(input.wind_gust_kt), finiteOrNull(input.wind_speed_kt)),
  ];

  const observedWeight = factors.reduce(
    (sum, factor) => (factor.status === 'observed' ? sum + CONDITIONS_WEIGHTS[factor.key] : sum),
    0,
  );
  const totalWeight = factors.reduce((sum, factor) => sum + CONDITIONS_WEIGHTS[factor.key], 0);
  const coverage = totalWeight === 0 ? 0 : round4(observedWeight / totalWeight);

  if (coverage < CONDITIONS_MIN_COVERAGE) {
    return {
      version: CONDITIONS_VERSION,
      index: null,
      tier: null,
      coverage,
      adjusted_score: null,
      factors,
    };
  }

  const weighted = factors.reduce((sum, factor) => {
    if (factor.status !== 'observed' || factor.sub_index === null) return sum;
    return sum + CONDITIONS_WEIGHTS[factor.key] * factor.sub_index;
  }, 0);
  const index = Math.round(weighted / observedWeight);
  const bonus = Math.min(10, Math.floor(index / 10));
  const adjusted = Math.min(100, rawScore + bonus);

  return {
    version: CONDITIONS_VERSION,
    index,
    tier: conditionsTier(index),
    coverage,
    adjusted_score: adjusted,
    factors,
  };
}
