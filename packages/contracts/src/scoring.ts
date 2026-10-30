import { z } from 'zod';
import { landingAnalysisSchema } from './analysis.js';
import { runwaySchema } from './runway.js';
import { aircraftIcaoSchema, semverSchema, utcDateTimeSchema, uuidSchema } from './primitives.js';
import { conditionsSchema } from './conditions.js';
import { qualityFlagsSchema } from './quality.js';
import { weatherSampleShape } from './weather.js';

export const touchdownZoneSchema = z.enum(['TDZ', 'before', 'after']);
export type TouchdownZone = z.output<typeof touchdownZoneSchema>;

export const scoreGradeSchema = z.enum(['butter', 'good', 'firm', 'hard', 'crash']);
export type ScoreGrade = z.output<typeof scoreGradeSchema>;

/**
 * Normalized scoring input (ADR-0004, data-model §6). Values are extracted
 * from high-frequency track points around touchdown — never raw telemetry.
 *
 * `vs_fpm`/`g_force` are non-null here on purpose: this is the **scoring-input**
 * shape produced by the agent and consumed by `scoreLanding`, where a landing is
 * only scored once a real sink rate / load factor was measured. API responses
 * that surface **stored** metrics use the honest nullable variant
 * (`landingMetricsResponseSchema`): a landing persisted without a measurement
 * must never be reported as a plausible `0 fpm` / `1.0 g`.
 */
export const landingMetricsSchema = z
  .object({
    vs_fpm: z.number().int(),
    g_force: z.number().finite(),
    pitch_deg: z.number().finite().nullish(),
    bank_deg: z.number().finite().nullish(),
    bounce_count: z.number().int().nonnegative().default(0),
    bounced: z.boolean().default(false),
    centreline_offset_m: z.number().finite().nonnegative().nullish(),
    touchdown_zone: touchdownZoneSchema.nullish(),
    headwind_kt: z.number().finite().nullish(),
    crosswind_kt: z.number().finite().nullish(),
    runway_icao: z.string().max(32).nullish(),
    aircraft_icao: aircraftIcaoSchema.nullish(),
    ...weatherSampleShape,
  })
  .strict();
export type LandingMetrics = z.output<typeof landingMetricsSchema>;
export type LandingMetricsInput = z.input<typeof landingMetricsSchema>;

/**
 * Landing metrics as they appear in **API responses** (`landingSummarySchema`,
 * `embeddedScoreSchema`, touchdown preview). Identical to `landingMetricsSchema`
 * except `vs_fpm`/`g_force` may be `null` — the honest representation of a
 * landing stored without a real sink rate / load factor (P0 data-honesty).
 * Every consumer must render `null` as «—»/«нет данных», never as `0`/`1.0`.
 */
export const landingMetricsResponseSchema = landingMetricsSchema.extend({
  vs_fpm: z.number().int().nullable(),
  g_force: z.number().finite().nullable(),
});
export type LandingMetricsResponse = z.output<typeof landingMetricsResponseSchema>;

/** Per-criterion breakdown, each 0..100. */
export const scoreComponentsSchema = z.record(z.string(), z.number().finite().min(0).max(100));
export type ScoreComponents = z.output<typeof scoreComponentsSchema>;

/**
 * Канонические критерии скоринга (ADR-0004) — ключи `components`/`weights`
 * (`scoreLanding`). Единый allowlist для `evidence.component` AI Debrief
 * (llm-debrief-prompt.md §4.1): не дублировать список в других пакетах.
 */
export const scoreComponentSchema = z.enum([
  'vertical_speed',
  'g_force',
  'centreline',
  'bounce',
  'attitude',
  'touchdown_zone',
]);
export type ScoreComponent = z.output<typeof scoreComponentSchema>;

