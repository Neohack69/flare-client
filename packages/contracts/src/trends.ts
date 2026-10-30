import { z } from 'zod';

import { analyticsPeriodSchema, mePeriodTrendsSchema } from './analytics.js';
import { utcDateTimeSchema, uuidSchema } from './primitives.js';

/**
 * WAVE 5 (part C): «личные тренды» — сравнение конкретной посадки с историей
 * самого пилота. Сервер считает агрегаты по bounded-окну (последние N посадок /
 * последние 90 дней), клиент только рисует. Приватно (`scope: web`), никаких
 * данных других пилотов.
 */

/** Окно сравнения: не старше N дней. */
export const PERSONAL_TRENDS_WINDOW_DAYS = 90;
/** Жёсткий предел числа посадок в сравнении (bound на объём выборки). */
export const PERSONAL_TRENDS_MAX_LANDINGS = 200;
/** Меньше этого числа чужих посадок в скоупе — «мало данных» (percentile `null`). */
export const PERSONAL_TRENDS_MIN_SCOPE = 5;
/** Минимум посадок для направления недавнего тренда (2+2). */
export const PERSONAL_TRENDS_TREND_MIN = 4;
/** Сколько последних посадок участвуют в «недавней динамике». */
export const PERSONAL_TRENDS_TREND_WINDOW = 12;

/** `GET /v1/me/trends` — какие посадку/рейс сравниваем с историей. */
export const meTrendsQuerySchema = z
  .object({
    flight_id: uuidSchema,
    /** Номер посадки сессии; без него берётся лучшая зачётная посадка рейса. */
    seq: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type MeTrendsQuery = z.output<typeof meTrendsQuerySchema>;

/** Направление недавней динамики метрики. `null` — данных мало (unknown). */
export const personalTrendDirectionSchema = z.enum(['improving', 'worsening', 'flat']);
export type PersonalTrendDirection = z.output<typeof personalTrendDirectionSchema>;

/**
 * Агрегаты одного скоупа сравнения (все посадки / этот тип ВС / эта ВПП).
 * `percentile`/`thin` — относительно *других* посадок пилота: сама сравниваемая
 * посадка из выборки исключена. `null` — истории нет.
 */
export const personalTrendScopeSchema = z
  .object({
    /** Число прошлых посадок в скоупе. */
    landings: z.number().int().nonnegative(),
    /** Перцентиль балла этой посадки (0..100); `null` — мало данных. */
    percentile: z.number().int().min(0).max(100).nullable(),
    best_score: z.number().min(0).max(100).nullable(),
    worst_score: z.number().min(0).max(100).nullable(),
    avg_score: z.number().finite().nullable(),
    avg_vs_fpm: z.number().finite().nullable(),
    avg_g_force: z.number().finite().nullable(),
    /** `true` — меньше `PERSONAL_TRENDS_MIN_SCOPE` посадок: тренд ненадёжен. */
    thin: z.boolean(),
  })
  .strict();
export type PersonalTrendScope = z.output<typeof personalTrendScopeSchema>;

/** Недавняя динамика одной метрики (вторая половина окна минус первая). */
export const personalTrendMetricSchema = z
  .object({
    /** Разница средних «недавно − раньше» в единицах метрики; `null` — мало данных. */
    delta: z.number().finite().nullable(),
    direction: personalTrendDirectionSchema.nullable(),
    samples: z.number().int().nonnegative(),
  })
  .strict();
export type PersonalTrendMetric = z.output<typeof personalTrendMetricSchema>;

export const personalTrendMetricsSchema = z
  .object({
    vs_fpm: personalTrendMetricSchema,
    centreline_m: personalTrendMetricSchema,
    bounce: personalTrendMetricSchema,
  })
  .strict();
export type PersonalTrendMetrics = z.output<typeof personalTrendMetricsSchema>;

/** `GET /v1/me/trends` — приватные тренды пилота по конкретной посадке. */
export const meTrendsSchema = z
  .object({
    flight_id: uuidSchema,
    /** Выбранная (или лучшая) посадка; `null` — у рейса нет зачётных посадок. */
    landing_seq: z.number().int().positive().nullable(),
    window_days: z.number().int().positive(),
    max_landings: z.number().int().positive(),
    /** Начало окна сравнения (UTC). */
    from: utcDateTimeSchema,
    overall: personalTrendScopeSchema.nullable(),
    /** Скоуп «тот же тип ВС»; `null` — тип неизвестен/истории нет. */
    aircraft: personalTrendScopeSchema.nullable(),
    /** Скоуп «тот же аэропорт/полоса»; `null` — ВПП/аэропорт неизвестны. */
    runway: personalTrendScopeSchema.nullable(),
    metrics: personalTrendMetricsSchema.nullable(),
  })
  .strict();
export type MeTrends = z.output<typeof meTrendsSchema>;

/** B5: `GET /v1/me/trends?period=month|90d` — агрегаты за окно (без `flight_id`). */
export const mePeriodTrendsQuerySchema = z
  .object({ period: analyticsPeriodSchema.default('month') })
  .strict();
export type MePeriodTrendsQuery = z.output<typeof mePeriodTrendsQuerySchema>;

/**
 * Один маршрут `/v1/me/trends` обслуживает два режима: legacy-тренд по рейсу
 * (`flight_id`) и B5-агрегаты за период (`period`). Схемы strict, поэтому
 * смешивать параметры нельзя.
 */
export const meTrendsRequestSchema = z.union([meTrendsQuerySchema, mePeriodTrendsQuerySchema]);
export type MeTrendsRequest = z.output<typeof meTrendsRequestSchema>;

export const meTrendsResponseSchema = z.union([meTrendsSchema, mePeriodTrendsSchema]);
export type MeTrendsResponse = z.output<typeof meTrendsResponseSchema>;
