import { z } from 'zod';

import {
  aircraftIcaoSchema,
  airportIcaoSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './primitives.js';

/** ISO 3166-1 alpha-2 (тот же формат, что `user_countries.country_code`). */
const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/);

/**
 * Налёт по одному типу ВС (ADR-0019 §2.5). `aircraft_icao: null` — бакет
 * «Неизвестно» (`NULL`/`ZZZZ`). Главное значение — `hours` (Σ `airborne_s`);
 * `distance_nm`/`flights` — вторичные. Бакета «Другие» нет по спеке.
 */
export const mapStatsAircraftSchema = z
  .object({
    aircraft_icao: aircraftIcaoSchema.nullable(),
    flights: z.number().int().nonnegative(),
    hours: z.number().nonnegative(),
    distance_nm: z.number().int().nonnegative(),
  })
  .strict();
export type MapStatsAircraft = z.output<typeof mapStatsAircraftSchema>;

/** Самый дальний рейс пользователя (ADR-0019 §2.2). */
export const mapStatsFarthestSchema = z
  .object({
    flight_id: uuidSchema,
    distance_m: z.number().int().nonnegative(),
    distance_nm: z.number().int().nonnegative(),
    distance_km: z.number().int().nonnegative(),
    origin_icao: airportIcaoSchema.nullable(),
    destination_icao: airportIcaoSchema.nullable(),
    aircraft_icao: aircraftIcaoSchema.nullable(),
    started_at: utcDateTimeSchema,
  })
  .strict();
export type MapStatsFarthest = z.output<typeof mapStatsFarthestSchema>;

/** Аэропорт в списке страны (справочные данные OurAirports, без локализации). */
export const mapStatsAirportSchema = z
  .object({
    icao: airportIcaoSchema,
    iata: z.string().nullable(),
    name: z.string().nullable(),
  })
  .strict();
export type MapStatsAirport = z.output<typeof mapStatsAirportSchema>;

/**
 * Посещённая страна (ADR-0019 §2.4). `airport_count` — полное число distinct
 * ICAO (union вылет/прилёт), а `airports` — Top-N (лимит в `meta`).
 */
export const mapStatsCountrySchema = z
  .object({
    country_code: countryCodeSchema,
    airport_count: z.number().int().nonnegative(),
    first_visited_at: utcDateTimeSchema,
    airports: z.array(mapStatsAirportSchema),
  })
  .strict();
export type MapStatsCountry = z.output<typeof mapStatsCountrySchema>;

/**
 * `GET /v1/me/stats/map` (ADR-0019 §4.1). Пустой аккаунт → `200` с нулями,
 * `null` (нет данных ≠ 0) и пустыми массивами; `404` не бывает.
 */
