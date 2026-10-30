import { z } from 'zod';

import { handleSchema } from './handle.js';
import {
  aircraftIcaoSchema,
  airportIcaoSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './primitives.js';

/** Как текущий пилот связан с найденным. `declined` наружу не отдаём — это снова `none`. */
export const friendRelationSchema = z.enum(['none', 'self', 'friends', 'outgoing', 'incoming']);
export type FriendRelation = z.output<typeof friendRelationSchema>;

export const friendSchema = z
  .object({
    /** Friendship row PK — accept / decline / remove. */
    id: uuidSchema,
    /** Peer user id — activity `?focus=` scroll/highlight. */
    user_id: uuidSchema,
    handle: handleSchema.nullable(),
    display_name: z.string(),
  })
  .strict();
export type Friend = z.output<typeof friendSchema>;

/** Публичный заход друга. Токен — уже опубликованная ссылка `/s/{token}`, не секрет. */
export const friendLandingSchema = z
  .object({
    display_name: z.string(),
    handle: handleSchema.nullable(),
    origin_icao: z.string().nullable(),
    destination_icao: z.string().nullable(),
    aircraft_icao: z.string().nullable(),
    runway_icao: z.string().nullable(),
    score: z.number().int().min(0).max(100),
    /** Свой лучший зачётный балл на той же полосе. `null` — своих посадок там нет. */
    your_best: z.number().int().min(0).max(100).nullable(),
    token: z.string().min(8).max(128),
  })
  .strict();
export type FriendLanding = z.output<typeof friendLandingSchema>;

export const friendsOverviewSchema = z
  .object({
    friends: z.array(friendSchema),
    incoming: z.array(friendSchema),
    outgoing: z.array(friendSchema),
    landings: z.array(friendLandingSchema).max(12),
  })
  .strict();
export type FriendsOverview = z.output<typeof friendsOverviewSchema>;

/** Карточка пилота по точному тегу. `null` в ответе lookup — такого тега нет. */
export const pilotLookupSchema = z
  .object({
    handle: handleSchema,
    display_name: z.string(),
    relation: friendRelationSchema,
    friendship_id: uuidSchema.nullable(),
  })
  .strict();
export type PilotLookup = z.output<typeof pilotLookupSchema>;

export const friendLookupQuerySchema = z
  .object({
    handle: z.string().trim().min(1).max(32),
  })
  .strict();
export type FriendLookupQuery = z.output<typeof friendLookupQuerySchema>;

export const friendAddSchema = z
  .object({
    handle: handleSchema,
  })
  .strict();
export type FriendAdd = z.output<typeof friendAddSchema>;

/** Публичные заходы друзей на одну полосу прилёта. */
export const friendRunwayLandingsSchema = z
  .object({
    landings: z.array(friendLandingSchema).max(8),
  })
  .strict();
export type FriendRunwayLandings = z.output<typeof friendRunwayLandingsSchema>;

/**
 * «Друзья в небе» (docs/architecture/friends-live.md) — presence, не телеметрия.
 * Приёмо-друзья видят только аэропорты/время/фазу/ВС. Координат, высоты, скорости,
 * ВПП и балла в payload нет и не будет (spec D2).
 */

/**
 * Частота poll видимой вкладки. Скрытая вкладка — пауза; клиент добавляет
 * jitter (±20%), чтобы вкладки не били в API синхронно.
 */
export const FRIENDS_LIVE_POLL_AFTER_S = 10;
/** Свежесть последней активности: до — `stale=false`, после — фаза не показывается (spec §5, D5). */
export const FRIENDS_LIVE_FRESH_S = 120;
/** «Тихо»: вероятен офлайн-буфер, строка ещё есть, данные помечены несвежими (spec §5.5). */
export const FRIENDS_LIVE_QUIET_S = 300;
/** Строка исключается из ответа, если нет данных дольше этого порога (spec §5.6, D5). */
export const FRIENDS_LIVE_DROP_S = 900;
export const FRIENDS_LIVE_DEFAULT_LIMIT = 50;
export const FRIENDS_LIVE_MAX_LIMIT = 100;

/**
 * Дефолт `profile_visibility.show_live`, когда ключа нет в jsonb.
 * OWNER DECISION (2026-10-16): **ON для принятых друзей** (opt-out) и доступно
 * Free-плану. Ранее был fail-closed (`false`). Обоснование: отдаваемые данные
 * нечувствительны (аэропорты/фаза/ВС уже публичны для завершённых рейсов),
 * группа взаимная, а пустая вкладка при opt-in — плохой первый опыт. Ключа нет →
 * показываем; друг скрывается явным `show_live=false` (тогда он отсутствует в
 * ответе целиком). Приватность остального не меняется: только принятые друзья,
 * без координат/скорости/балла/ВПП. Миграции не требует — дефолт на чтении.
 */
export const FRIENDS_LIVE_SHOW_LIVE_DEFAULT = true;

/** Именование фаз совпадает с `packages/agent/src/flight/phases.ts` (FLIGHT_PHASES). */
export const friendLivePhaseSchema = z.enum([
  'on_ground',
  'taxi',
  'takeoff',
  'airborne',
  'landing',
]);
export type FriendLivePhase = z.output<typeof friendLivePhaseSchema>;

/** Откуда взялась фаза: честность важнее красоты (spec §2.2). */
export const friendLivePhaseSourceSchema = z.enum(['client', 'derived', 'coarse', 'unknown']);
export type FriendLivePhaseSource = z.output<typeof friendLivePhaseSourceSchema>;

/** Насколько достоверен destination: `known` (факт) > `planned` (SimBrief) > `null` (spec §1.2). */
export const friendLiveDestinationSourceSchema = z.enum(['known', 'planned']);
export type FriendLiveDestinationSource = z.output<typeof friendLiveDestinationSourceSchema>;

export const friendLiveFlightSchema = z
  .object({
    /** id рейса НЕ отдаём: другу не нужен deep-link на чужой рейс (минимизация). */
    origin_icao: airportIcaoSchema.nullable(),
    destination_icao: airportIcaoSchema.nullable(),
    /** `null` — маршрут неизвестен. Из середины трека НЕ выводится (spec §1.2). */
    destination_source: friendLiveDestinationSourceSchema.nullable(),
    route_known: z.boolean(),
    aircraft_icao: aircraftIcaoSchema.nullable(),
    callsign: z.string().nullable(),
    started_at: utcDateTimeSchema,
    elapsed_s: z.number().int().nonnegative(),
    /** `null` — фаза не выводится (нет свежих данных/недостаточно сигналов). */
    phase: friendLivePhaseSchema.nullable(),
    phase_source: friendLivePhaseSourceSchema,
    last_update_at: utcDateTimeSchema.nullable(),
    /** `true` при `age(last_update_at) > FRESH_S`; фаза при этом не показывается. */
    stale: z.boolean(),
  })
  .strict();
export type FriendLiveFlight = z.output<typeof friendLiveFlightSchema>;

export const friendLiveSchema = z
  .object({
    user_id: uuidSchema,
    handle: handleSchema.nullable(),
    display_name: z.string(),
    live: friendLiveFlightSchema,
  })
  .strict();
export type FriendLive = z.output<typeof friendLiveSchema>;

export const friendsLiveQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(FRIENDS_LIVE_MAX_LIMIT)
      .optional()
      .default(FRIENDS_LIVE_DEFAULT_LIMIT),
  })
  .strict();
export type FriendsLiveQuery = z.output<typeof friendsLiveQuerySchema>;

export const friendsLiveResponseSchema = z
  .object({
    data: z.array(friendLiveSchema).max(FRIENDS_LIVE_MAX_LIMIT),
    meta: z
      .object({
        generated_at: utcDateTimeSchema,
        poll_after_s: z.number().int().positive(),
        count: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type FriendsLiveResponse = z.output<typeof friendsLiveResponseSchema>;
