import { z } from 'zod';

/**
 * Complex-weather landing conditions (ADR: conditions-v1). Deterministic,
 * server-computed from flight aggregates. `version` is independent from the
 * raw score version: conditions may evolve while `score_version` stays 1.0.0.
 */
export const CONDITIONS_VERSION = '1.0.0';

export const conditionsFactorKeySchema = z.enum([
  'crosswind',
  'wind_shear',
  'visibility',
  'precip',
  'surface',
  'gust',
]);
export type ConditionsFactorKey = z.output<typeof conditionsFactorKeySchema>;

export const conditionsTierSchema = z.enum(['mild', 'moderate', 'hard', 'severe']);
export type ConditionsTier = z.output<typeof conditionsTierSchema>;

export const conditionsFactorSchema = z
  .object({
    key: conditionsFactorKeySchema,
    /** Raw observed value in its native unit; `null` when not measured. */
    value: z.number().finite().nullable(),
    status: z.enum(['observed', 'unknown']),
    /** 0..100 difficulty sub-index; `null` for unknown factors. */
    sub_index: z.number().min(0).max(100).nullable(),
  })
  .strict();
export type ConditionsFactor = z.output<typeof conditionsFactorSchema>;

export const conditionsSchema = z
  .object({
    version: z.literal(CONDITIONS_VERSION),
    index: z.number().min(0).max(100).nullable(),
    tier: conditionsTierSchema.nullable(),
    /** observed weight / total weight (0..1). */
    coverage: z.number().min(0).max(1),
    /** Display-only bonus-adjusted score; never ranked. */
    adjusted_score: z.number().min(0).max(100).nullable(),
    factors: z.array(conditionsFactorSchema),
  })
  .strict();
export type Conditions = z.output<typeof conditionsSchema>;
