import { z } from 'zod';
import { aircraftSummarySchema } from './aircraft.js';
import { CLUB_NAME_MAX, clubBrandColorSchema } from './clubs.js';
import { paginationMetaSchema } from './errors.js';
import {
  flightStatusSchema,
  flightVisibilitySchema,
  runwaySchema,
  trackPointsResponseSchema,
} from './flight.js';
import {
  aircraftIcaoSchema,
  airportIcaoSchema,
  callsignSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './primitives.js';
import { qualityFlagsSchema } from './quality.js';
import { embeddedScoreSchema, landingSummarySchema } from './scoring.js';
import { levelBadgeSchema } from './gamification.js';
import { flightWeatherSummarySchema } from './weather.js';

export const shareRequestSchema = z
  .object({
    expires_in_days: z.number().int().positive().max(365).optional(),
  })
  .strict();
export type ShareRequest = z.output<typeof shareRequestSchema>;

/** Ответ на создание ссылки (api.md §3.4): сырой токен отдаётся ровно один раз. */
export const shareLinkSchema = z
  .object({
    token: z.string().min(22),
    url: z.string().url(),
    expires_at: utcDateTimeSchema.nullable(),
  })
  .strict();
export type ShareLink = z.output<typeof shareLinkSchema>;

/**
 * Метаданные существующей ссылки для владельца (GET /v1/flights/{id}/shares).
 * Сырой токен не хранится (SHARE-1: в БД только хэш) и потому не возвращается.
 */
export const shareLinkMetadataSchema = z
  .object({
    id: uuidSchema,
    expires_at: utcDateTimeSchema.nullable(),
    revoked_at: utcDateTimeSchema.nullable(),
    created_at: utcDateTimeSchema,
    views: z.number().int().nonnegative(),
    active: z.boolean(),
  })
  .strict();
export type ShareLinkMetadata = z.output<typeof shareLinkMetadataSchema>;

export const shareLinksResponseSchema = z
  .object({ data: z.array(shareLinkMetadataSchema) })
  .strict();
export type ShareLinksResponse = z.output<typeof shareLinksResponseSchema>;

/** Качество рейса, допустимое к публикации (без служебных полей). */
export const publicFlightQualitySchema = z
  .object({
    is_partial: z.boolean(),
    leaderboard_eligible: z.boolean(),
    quality_flags: qualityFlagsSchema,
  })
  .strict();
export type PublicFlightQuality = z.output<typeof publicFlightQualitySchema>;

/**
 * Санитизированная посадка для публичной страницы (ADR-0010, api.md §3.4):
 * без `id`/`verified`/`quality_flags`/`xp_awarded` (внутренние поля) и без
 * `analysis` (FOQA-деталь — приватная). Метрики касания и балл — публичны
 * (как в приватном debrief).
 */
export const publicLandingSummarySchema = landingSummarySchema
  .omit({ id: true, verified: true, quality_flags: true, xp_awarded: true, analysis: true })
  .strict();
export type PublicLandingSummary = z.output<typeof publicLandingSummarySchema>;

/**
 * B3: club branding on the public debrief. Present only for `visibility='public'`
 * flights whose pilot is an active member of a club with a brand colour.
 * `name` is rendered as text (React escapes it), never as HTML.
 */
export const publicClubBrandSchema = z
  .object({
    name: z.string().trim().min(1).max(CLUB_NAME_MAX),
    brand_color: clubBrandColorSchema,
  })
  .strict();
export type PublicClubBrand = z.output<typeof publicClubBrandSchema>;

/**
 * Публичная проекция рейса (GET /v1/public/flights/{token}): whitelist полей —
 * маршрут/ВС/даты/балл/качество. Никаких `user_id`, `device_id`, `client_flight_id`,
 * email, IP и прочих служебных полей (SHARE-3).
 */
export const publicFlightSchema = z
  .object({
    id: uuidSchema,
    aircraft_icao: aircraftIcaoSchema.nullable(),
    aircraft: aircraftSummarySchema.nullable(),
    callsign: callsignSchema.nullable(),
    origin_icao: airportIcaoSchema.nullable(),
    destination_icao: airportIcaoSchema.nullable(),
    status: flightStatusSchema,
    /**
     * Видимость рейса (SEO S6): публичный debrief индексируется только при
     * `public`; `unlisted`/`private` — `noindex` (seo.md §6.1). Не PII.
     * Дефолт `private` — аддитивно: старые payload без поля трактуются
     * безопасно (noindex), а не как индексируемые.
     */
    visibility: flightVisibilitySchema.default('private'),
    /**
     * Канонический (первичный) публичный токен рейса (BUG-SEO-01): самый ранний
     * активный `public_token`. У одного рейса может быть несколько share-ссылок,
     * но индексируемая — ровно одна (seo.md §6.2): alias-страницы ссылаются на
     * этот токен и не индексируются. `null` — для `unlisted`/`private` или если
     * активной публичной ссылки нет. Аддитивно: старые payload — `null` (self-
     * canonical), поведение не меняется.
     */
    canonical_token: z.string().min(1).nullable().default(null),
    started_at: utcDateTimeSchema,
    ended_at: utcDateTimeSchema.nullable(),
    duration_s: z.number().int().nonnegative().nullable(),
    distance_m: z.number().int().nonnegative().nullable(),
    max_altitude_ft: z.number().int().nullable(),
    touchdown_at: utcDateTimeSchema.nullable(),
    score: embeddedScoreSchema.nullable(),
    /** Число посадок сессии (0 при `no_score`); аддитивно (ADR-0010). */
    landings_count: z.number().int().nonnegative().default(0),
    /** Санитизированный список посадок (без `id`/внутренних флагов). */
    landings: z.array(publicLandingSummarySchema).default([]),
    /** Прилётная ВПП (T100) — публичная, не содержит PII. */
    runway: runwaySchema.nullable().default(null),
    /**
     * Погодная сводка рейса (T-weather). Не содержит PII; `null` — нет данных.
     */
    weather: flightWeatherSummarySchema.nullable().default(null),
    /**
     * Уровень пилота для публичного debrief (T111, gamification.md §5.3):
     * анонимно, только при `users.profile_visibility.show_level`. Иначе `null`
     * (элемент отсутствует целиком, не «скрыт»).
     */
    level_badge: levelBadgeSchema.nullable().default(null),
    /** B3: бренд клуба пилота — только для public-рейсов (см. `publicClubBrandSchema`). */
    club_brand: publicClubBrandSchema.nullable().default(null),
    quality: publicFlightQualitySchema,
  })
  .strict();
export type PublicFlight = z.output<typeof publicFlightSchema>;

/**
 * Публичный агрегированный трек (GET /v1/public/flights/{token}/track).
 * Та же read-модель, что у приватного трека: без `client_point_id` и PII;
 * сервер отдаёт её в разрешении 1 Гц (агрегация).
 */
export const publicTrackResponseSchema = trackPointsResponseSchema;
export type PublicTrackResponse = z.output<typeof publicTrackResponseSchema>;

/**
 * Элемент публичного листинга `GET /v1/public/debriefs` (SEO S3/S6): только
 * `public` + `leaderboard_eligible` + есть score и трек. Whitelist без PII —
 * `token` (публичный URL debrief), маршрут и флаги качества. `token` доступен
 * только для публичных ссылок; unlisted/private в листинг не попадают.
 */
export const publicDebriefListItemSchema = z
  .object({
    token: z.string().min(1),
    visibility: flightVisibilitySchema,
    leaderboard_eligible: z.boolean(),
    has_score: z.boolean(),
    has_track: z.boolean(),
    origin_icao: airportIcaoSchema.nullable(),
    destination_icao: airportIcaoSchema.nullable(),
    updated_at: utcDateTimeSchema.nullable(),
  })
  .strict();
export type PublicDebriefListItem = z.output<typeof publicDebriefListItemSchema>;

/** Ответ листинга: `data` + keyset-пагинация (`meta.next_cursor`/`has_more`). */
export const publicDebriefListResponseSchema = z
  .object({
    data: z.array(publicDebriefListItemSchema),
    meta: paginationMetaSchema,
  })
  .strict();
export type PublicDebriefListResponse = z.output<typeof publicDebriefListResponseSchema>;
