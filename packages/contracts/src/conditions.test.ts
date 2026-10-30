import { describe, expect, it } from 'vitest';

import { CONDITIONS_VERSION, conditionsSchema, landingSummarySchema } from './index.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = '2026-09-26T10:12:03.000Z';

const conditions = {
  version: CONDITIONS_VERSION,
  index: 59,
  tier: 'hard',
  coverage: 1,
  adjusted_score: 85,
  factors: [
    { key: 'crosswind', value: -12, status: 'observed', sub_index: 37 },
    { key: 'wind_shear', value: 0, status: 'observed', sub_index: 0 },
    { key: 'visibility', value: 800, status: 'observed', sub_index: 85 },
    { key: 'precip', value: 8, status: 'observed', sub_index: 75 },
    { key: 'surface', value: 2, status: 'observed', sub_index: 75 },
    { key: 'gust', value: null, status: 'unknown', sub_index: null },
  ],
};

function landing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UUID,
    seq: 1,
    touchdown_at: NOW,
    touch_and_go: false,
    ground_contact_s: 12,
    metrics: { vs_fpm: -210, g_force: 1.3, bounce_count: 0, bounced: false },
    score: 80,
    grade: 'good',
    components: { vertical_speed: 70 },
    score_version: '1.0.0',
    segmentation_version: '1.0.0',
    confidence: 1,
    eligible: true,
    verified: true,
    quality_flags: 0,
    ...overrides,
  };
}

describe('conditions contract (conditions-v1)', () => {
  it('accepts a complete observed conditions object', () => {
    expect(conditionsSchema.safeParse(conditions).success).toBe(true);
  });

  it('accepts unknown factors without turning them into zeros', () => {
    const parsed = conditionsSchema.parse(conditions);
    const gust = parsed.factors.find((entry) => entry.key === 'gust');
    expect(gust).toMatchObject({ status: 'unknown', value: null, sub_index: null });
  });

  it('rejects out-of-range index/tier/coverage', () => {
    expect(conditionsSchema.safeParse({ ...conditions, index: 101 }).success).toBe(false);
    expect(conditionsSchema.safeParse({ ...conditions, tier: 'extreme' }).success).toBe(false);
    expect(conditionsSchema.safeParse({ ...conditions, coverage: 1.2 }).success).toBe(false);
    expect(
      conditionsSchema.safeParse({ ...conditions, factors: [{ key: 'crosswind' }] }).success,
    ).toBe(false);
  });

  it('landingSummarySchema defaults conditions to null for historical landings', () => {
    const parsed = landingSummarySchema.parse(landing());
    expect(parsed.conditions).toBeNull();
  });

  it('landingSummarySchema carries conditions additively', () => {
    const parsed = landingSummarySchema.parse(landing({ conditions }));
    expect(parsed.conditions?.tier).toBe('hard');
    expect(parsed.conditions?.index).toBe(59);
    expect(parsed.conditions?.adjusted_score).toBe(85);
  });

  it('raw score_version stays independent from conditions version', () => {
    const parsed = landingSummarySchema.parse(landing({ conditions }));
    expect(parsed.score_version).toBe('1.0.0');
    expect(parsed.conditions?.version).toBe(CONDITIONS_VERSION);
    expect(parsed.score).toBe(80);
  });
});
