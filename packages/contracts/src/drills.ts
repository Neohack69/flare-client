import { z } from 'zod';

/** Ключи компонент скоринга = error keys каталога drills (T179 §5.1). */
export const drillErrorKeySchema = z.enum([
  'vertical_speed',
  'g_force',
  'centreline',
  'bounce',
  'attitude',
  'touchdown_zone',
]);
export type DrillErrorKey = z.output<typeof drillErrorKeySchema>;

export const recommendedDrillEvidenceMetricSchema = z.enum([
  'vs_fpm',
  'g_force',
  'centreline_offset_m',
  'bounce_count',
  'pitch_deg',
  'bank_deg',
  'touchdown_zone',
]);
export type RecommendedDrillEvidenceMetric = z.output<typeof recommendedDrillEvidenceMetricSchema>;

export const recommendedDrillNoneReasonSchema = z.enum([
  'no_material_error',
  'low_confidence',
  'ineligible',
]);
export type RecommendedDrillNoneReason = z.output<typeof recommendedDrillNoneReasonSchema>;

/**
 * Аддитивное поле AI Debrief DTO (T179 §7.1): compute-on-read из агрегатов посадки.
 * Free без гранта → `locked` без title/howto.
 */
export const recommendedDrillSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      catalog_version: z.string().min(1).max(32),
      id: z.string().min(1).max(64),
      error_key: drillErrorKeySchema,
      title: z.string().min(1).max(80),
      howto: z.array(z.string().min(1).max(160)).min(2).max(5),
      why: z
        .object({
          component_score: z.number().finite().min(0).max(100),
          weight: z.number().finite().min(0).max(1),
          deficit: z.number().finite().nonnegative(),
          evidence: z
            .object({
              metric: recommendedDrillEvidenceMetricSchema,
              value: z.union([z.number().finite(), z.string().min(1).max(32)]),
              unit: z.string().min(1).max(16).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      status: z.literal('none'),
      reason: recommendedDrillNoneReasonSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('locked'),
    })
    .strict(),
]);
export type RecommendedDrillDto = z.output<typeof recommendedDrillSchema>;
