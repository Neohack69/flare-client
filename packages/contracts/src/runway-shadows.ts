import { z } from 'zod';

import { aircraftIcaoSchema, airportIcaoSchema } from './primitives.js';

/** k-anonymity: omit buckets with raw count below this (T182 OPEN #1). */
export const RUNWAY_SHADOWS_K_BUCKET = 5;
/** Minimum qualifying landings after filters before returning a histogram. */
export const RUNWAY_SHADOWS_K_RUNWAY = 5;
/** Rolling window for public landings (`touchdown_at`), UTC days. */
export const RUNWAY_SHADOWS_WINDOW_DAYS = 90;

export const runwayShadowsWindBinSchema = z.enum(['calm', 'moderate', 'strong']);
export type RunwayShadowsWindBin = z.output<typeof runwayShadowsWindBinSchema>;

export const runwayShadowsBinsKindSchema = z.enum(['free_coarse', 'pro_fine']);
export type RunwayShadowsBinsKind = z.output<typeof runwayShadowsBinsKindSchema>;

/** Free coarse score bins (inclusive). */
export const SCORE_BINS_FREE = [
  { id: '0-49', score_min: 0, score_max: 49 },
  { id: '50-69', score_min: 50, score_max: 69 },
  { id: '70-84', score_min: 70, score_max: 84 },
  { id: '85-100', score_min: 85, score_max: 100 },
] as const;

/** Pro fine score bins (inclusive). */
export const SCORE_BINS_PRO = [
  { id: '0-19', score_min: 0, score_max: 19 },
  { id: '20-39', score_min: 20, score_max: 39 },
  { id: '40-59', score_min: 40, score_max: 59 },
  { id: '60-69', score_min: 60, score_max: 69 },
  { id: '70-79', score_min: 70, score_max: 79 },
  { id: '80-89', score_min: 80, score_max: 89 },
  { id: '90-100', score_min: 90, score_max: 100 },
] as const;

export type ScoreBinDef = {
  readonly id: string;
  readonly score_min: number;
  readonly score_max: number;
};

function emptyToUndefined(value: unknown): unknown {
  if (value === '' || value === null || value === undefined) return undefined;
  return value;
}

/**
 * `GET /v1/runways/shadows` query (T182).
 * Pro-only filters (`aircraft_icao`, `wind`) — Free callers get 403 from the API.
 */
export const runwayShadowsQuerySchema = z
  .object({
    airport: z
      .string()
      .trim()
      .toUpperCase()
      .pipe(airportIcaoSchema),
    runway: z
      .string()
      .trim()
      .toUpperCase()
      .min(1)
      .max(8),
    aircraft_icao: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .trim()
        .toUpperCase()
        .pipe(aircraftIcaoSchema)
        .optional(),
    ),
    wind: z.preprocess(emptyToUndefined, runwayShadowsWindBinSchema.optional()),
  })
  .strict();
export type RunwayShadowsQuery = z.output<typeof runwayShadowsQuerySchema>;

export const runwayShadowsBucketSchema = z
  .object({
    id: z.string().min(1).max(16),
    score_min: z.number().int().min(0).max(100),
    score_max: z.number().int().min(0).max(100),
    /** 0 (empty declared bin) or ≥ k_bucket; tiny non-zero bins are omitted. */
    count: z.number().int().nonnegative(),
  })
  .strict();
export type RunwayShadowsBucket = z.output<typeof runwayShadowsBucketSchema>;

export const runwayShadowsDataSchema = z
  .object({
    destination_icao: airportIcaoSchema,
    runway_icao: z.string().min(1).max(8),
    window_days: z.literal(RUNWAY_SHADOWS_WINDOW_DAYS),
    insufficient: z.boolean(),
    total: z.number().int().nonnegative().nullable(),
    bins: runwayShadowsBinsKindSchema,
    buckets: z.array(runwayShadowsBucketSchema),
    filters_applied: z
      .object({
        aircraft_icao: aircraftIcaoSchema.nullable(),
        wind: runwayShadowsWindBinSchema.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.insufficient) {
      if (value.total !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'insufficient response must have total: null',
          path: ['total'],
        });
      }
      if (value.buckets.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'insufficient response must have empty buckets',
          path: ['buckets'],
        });
      }
    }
  });
export type RunwayShadowsData = z.output<typeof runwayShadowsDataSchema>;

export const runwayShadowsMetaSchema = z
  .object({
    your_score: z.number().int().min(0).max(100).nullable(),
    your_bin_id: z.string().min(1).max(16).nullable(),
    k_bucket: z.literal(RUNWAY_SHADOWS_K_BUCKET),
    k_runway: z.literal(RUNWAY_SHADOWS_K_RUNWAY),
    pro_filters_available: z.boolean(),
  })
  .strict();
export type RunwayShadowsMeta = z.output<typeof runwayShadowsMetaSchema>;

/** Full `GET /v1/runways/shadows` body — buckets only, no PII / ids / tokens. */
export const runwayShadowsResponseSchema = z
  .object({
    data: runwayShadowsDataSchema,
    meta: runwayShadowsMetaSchema,
  })
  .strict();
export type RunwayShadowsResponse = z.output<typeof runwayShadowsResponseSchema>;