export const mapStatsResponseSchema = z
  .object({
    data: z
      .object({
        totals: z
          .object({
            flights: z.number().int().nonnegative(),
            hours_airborne: z.number().nonnegative(),
            hours_block: z.number().nonnegative(),
            distance_m: z.number().int().nonnegative(),
            distance_nm: z.number().int().nonnegative(),
            distance_km: z.number().int().nonnegative(),
            flights_with_track: z.number().int().nonnegative(),
            /**
             * Рейсы с достоверным `airborne_s` (OPEN-4): честный `—` vs `0`
             * по часам, когда трека нет ни у одного рейса.
             */
            flights_with_airborne: z.number().int().nonnegative(),
            first_flight_at: utcDateTimeSchema.nullable(),
          })
          .strict(),
        farthest_flight: mapStatsFarthestSchema.nullable(),
        countries_count: z.number().int().nonnegative(),
        airports_count: z.number().int().nonnegative(),
        countries: z.array(mapStatsCountrySchema),
        aircraft: z.array(mapStatsAircraftSchema),
      })
      .strict(),
    meta: z
      .object({
        generated_at: utcDateTimeSchema,
        top_aircraft: z.number().int().positive(),
        /**
         * Полное число типов ВС (OPEN-3): UI строит подпись «+ ещё N типов»
         * как `aircraft_total - data.aircraft.length`.
         */
        aircraft_total: z.number().int().nonnegative(),
        /** Типов ВС больше, чем поместилось в Top-N. */
        truncated_aircraft: z.boolean(),
        airports_per_country_limit: z.number().int().positive(),
        truncated_countries: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type MapStatsResponse = z.output<typeof mapStatsResponseSchema>;

/**
 * Одна ISO-неделя в окне «средний балл по неделям» (T102).
 * `week_start` — понедельник недели (`YYYY-MM-DD`) в таймзоне агрегата (`meta.timezone`).
 * `avg_score` — неокруглённое среднее scored-посадок; `null`, если за неделю нет scored.
 * `landings_count` — число scored-посадок (не рейсов).
 */
export const weeklyScoreWeekSchema = z
  .object({
    week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    avg_score: z.number().min(0).max(100).nullable(),
    landings_count: z.number().int().nonnegative(),
  })
  .strict();
export type WeeklyScoreWeek = z.output<typeof weeklyScoreWeekSchema>;

/**
 * `GET /v1/me/stats/weekly-score` (T102): 12 ISO-недель (текущая + 11 предыдущих)
 * + личный рекорд за всё время. Бакетинг — в одной TZ (`meta.timezone`); сейчас
 * UTC (у профиля есть только `locale` языка, отдельной таймзоны нет).
 * Пустой аккаунт → `200` с 12 слотами `avg_score: null` и `personal_best: null`.
 */
export const weeklyScoreResponseSchema = z
  .object({
    data: z
      .object({
        /** Ровно 12 слотов, от старой недели к новой (слева на графике — старее). */
        weeks: z.array(weeklyScoreWeekSchema).length(12),
        /** Лучший балл посадки за всё время (не за окно); `null`, если scored нет. */
        personal_best: z.number().int().min(0).max(100).nullable(),
      })
      .strict(),
    meta: z
      .object({
        generated_at: utcDateTimeSchema,
        /** Единая TZ бакеттинга ISO-недель; не смешивать с локалью подписей UI. */
        timezone: z.literal('UTC'),
        week_count: z.literal(12),
      })
      .strict(),
  })
  .strict();
export type WeeklyScoreResponse = z.output<typeof weeklyScoreResponseSchema>;

/**
 * Skill-family id (T180): catalog slug, singleton `icao:XXXX`, или `unknown`.
 * Длина до 32 — покрывает `icao:` + 4 символа ICAO.
 */
export const skillFamilyIdSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9_]+$|^icao:[A-Z0-9]{2,4}$|^unknown$/);
export type SkillFamilyId = z.output<typeof skillFamilyIdSchema>;

/** Одна ISO-неделя в окне fleet-skills (T180): score + secondary FOQA. */
export const fleetSkillsWeekSchema = z
  .object({
    week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    avg_score: z.number().min(0).max(100).nullable(),
    landings_count: z.number().int().nonnegative(),
    avg_vs_fpm: z.number().nullable(),
    avg_centreline_m: z.number().nonnegative().nullable(),
  })
  .strict();
export type FleetSkillsWeek = z.output<typeof fleetSkillsWeekSchema>;

/**
 * Семейство в `GET /v1/me/stats/fleet-skills`. У Free locked-строки
 * `weeks: null` (не отдаём weekly series даже «заблюренными»).
 */
export const fleetSkillsFamilySchema = z
  .object({
    family_id: skillFamilyIdSchema,
    title_ru: z.string(),
    title_en: z.string(),
    /** ICAO, попавшие в агрегаты пользователя (не полный каталог members). */
    member_icaos: z.array(aircraftIcaoSchema).max(32),
    locked: z.boolean(),
    lock_reason: z.enum(['free_cap']).nullable(),
    lifetime_landings: z.number().int().nonnegative(),
    lifetime_avg_score: z.number().min(0).max(100).nullable(),
    lifetime_best_score: z.number().int().min(0).max(100).nullable(),
    weeks: z.array(fleetSkillsWeekSchema).length(12).nullable(),
  })
  .strict();
export type FleetSkillsFamily = z.output<typeof fleetSkillsFamilySchema>;

/**
 * `GET /v1/me/stats/fleet-skills` (T180): тренды по семейству ВС.
 * Пустой аккаунт → `200` с `families: []`. Free — одно unlocked; Pro+ — все.
 */
export const fleetSkillsResponseSchema = z
  .object({
    data: z
      .object({
        /** Free unlocked family; null если нет qualifying landings. */
        free_family_id: skillFamilyIdSchema.nullable(),
        families: z.array(fleetSkillsFamilySchema),
      })
      .strict(),
    meta: z
      .object({
        generated_at: utcDateTimeSchema,
        timezone: z.literal('UTC'),
        week_count: z.literal(12),
        catalog_version: z.string(),
        entitlement: z
          .object({
            plan_code: z.enum(['free', 'pro', 'lifetime', 'unlimited']),
            all_families: z.boolean(),
            free_family_limit: z.literal(1),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type FleetSkillsResponse = z.output<typeof fleetSkillsResponseSchema>;
