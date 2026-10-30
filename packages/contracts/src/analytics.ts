import { z } from 'zod';

import {
  airportIcaoSchema,
  aircraftIcaoSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './primitives.js';

/**
 * B4/B5: окно аналитики. `month` — текущий календарный месяц UTC
 * [1-е 00:00 → now]; `90d` — последние 90×24h. Границы считает сервер
 * (детерминированно), клиент только передаёт ключ.
 */
export const analyticsPeriodSchema = z.enum(['month', '90d']);
export type AnalyticsPeriod = z.output<typeof analyticsPeriodSchema>;

export const analyticsQuerySchema = z
  .object({ period: analyticsPeriodSchema.default('month') })
  .strict();
export type AnalyticsQuery = z.output<typeof analyticsQuerySchema>;

export const analyticsTotalsSchema = z
  .object({
    flights: z.number().int().nonnegative(),
    landings: z.number().int().nonnegative(),
    pilots: z.number().int().nonnegative(),
  })
  .strict();
export type AnalyticsTotals = z.output<typeof analyticsTotalsSchema>;

const scoreRowShape = {
  count: z.number().int().nonnegative(),
  best_score: z.number().int().min(0).max(100),
  avg_score: z.number().finite().min(0).max(100),
};

/** B4: строка таблицы пилотов клуба (только активные участники с посадками). */
export const clubAnalyticsPilotSchema = z
  .object({
    user_id: uuidSchema,
    handle: z.string().nullable(),
    display_name: z.string(),
    flights: z.number().int().nonnegative(),
    best_score: z.number().int().min(0).max(100),
    avg_score: z.number().finite().min(0).max(100),
    avg_vs_fpm: z.number().finite().nullable(),
  })
  .strict();
export type ClubAnalyticsPilot = z.output<typeof clubAnalyticsPilotSchema>;

export const clubAnalyticsAircraftSchema = z
  .object({
    aircraft_icao: aircraftIcaoSchema,
    ...scoreRowShape,
  })
  .strict();
export type ClubAnalyticsAircraft = z.output<typeof clubAnalyticsAircraftSchema>;

export const clubAnalyticsRunwaySchema = z
  .object({
    destination_icao: airportIcaoSchema,
    runway_icao: z.string().min(1).max(8).nullable(),
    ...scoreRowShape,
  })
  .strict();
export type ClubAnalyticsRunway = z.output<typeof clubAnalyticsRunwaySchema>;

/** B4: `GET /v1/clubs/:id/analytics?period=month|90d`. */
export const clubAnalyticsSchema = z
  .object({
    period: analyticsPeriodSchema,
    from: utcDateTimeSchema,
    to: utcDateTimeSchema,
    totals: analyticsTotalsSchema,
    pilots: z.array(clubAnalyticsPilotSchema).max(50),
    aircraft: z.array(clubAnalyticsAircraftSchema).max(3),
    runways: z.array(clubAnalyticsRunwaySchema).max(3),
  })
  .strict();
export type ClubAnalytics = z.output<typeof clubAnalyticsSchema>;

/** B5: точка графика — день (`month`) или ISO-неделя (`90d`), начало UTC. */
export const personalTrendBucketSchema = z.enum(['day', 'week']);
export type PersonalTrendBucket = z.output<typeof personalTrendBucketSchema>;

export const personalTrendPointSchema = z
  .object({
    bucket_start: utcDateTimeSchema,
    flights: z.number().int().nonnegative(),
    landings: z.number().int().nonnegative(),
    avg_score: z.number().finite().min(0).max(100).nullable(),
    best_score: z.number().int().min(0).max(100).nullable(),
  })
  .strict();
export type PersonalTrendPoint = z.output<typeof personalTrendPointSchema>;

export const personalTrendRunwayRecordSchema = z
  .object({
    destination_icao: airportIcaoSchema,
    runway_icao: z.string().min(1).max(8).nullable(),
    ...scoreRowShape,
  })
  .strict();
export type PersonalTrendRunwayRecord = z.output<typeof personalTrendRunwayRecordSchema>;

export const personalTrendAircraftRecordSchema = z
  .object({
    aircraft_icao: aircraftIcaoSchema,
    ...scoreRowShape,
  })
  .strict();
export type PersonalTrendAircraftRecord = z.output<typeof personalTrendAircraftRecordSchema>;

/** B5: `GET /v1/me/trends?period=month|90d` (приватно, Pro). */
export const mePeriodTrendsSchema = z
  .object({
    period: analyticsPeriodSchema,
    bucket: personalTrendBucketSchema,
    from: utcDateTimeSchema,
    to: utcDateTimeSchema,
    totals: analyticsTotalsSchema,
    /** Средний и лучший балл за окно — серверные агрегаты (не клиентская математика). */
    avg_score: z.number().finite().min(0).max(100).nullable(),
    best_score: z.number().int().min(0).max(100).nullable(),
    points: z.array(personalTrendPointSchema).max(32),
    records: z
      .object({
        runways: z.array(personalTrendRunwayRecordSchema).max(3),
        aircraft: z.array(personalTrendAircraftRecordSchema).max(3),
      })
      .strict(),
    /** Выборочное стандартное отклонение баллов; `null` при <2 посадках. */
    consistency: z.number().finite().nonnegative().nullable(),
    /** `true`, если баллы сравнивать не с чем: `consistency = null`. */
    consistency_thin: z.boolean(),
  })
  .strict();
export type MePeriodTrends = z.output<typeof mePeriodTrendsSchema>;