export const landingScoreSchema = z
  .object({
    score: z.number().int().min(0).max(100),
    grade: scoreGradeSchema,
    components: scoreComponentsSchema,
    score_version: semverSchema,
    /** Качество входа на момент расчёта (ADR-0003, data-model §6). */
    confidence: z.number().min(0).max(1).optional(),
    eligible: z.boolean().optional(),
    quality_flags: qualityFlagsSchema.optional(),
  })
  .strict();
export type LandingScore = z.output<typeof landingScoreSchema>;

/**
 * Последний скоринг, вложенный в `flights.stats` (api.md §3.2.1).
 * `metrics` — сырые измерения касания (плоские колонки `landing_scores`),
 * `components` — нормированные вклады 0..100.
 */
export const embeddedScoreSchema = z
  .object({
    score: z.number().int().min(0).max(100),
    grade: scoreGradeSchema,
    score_version: semverSchema,
    components: scoreComponentsSchema,
    confidence: z.number().min(0).max(1).nullable(),
    eligible: z.boolean(),
    metrics: landingMetricsResponseSchema,
  })
  .strict();
export type EmbeddedScore = z.output<typeof embeddedScoreSchema>;

/**
 * Политика representative-посадки рейса (ADR-0010 §4). `best` — лидербордная
 * (совместима с single-landing); `last` — дашборд берёт из `landings[]`;
 * `avg` — возможная будущая метрика «стабильность» (`landing_scores.avg_score`).
 */
export const scorePolicySchema = z.enum(['best', 'last', 'avg']);
export type ScorePolicy = z.output<typeof scorePolicySchema>;

/**
 * Одна посадка сессии (ADR-0010, api.md §3.2.4). Отскоки — атрибут посадки
 * (`metrics.bounce_count`), а не отдельные элементы. `segmentation_version`
 * версионирует правила группировки касаний, `score_version` — формулу балла.
 */
export const landingSummarySchema = z
  .object({
    id: uuidSchema,
    seq: z.number().int().min(1),
    touchdown_at: utcDateTimeSchema,
    touch_and_go: z.boolean(),
    ground_contact_s: z.number().int().nonnegative().nullable(),
    metrics: landingMetricsResponseSchema,
    score: z.number().int().min(0).max(100),
    grade: scoreGradeSchema,
    components: scoreComponentsSchema,
    score_version: semverSchema,
    segmentation_version: semverSchema,
    confidence: z.number().min(0).max(1),
    eligible: z.boolean(),
    verified: z.boolean(),
    quality_flags: qualityFlagsSchema,
    /**
     * Базовый XP за эту посадку (T111, gamification.md §5.2). `null` — посадка
     * не участвует в прогрессе (`gate=0`); UI показывает `—`, никогда «0 XP».
     * Сумма бонусов сессии — в `stats.xp_session`.
     */
    xp_awarded: z.number().int().nonnegative().nullable().default(null),
    /**
     * Полоса/торец этой посадки (ADR-0013 / T129). `null` — достоверного торца
     * нет → реплей выравнивается по курсу трека, не по рейсовой `flight.runway`.
     */
    runway: runwaySchema.nullable().default(null),
    /**
     * WAVE 4 (FOQA): per-landing анализ (`landings.analysis`) для графиков
     * подхода (ILS/AoA/конфигурация) и метрик касания. `null` — анализа нет
     * (старые рейсы/старый агент). Аддитивное поле.
     */
    analysis: landingAnalysisSchema.nullable().default(null),
    /**
     * Complex-weather conditions for this landing (conditions-v1). Additive and
     * nullable: historical landings (and any landing without a stored row) keep
     * `null`. The raw score is untouched; `adjusted_score` is display-only.
     */
    conditions: conditionsSchema.nullable().default(null),
  })
  .strict();
export type LandingSummary = z.output<typeof landingSummarySchema>;

/** Ответ `GET /v1/flights/{id}/landings` (api.md §3.2.4). */
export const landingsResponseSchema = z.object({ data: z.array(landingSummarySchema) }).strict();
export type LandingsResponse = z.output<typeof landingsResponseSchema>;
