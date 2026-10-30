import { z } from 'zod';
import {
  aircraftIcaoSchema,
  airportIcaoSchema,
  semverSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './primitives.js';
import {
  aircraftCategorySchema,
  engineTypeSchema,
  wingConfigSchema,
} from './aircraft.js';
import { recommendedDrillSchema } from './drills.js';
import { scoreComponentSchema, scoreGradeSchema, touchdownZoneSchema } from './scoring.js';
import {
  engineAggregateSchema,
  flightConfigSnapshotSchema,
  ilsDeviationStatsSchema,
  LANDING_ANALYSIS_SERIES_MAX,
  landingAnalysisSeriesPointSchema,
  touchdownPointSchema,
  windShearSchema,
} from './analysis.js';
import {
  flightWeatherSummarySchema,
  weatherSampleSchema,
  weatherSampleShape,
} from './weather.js';

/** Виды AI-отчётов: debrief одной посадки, coach серии, monthly insight. */
export const aiReportKindSchema = z.enum([
  'debrief',
  // CO1: AI Coach — серия посадок (кнопка + scope/period, без свободного текста).
  'coach',
  'monthly_insight',
  'journal_summary',
]);
export type AiReportKind = z.output<typeof aiReportKindSchema>;

export const aiReportStatusSchema = z.enum(['pending', 'running', 'done', 'failed']);
export type AiReportStatus = z.output<typeof aiReportStatusSchema>;

export const aiDebriefRequestSchema = z
  .object({
    flight_id: uuidSchema,
    /** Представительная посадка сессии (ADR-0010); по умолчанию — политика сервера. */
    landing_seq: z.number().int().min(1).optional(),
    /** Язык отчёта RU+EN (llm-debrief-prompt.md §7.4). */
    language: z.enum(['ru', 'en']).optional(),
  })
  .strict();
export type AiDebriefRequest = z.output<typeof aiDebriefRequestSchema>;

/** T169: заказ месячной характеристики (прошлый календарный месяц UTC, D11). */
export const aiMonthlyInsightRequestSchema = z
  .object({
    language: z.enum(['ru', 'en']).optional(),
  })
  .strict();
export type AiMonthlyInsightRequest = z.output<typeof aiMonthlyInsightRequestSchema>;

const monthlyGradeCountsSchema = z
  .object({
    butter: z.number().int().nonnegative(),
    good: z.number().int().nonnegative(),
    firm: z.number().int().nonnegative(),
    hard: z.number().int().nonnegative(),
    crash: z.number().int().nonnegative(),
  })
  .strict();

export const monthlyInsightAggregatesSchema = z
  .object({
    flights_count: z.number().int().nonnegative(),
    landings_count: z.number().int().nonnegative(),
    avg_score: z.number().finite().nullable(),
    best_score: z.number().int().min(0).max(100).nullable(),
    worst_score: z.number().int().min(0).max(100).nullable(),
    grade_counts: monthlyGradeCountsSchema,
    bounce_landings: z.number().int().nonnegative(),
    hard_or_worse: z.number().int().nonnegative(),
    first_half_avg: z.number().finite().nullable(),
    second_half_avg: z.number().finite().nullable(),
    top_aircraft: z
      .array(
        z
          .object({
            icao: aircraftIcaoSchema,
            landings: z.number().int().positive(),
            avg_score: z.number().finite(),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();
export type MonthlyInsightAggregates = z.output<typeof monthlyInsightAggregatesSchema>;

/** Выход LLM для T169 (без confidence в публичном DTO). */
export const monthlyInsightOutputV1Schema = z
  .object({
    summary: z.string().min(1).max(500),
    successes: z.array(z.string().min(1).max(160)).max(3),
    setbacks: z.array(z.string().min(1).max(160)).max(3),
  })
  .strict();
export type MonthlyInsightOutputV1 = z.output<typeof monthlyInsightOutputV1Schema>;

export const monthlyInsightPeriodSchema = z
  .object({
    year: z.number().int().min(2000).max(2100),
    month: z.number().int().min(1).max(12),
    start: utcDateTimeSchema,
    end: utcDateTimeSchema,
  })
  .strict();
export type MonthlyInsightPeriod = z.output<typeof monthlyInsightPeriodSchema>;

/** Публичный DTO `POST`/`GET /v1/ai/monthly-insight` (T169). */
export const aiMonthlyInsightDtoSchema = z
  .object({
    period: monthlyInsightPeriodSchema,
    timezone: z.literal('UTC'),
    status: z.enum(['empty', 'pending', 'running', 'done', 'failed']),
    language: z.enum(['ru', 'en']),
    aggregates: monthlyInsightAggregatesSchema,
    insight: monthlyInsightOutputV1Schema.nullable(),
    report_id: uuidSchema.nullable(),
    cached: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();
export type AiMonthlyInsightDto = z.output<typeof aiMonthlyInsightDtoSchema>;

export const aiMonthlyInsightResponseSchema = z
  .object({ data: aiMonthlyInsightDtoSchema })
  .strict();
export type AiMonthlyInsightResponse = z.output<typeof aiMonthlyInsightResponseSchema>;

/** Read-endpoint может вернуть `null`, если отчёт ещё не заказывали. */
export const aiMonthlyInsightGetResponseSchema = z
  .object({ data: aiMonthlyInsightDtoSchema.nullable() })
  .strict();
export type AiMonthlyInsightGetResponse = z.output<typeof aiMonthlyInsightGetResponseSchema>;

/** CO1: период AI Coach — только серверные пресеты, без свободного текста. */
export const coachPeriodSchema = z.enum(['last_30_days', 'last_90_days', 'previous_month']);
export type CoachPeriod = z.output<typeof coachPeriodSchema>;

/**
 * CO1: `POST /v1/ai/coach`. Триггер — кнопка + два select-а; `query` и любой
 * пользовательский текст запрещены (`.strict()` → 422).
 */
export const aiCoachRequestSchema = z
  .object({
    aircraft_icao: z.string().trim().min(1).max(8).nullable().optional(),
    period: coachPeriodSchema,
    language: z.enum(['ru', 'en']).optional(),
    /** CO2: явный повтор после `failed` (кэш ошибки обходится, 1/мин). */
    force: z.boolean().optional(),
  })
  .strict();
export type AiCoachRequest = z.output<typeof aiCoachRequestSchema>;

const coachDrillSchema = z
  .object({
    title: z.string().min(3).max(80),
    howto: z.string().min(10).max(260),
  })
  .strict();

const coachGoalSchema = z
  .object({
    text: z.string().min(3).max(200),
    metric: z.string().min(1).max(40),
    target: z.string().min(1).max(80),
  })
  .strict();

/** CO1: ответ LLM — только числа из входа, null-метрики опущены. */
export const coachOutputSchema = z
  .object({
    summary: z.string().min(1).max(500),
    what_common: z.array(z.string().min(1).max(160)).min(1).max(3),
    train: z.array(z.string().min(1).max(160)).min(1).max(3),
    drills: z.array(coachDrillSchema).min(1).max(2),
    goal: coachGoalSchema,
    confidence: z.number().min(0).max(1),
    data_points: z.number().int().nonnegative(),
  })
  .strict();
export type CoachOutput = z.output<typeof coachOutputSchema>;

const coachCriterionSchema = z
  .object({
    avg_score: z.number().finite().min(0).max(100).nullable(),
    samples: z.number().int().nonnegative(),
    worst_value_fpm: z.number().finite().nullable().optional(),
    worst_value_g: z.number().finite().nullable().optional(),
    worst_value_m: z.number().finite().nullable().optional(),
    worst_value_count: z.number().int().nonnegative().nullable().optional(),
    worst_pitch_deg: z.number().finite().nullable().optional(),
    worst_bank_deg: z.number().finite().nullable().optional(),
    worst_zone: touchdownZoneSchema.nullable().optional(),
  })
  .strict();

const coachWeakestSchema = z
  .object({
    component: scoreComponentSchema,
    score: z.number().finite().min(0).max(100),
    value: z.number().finite().nullable(),
    unit: z.string().min(1).max(8).nullable(),
    value_text: z.string().min(1).max(16).nullable(),
  })
  .strict();

const coachLandingSummarySchema = z
  .object({
    date: utcDateTimeSchema,
    aircraft_icao: aircraftIcaoSchema.nullable(),
    airport_icao: airportIcaoSchema.nullable(),
    score: z.number().int().min(0).max(100),
    grade: scoreGradeSchema,
    vs_fpm: z.number().int().nullable(),
    g_force: z.number().finite().nullable(),
    weakest: z.array(coachWeakestSchema).max(3),
  })
  .strict();

const coachGradeCountsSchema = z
  .object({
    butter: z.number().int().nonnegative(),
    good: z.number().int().nonnegative(),
    firm: z.number().int().nonnegative(),
    hard: z.number().int().nonnegative(),
    crash: z.number().int().nonnegative(),
  })
  .strict();

/**
 * CO1: детерминированный вход Coach (≤ 8 KB). Только агрегаты: никаких
 * `track_points`, `landings_analysis` и пользовательского текста.
 */
export const coachInputV1Schema = z
  .object({
    schema_version: z.literal('coach-input/1'),
    language: z.enum(['ru', 'en']),
    scope: z
      .object({
        aircraft_icao: z.string().min(1).max(8).nullable(),
        period: coachPeriodSchema,
        start: utcDateTimeSchema,
        end: utcDateTimeSchema,
      })
      .strict(),
    totals: z
      .object({
        flights_count: z.number().int().nonnegative(),
        landings_count: z.number().int().nonnegative(),
        eligible_landings: z.number().int().nonnegative(),
      })
      .strict(),
    scores: z
      .object({
        avg_score: z.number().finite().min(0).max(100).nullable(),
        best_score: z.number().int().min(0).max(100).nullable(),
        worst_score: z.number().int().min(0).max(100).nullable(),
        grade_counts: coachGradeCountsSchema,
      })
      .strict(),
    components: z
      .object({
        vertical_speed: coachCriterionSchema,
        g_force: coachCriterionSchema,
        centreline: coachCriterionSchema,
        bounce: coachCriterionSchema,
        attitude: coachCriterionSchema,
        touchdown_zone: coachCriterionSchema,
      })
      .strict(),
    by_aircraft: z
      .array(
        z
          .object({
            icao: aircraftIcaoSchema,
            landings: z.number().int().positive(),
            avg_score: z.number().finite().min(0).max(100),
          })
          .strict(),
      )
      .max(3),
    by_arrival: z
      .array(
        z
          .object({
            icao: airportIcaoSchema,
            landings: z.number().int().positive(),
            avg_score: z.number().finite().min(0).max(100),
          })
          .strict(),
      )
      .max(3),
    weather: z
      .object({
        samples: z.number().int().nonnegative(),
        avg_wind_kt: z.number().finite().nullable(),
        max_gust_kt: z.number().finite().nullable(),
        avg_headwind_kt: z.number().finite().nullable(),
        avg_crosswind_kt: z.number().finite().nullable(),
      })
      .strict(),
    trend: z
      .object({
        first_half_avg: z.number().finite().min(0).max(100).nullable(),
        second_half_avg: z.number().finite().min(0).max(100).nullable(),
        delta: z.number().finite().nullable(),
      })
      .strict(),
    worst_landings: z.array(coachLandingSummarySchema).max(5),
    best_landings: z.array(coachLandingSummarySchema).max(3),
  })
  .strict();
export type CoachInputV1 = z.output<typeof coachInputV1Schema>;

/** CO1: публичный DTO `POST`/`GET /v1/ai/coach`. */
export const aiCoachDtoSchema = z
  .object({
    status: aiReportStatusSchema,
    output: coachOutputSchema.nullable(),
    created_at: utcDateTimeSchema,
    input_fingerprint: z.string().min(1),
    /** CO2: причина `failed` для серверных логов/диагностики, не для UI. */
    error: z.string().nullable(),
  })
  .strict();
export type AiCoachDto = z.output<typeof aiCoachDtoSchema>;

export const aiCoachResponseSchema = z
  .object({ data: aiCoachDtoSchema })
  .strict();
export type AiCoachResponse = z.output<typeof aiCoachResponseSchema>;

export const aiReportSchema = z
  .object({
    id: uuidSchema,
    user_id: uuidSchema,
    flight_id: uuidSchema.nullable(),
    kind: aiReportKindSchema,
    status: aiReportStatusSchema,
    provider: z.string().nullish(),
    model: z.string().nullish(),
    prompt_version: z.string().nullish(),
    content_md: z.string().nullish(),
    error: z.string().nullish(),
    prompt_tokens: z.number().int().nonnegative().nullish(),
    completion_tokens: z.number().int().nonnegative().nullish(),
    created_at: utcDateTimeSchema,
    completed_at: utcDateTimeSchema.nullish(),
  })
  .strict();
export type AiReport = z.output<typeof aiReportSchema>;

/**
 * Публичная форма AI Debrief без `user_id`/служебных полей (F-211, api.md §3.5):
 * её отдают `POST /v1/ai/debrief`, `GET /v1/ai/reports/{id}` и read-endpoint
 * `GET /v1/flights/{id}/debrief`. `output_json` — `DebriefOutputV1`, но валидируется
 * отдельно (`debriefOutputV1Schema`), потому что в БД он хранится как `jsonb`.
 */
export const aiDebriefReportDtoSchema = z
  .object({
    id: uuidSchema,
    kind: aiReportKindSchema,
    status: aiReportStatusSchema,
    flight_id: uuidSchema.nullable(),
    landing_seq: z.number().int().min(1).nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    prompt_version: z.string().nullable(),
    input_fingerprint: z.string().min(1),
    content_md: z.string().nullable(),
    output_json: z.record(z.string(), z.unknown()).nullable(),
    error: z.string().nullable(),
    prompt_tokens: z.number().int().nonnegative().nullable(),
    completion_tokens: z.number().int().nonnegative().nullable(),
    cost_micro_usd: z.number().nullable(),
    cached: z.boolean(),
    created_at: utcDateTimeSchema,
    completed_at: utcDateTimeSchema.nullable(),
    /** T179: курируемый drill; compute-on-read, без LLM. */
    recommended_drill: recommendedDrillSchema.optional(),
  })
  .strict();
export type AiDebriefReportDto = z.output<typeof aiDebriefReportDtoSchema>;

/** Ответ read-endpoint `GET /v1/flights/{id}/debrief` (T133c). */
export const aiDebriefReportResponseSchema = z
  .object({ report: aiDebriefReportDtoSchema.nullable() })
  .strict();
export type AiDebriefReportResponse = z.output<typeof aiDebriefReportResponseSchema>;

/** Aggregated flight data fed to the LLM (never raw telemetry). */
export const flightSummarySchema = z
  .object({
    flight: z
      .object({
        aircraft: z.string().min(1),
        callsign: z.string().nullish(),
        origin: z.string().nullish(),
        destination: z.string().nullish(),
        duration_min: z.number().finite(),
        distance_nm: z.number().finite(),
        max_altitude_ft: z.number().finite(),
      })
      .strict(),
    landing: z
      .object({
        score: z.number().int().min(0).max(100),
        grade: scoreGradeSchema,
        vs_fpm: z.number().int(),
        g_force: z.number().finite(),
        pitch_deg: z.number().finite(),
        bank_deg: z.number().finite(),
        bounce_count: z.number().int().nonnegative(),
        centreline_offset_m: z.number().finite(),
        headwind_kt: z.number().finite().nullish(),
        crosswind_kt: z.number().finite().nullish(),
        runway: z.string().nullish(),
        ...weatherSampleShape,
      })
      .strict(),
    /** Погода рейса (агрегаты; T-weather) — вход AI Debrief. */
    weather: flightWeatherSummarySchema.nullish(),
    phases: z.record(z.string(), z.record(z.string(), z.unknown())),
    events: z.array(
      z
        .object({
          type: z.string().min(1),
          at_sec_from_touchdown: z.number().finite(),
        })
        .strict(),
    ),
    score_components: z.record(z.string(), z.number()),
  })
  .strict();
export type FlightSummary = z.output<typeof flightSummarySchema>;

/** Allowlist метрик для `evidence`/`next_flight_focus` (llm-debrief-prompt.md §4.1). */
export const debriefMetricSchema = z.enum([
  'vs_fpm',
  'g_force',
  'pitch_deg',
  'bank_deg',
  'bounce_count',
  'centreline_offset_m',
  'touchdown_zone',
  'headwind_kt',
  'crosswind_kt',
  'gs_at_1000ft_kt',
  'gs_at_500ft_kt',
  'distance_from_threshold_m',
  'rollout_s',
  'score',
  'score_component',
  'flare_height_ft',
  'wheel_height_touchdown_ft',
]);

const evidenceSchema = z
  .object({
    metric: debriefMetricSchema,
    value: z.union([z.number(), z.string().max(16)]),
    unit: z.string().max(12).optional(),
    /**
     * FOQA-DATUM-1 / §4.1: критерий для `metric: 'score_component'`. Опционально
     * (аддитивно): старые валидные ответы без `component` парсятся как раньше,
     * а первый ответ модели больше не падает на строгой схеме.
     */
    component: scoreComponentSchema.optional(),
  })
  .strict();
export type DebriefEvidence = z.output<typeof evidenceSchema>;

const debriefItemSchema = z
  .object({
    title: z.string().min(3).max(80),
    detail: z.string().min(3).max(280),
    evidence: z.array(evidenceSchema).max(3),
  })
  .strict();
export type DebriefOutputItem = z.output<typeof debriefItemSchema>;

const debriefImprovementSchema = debriefItemSchema
  .extend({
    severity: z.enum(['minor', 'moderate', 'major']),
    drill: z.string().min(3).max(220),
  })
  .strict();

const nextFocusSchema = z
  .object({
    focus: z.string().min(3).max(120),
    target: z.string().min(1).max(100),
    metric: debriefMetricSchema,
  })
  .strict();

/** Allowlist `risk_flags.flag` (llm-debrief-prompt.md §4.1). */
export const riskFlagTypeSchema = z.enum([
  'bounce',
  'hard_touchdown',
  'long_flare',
  'fast_approach',
  'unstable_approach',
  'late_touchdown',
  'off_centreline',
  'weather_challenge',
  'data_quality',
]);

const riskFlagSchema = z
  .object({
    flag: riskFlagTypeSchema,
    severity: z.enum(['minor', 'moderate', 'major']),
    note: z.string().min(3).max(240),
  })
  .strict();
export type RiskFlag = z.output<typeof riskFlagSchema>;

/** Выходной контракт AI Debrief (llm-debrief-prompt.md §4.1). */
export const debriefOutputV1Schema = z
  .object({
    summary: z.string().min(1).max(600),
    what_went_well: z.array(debriefItemSchema).max(2),
    what_to_improve: z.array(debriefImprovementSchema).min(1).max(3),
    next_flight_focus: z.array(nextFocusSchema).min(1).max(3),
    risk_flags: z.array(riskFlagSchema).max(5),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type DebriefOutputV1 = z.output<typeof debriefOutputV1Schema>;

/**
 * WAVE 5 (FOQA): агрегаты подхода/касания **представительной** посадки для AI
 * Debrief (llm-debrief-prompt.md §2.8). Источник — `flights.stats` (скаляры
 * представительной посадки) и `landings.analysis` (`analysis/1`). Все поля
 * nullable: `null` = измерения нет (absent), а не 0. Промпт запрещает упоминать
 * null-метрику и выдумывать значение. Серийные точки (`analysis.series`) в
 * промпт не попадают — только агрегаты.
 *
 * FOQA-DATUM-1: `flare_height_ft`/`radio_height_touchdown_ft` — высоты **опорной
 * точки** (не колёс). Аддитивные `agl_datum_offset_ft`/`height_datum_calibrated`/
 * `flare_height_wheel_ft`/`wheel_height_touchdown_ft` дают калиброванную высоту
 * колёс; отсутствие ключа (старый сборщик) = не калибровано, не подделывать.
 */
export const debriefFoqaSchema = z
  .object({
    config_at_1000ft: flightConfigSnapshotSchema.nullable(),
    config_at_500ft: flightConfigSnapshotSchema.nullable(),
    ap_disconnect_agl_ft: z.number().finite().nullable(),
    at_disconnect_agl_ft: z.number().finite().nullable(),
    flare_height_ft: z.number().finite().nullable(),
    flare_duration_s: z.number().finite().nullable(),
    ils: ilsDeviationStatsSchema.nullable(),
    aoa_touchdown_deg: z.number().finite().nullable(),
    aoa_max_near_touchdown_deg: z.number().finite().nullable(),
    cg_percent_touchdown: z.number().finite().nullable(),
    surface_condition: z.number().int().min(0).max(32).nullable(),
    surface_type: z.number().int().min(0).max(256).nullable(),
    on_any_runway: z.boolean().nullable(),
    touchdown_point: touchdownPointSchema.nullable(),
    radio_height_touchdown_ft: z.number().finite().nullable(),
    agl_datum_offset_ft: z.number().finite().nullable().optional(),
    height_datum_calibrated: z.boolean().optional(),
    flare_height_wheel_ft: z.number().finite().nullable().optional(),
    wheel_height_touchdown_ft: z.number().finite().nullable().optional(),
    // ENGINE-MODE (аддитивно): режим/N1/тяга/реверс на заходе, касании, пробеге.
    engine_at_1000ft: engineAggregateSchema.nullable(),
    engine_at_500ft: engineAggregateSchema.nullable(),
    engine_touchdown: engineAggregateSchema.nullable(),
    engine_rollout: engineAggregateSchema.nullable(),
    wind_shear: windShearSchema.nullable(),
  })
  .strict();
export type DebriefFoqa = z.output<typeof debriefFoqaSchema>;

/**
 * L3: прореженные time-series подхода выбранной посадки (`analysis.series`).
 * Шаг дискретизации документирован сборщиком (~2 с): точки `{t_s, value}`,
 * `t_s` — секунды относительно касания. Все четыре серии обязательны; пустые
 * массивы означают отсутствие измерения.
 */
export const debriefSeriesSchema = z
  .object({
    ils_cdi: z.array(landingAnalysisSeriesPointSchema).max(LANDING_ANALYSIS_SERIES_MAX),
    ils_gsi: z.array(landingAnalysisSeriesPointSchema).max(LANDING_ANALYSIS_SERIES_MAX),
    aoa_deg: z.array(landingAnalysisSeriesPointSchema).max(LANDING_ANALYSIS_SERIES_MAX),
    flaps_percent: z.array(landingAnalysisSeriesPointSchema).max(LANDING_ANALYSIS_SERIES_MAX),
  })
  .strict();
export type DebriefSeries = z.output<typeof debriefSeriesSchema>;

/**
 * L3: полный FOQA-анализ одной посадки (`analysis/1`) + серии. Это тот же
 * набор полей, что и `foqa`, но per-landing (для выбранной посадки сохраняется
 * в `landings[].analysis`).
 */
export const debriefLandingAnalysisSchema = debriefFoqaSchema
  .extend({ series: debriefSeriesSchema })
  .strict();
export type DebriefLandingAnalysis = z.output<typeof debriefLandingAnalysisSchema>;

const debriefComponentsSchema = z
  .object({
    vertical_speed: z.number(),
    g_force: z.number(),
    centreline: z.number(),
    bounce: z.number(),
    attitude: z.number(),
    touchdown_zone: z.number(),
  })
  .strict();

const debriefWeightsSchema = z
  .object({
    vertical_speed: z.number(),
    g_force: z.number(),
    centreline: z.number(),
    bounce: z.number(),
    attitude: z.number(),
    touchdown_zone: z.number(),
  })
  .strict();

/**
 * L3: компактная сводка каждой посадки рейса (`landings[]`). Выбранная
 * посадка дополнительно несёт полный `analysis`; при превышении размера
 * (лестница §2.1) анализа лишаются только остальные посадки.
 */
export const debriefLandingSummarySchema = z
  .object({
    seq: z.number().int().min(1),
    vs_fpm: z.number().int().nullable(),
    g_force: z.number().finite().nullable(),
    pitch_deg: z.number().finite().nullable(),
    bank_deg: z.number().finite().nullable(),
    bounce_count: z.number().int().nonnegative(),
    touch_and_go: z.boolean(),
    centreline_offset_m: z.number().finite().nullable(),
    touchdown_zone: touchdownZoneSchema.nullable(),
    headwind_kt: z.number().finite().nullable(),
    crosswind_kt: z.number().finite().nullable(),
    runway_icao: airportIcaoSchema.nullable(),
    score: z.number().int().min(0).max(100),
    grade: scoreGradeSchema,
    components: debriefComponentsSchema,
    eligible: z.boolean(),
    verified: z.boolean(),
    analysis: debriefLandingAnalysisSchema.optional(),
  })
  .strict();
export type DebriefLandingSummary = z.output<typeof debriefLandingSummarySchema>;

/**
 * Канонический вход AI Debrief (llm-debrief-prompt.md §2.4). Только агрегаты
 * flights/landings/landing_scores/weather/stats — без `track_points`, без PII
 * (callsign/user_id/display_name/идентификаторы) и без свободного текста.
 */
export const debriefInputV1Schema = z
  .object({
    // WAVE 3b: контракт входа расширен посадочной массой (факт/план).
    // WAVE 5: добавлен блок `foqa` (FOQA-агрегаты представительной посадки) →
    // литерал версии обновлён. Имя типа сохранено для совместимости импортов.
    // FOQA-DATUM-1: в `foqa` добавлены калиброванные высоты колёс →
    // `debrief-input/5` (аддитивно; старые ряды без ключей парсятся).
    // ENGINE-MODE: в `foqa` добавлены агрегаты двигателей →
    // `debrief-input/6` (аддитивно; старые ряды без ключей парсятся).
    // A2: банк-метрика — эпизоды и максимум в окне 1000→500 ft →
    // `debrief-input/7` (аддитивно).
    // L3: полный FOQA-контекст (series, все посадки, 200 событий) →
    // `debrief-input/8` (аддитивно).
    schema_version: z.literal('debrief-input/8'),
    language: z.enum(['ru', 'en']),

    flight: z
      .object({
        aircraft_icao: aircraftIcaoSchema,
        origin_icao: airportIcaoSchema.nullable(),
        destination_icao: airportIcaoSchema.nullable(),
        duration_min: z.number().finite().nonnegative(),
        distance_nm: z.number().finite().nonnegative(),
        max_altitude_ft: z.number().finite(),
        /**
         * WAVE 3b: фактическая посадочная масса (кг, из SimVar `TOTAL WEIGHT`).
         * `null` = измерения нет (absent), а не «0». Промпт запрещает упоминать
         * вес, когда он `null`, и выдумывать число.
         */
        landing_weight_kg: z.number().finite().positive().nullable(),
        /**
         * WAVE 3b: плановая посадочная масса из закреплённого плана SimBrief (кг).
         * `null` — план не привязан или поле отсутствует. Не подменяется фактической.
         */
        planned_landing_weight_kg: z.number().finite().positive().nullable(),
      })
      .strict(),

    aircraft: z
      .object({
        icao: aircraftIcaoSchema,
        category: aircraftCategorySchema,
        engines: z.number().int().min(0).max(8).nullable(),
        engine_type: engineTypeSchema.nullable(),
        wing_config: wingConfigSchema.nullable(),
        /** Пороги скоринга для этого типа ВС. */
        vs_soft_fpm: z.number().int().nullable(),
        vs_hard_fpm: z.number().int().nullable(),
      })
      .strict(),

    airport: z
      .object({
        icao: airportIcaoSchema.nullable(),
        elevation_ft: z.number().int().nullable(),
        runway: z
          .object({
            designator: z
              .string()
              .regex(/^[0-9]{2}[LRC]?$/)
              .nullable(),
            heading_deg: z.number().min(0).max(360).nullable(),
            length_m: z.number().int().positive().nullable(),
            width_m: z.number().int().positive().nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict(),

    landing: z
      .object({
        seq: z.number().int().min(1),
        is_best: z.boolean(),
        // Метрики касания: `null` = данных нет (absent), а не «идеальный» 0/1.
        // LLM не должен видеть правдоподобный дефолт там, где измерения нет.
        vs_fpm: z.number().int().nullable(),
        g_force: z.number().finite().nullable(),
        pitch_deg: z.number().finite().nullable(),
        bank_deg: z.number().finite().nullable(),
        bounce_count: z.number().int().nonnegative(),
        bounced: z.boolean(),
        centreline_offset_m: z.number().finite().nullable(),
        touchdown_zone: touchdownZoneSchema.nullable(),
        headwind_kt: z.number().finite().nullable(),
        crosswind_kt: z.number().finite().nullable(),
        distance_from_threshold_m: z.number().finite().nullable(),
        rollout_s: z.number().finite().nullable(),
        ground_contact_s: z.number().finite().nullable(),
        score: z.number().int().min(0).max(100),
        grade: scoreGradeSchema,
        score_version: semverSchema.max(20),
        segmentation_version: semverSchema.max(20),
        confidence: z.number().min(0).max(1),
        eligible: z.boolean(),
        quality_flags: z.number().int().nonnegative(),
        components: debriefComponentsSchema,
        weights: debriefWeightsSchema,
      })
      .strict(),

    weather: z
      .object({
        touchdown: weatherSampleSchema.nullable(),
        avg_wind_dir_deg: z.number().nullable(),
        avg_wind_speed_kt: z.number().nullable(),
        max_wind_speed_kt: z.number().nullable(),
        max_wind_gust_kt: z.number().nullable(),
        avg_temp_c: z.number().nullable(),
        avg_qnh_hpa: z.number().nullable(),
        min_visibility_m: z.number().nullable(),
        precip_max: z.number().int().nullable(),
      })
      .strict(),

    phases: z
      .object({
        takeoff: z
          .object({
            vs_mean_fpm: z.number().nullable(),
            pitch_mean_deg: z.number().nullable(),
          })
          .strict(),
        climb: z
          .object({
            avg_ias_kt: z.number().nullable(),
            avg_vs_fpm: z.number().nullable(),
          })
          .strict(),
        cruise: z
          .object({
            altitude_ft: z.number().nullable(),
            avg_gs_kt: z.number().nullable(),
          })
          .strict(),
        descent: z
          .object({
            avg_vs_fpm: z.number().nullable(),
            max_ias_kt: z.number().nullable(),
          })
          .strict(),
        approach: z
          .object({
            avg_gs_kt: z.number().nullable(),
            gs_at_1000ft_kt: z.number().nullable(),
            gs_at_500ft_kt: z.number().nullable(),
            sink_rate_1000_500_fpm: z.number().nullable(),
          })
          .strict(),
      })
      .strict(),

    stability: z
      .object({
        stabilized_by_1000ft: z.boolean().nullable(),
        stabilized_by_500ft: z.boolean().nullable(),
        gs_variation_kt_1000_500: z.number().nullable(),
        vertical_speed_variation_fpm: z.number().nullable(),
        bank_excursions_count: z.number().int().nonnegative().nullable(),
        bank_max_deg_1000_500: z.number().nullable().optional(),
        stability_version: z.number().int().optional(),
      })
      .strict(),

    events: z
      .array(
        z
          .object({
            type: z.enum([
              'touchdown',
              'bounce',
              'go_around',
              'stall',
              'overspeed',
              'gear_down',
              'gear_up',
            ]),
            at_sec_from_touchdown: z.number().finite(),
          })
          .strict(),
      )
      .max(200),

    session: z
      .object({
        landings_count: z.number().int().nonnegative(),
        best_seq: z.number().int().nullable(),
        best_score: z.number().int().nullable(),
        last_score: z.number().int().nullable(),
        avg_score: z.number().nullable(),
        trend_delta: z.number().nullable(),
      })
      .strict(),

    /**
     * L3: все посадки рейса (компактные метрики/скоринг), у выбранной —
     * полный `analysis` с сериями. Минимум одна (выбранная) посадка.
     */
    landings: z.array(debriefLandingSummarySchema).min(1).max(500),

    /** WAVE 5 (FOQA): агрегаты подхода/касания представительной посадки. */
    foqa: debriefFoqaSchema,
  })
  .strict();
export type DebriefInputV1 = z.output<typeof debriefInputV1Schema>;
