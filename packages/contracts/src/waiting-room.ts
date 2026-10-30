import { z } from 'zod';

import { planCodeSchema } from './billing.js';
import { aircraftIcaoSchema, airportIcaoSchema, utcDateTimeSchema, uuidSchema } from './primitives.js';
import { scoreGradeSchema } from './scoring.js';

/**
 * T181 — «зал ожидания посадки» (second screen на телефоне).
 * Статус derived из devices/flights/landings; без отдельного telemetry pipe.
 */

export const WAITING_ROOM_CATALOG_VERSION = 'waiting-room@1.0.0' as const;
export const WAITING_ROOM_POLL_AFTER_S = 15;
export const WAITING_ROOM_RECORDING_FRESH_S = 120;
export const WAITING_ROOM_TOUCHDOWN_HOLD_S = 120;

export const waitingRoomPhaseSchema = z.enum([
  'no_device',
  'idle',
  'recording',
  'recording_stale',
  'touchdown_recent',
  'syncing',
  'offline_device',
]);
export type WaitingRoomPhase = z.output<typeof waitingRoomPhaseSchema>;

export const waitingRoomSyncHealthSchema = z.enum(['live', 'quiet', 'stale', 'unknown']);
export type WaitingRoomSyncHealth = z.output<typeof waitingRoomSyncHealthSchema>;

export const waitingRoomSyncHintSchema = z.enum([
  'ok',
  'waiting_points',
  'device_quiet',
  'offline_buffer_likely',
]);
export type WaitingRoomSyncHint = z.output<typeof waitingRoomSyncHintSchema>;

export const waitingRoomSyncSchema = z
  .object({
    health: waitingRoomSyncHealthSchema,
    last_activity_at: utcDateTimeSchema.nullable(),
    lag_s: z.number().int().nonnegative().nullable(),
    hint: waitingRoomSyncHintSchema,
    /** OPEN #1: только при heartbeat; в v1 всегда null. */
    pending_points: z.number().int().nonnegative().nullable(),
    pending_events: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type WaitingRoomSync = z.output<typeof waitingRoomSyncSchema>;

export const waitingRoomDeviceSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(64),
    platform: z.string().nullable(),
    source: z.string().nullable(),
    last_seen_at: utcDateTimeSchema.nullable(),
    view_status: z.enum(['active', 'stale', 'archived', 'revoked']),
  })
  .strict();
export type WaitingRoomDevice = z.output<typeof waitingRoomDeviceSchema>;

export const waitingRoomActiveFlightSchema = z
  .object({
    id: uuidSchema,
    aircraft_icao: aircraftIcaoSchema.nullable(),
    origin_icao: airportIcaoSchema.nullable(),
    started_at: utcDateTimeSchema,
    point_count: z.number().int().nonnegative(),
    last_activity_at: utcDateTimeSchema.nullable(),
  })
  .strict();
export type WaitingRoomActiveFlight = z.output<typeof waitingRoomActiveFlightSchema>;

export const waitingRoomLandingSchema = z
  .object({
    flight_id: uuidSchema,
    landing_seq: z.number().int().positive(),
    aircraft_icao: aircraftIcaoSchema.nullable(),
    origin_icao: airportIcaoSchema.nullable(),
    destination_icao: airportIcaoSchema.nullable(),
    runway_icao: z.string().min(1).max(8).nullable(),
    score: z.number().min(0).max(100).nullable(),
    grade: scoreGradeSchema.nullable(),
    vs_fpm: z.number().nullable(),
    touchdown_at: utcDateTimeSchema.nullable(),
  })
  .strict();
export type WaitingRoomLanding = z.output<typeof waitingRoomLandingSchema>;

export const waitingRoomEntitlementsSchema = z
  .object({
    plan_code: planCodeSchema,
    push_enabled: z.boolean(),
    telegram_rich: z.boolean(),
  })
  .strict();
export type WaitingRoomEntitlements = z.output<typeof waitingRoomEntitlementsSchema>;

export const waitingRoomPrefsSchema = z
  .object({
    web_push_opt_in: z.boolean(),
    telegram_opt_in: z.boolean(),
    telegram_linked: z.boolean(),
    /** Ops: бот ещё не подключён → UI «скоро», emit no-op. */
    telegram_available: z.boolean(),
    /**
     * A-01: реально ли сервер доставляет Web Push (есть service-worker/ключи).
     * Пока `false`: opt-in не персистится (нет канала доставки), UI не должен
     * показывать тумблер как рабочий.
     */
    web_push_available: z.boolean(),
  })
  .strict();
export type WaitingRoomPrefs = z.output<typeof waitingRoomPrefsSchema>;

export const waitingRoomPrefsPatchSchema = z
  .object({
    web_push_opt_in: z.boolean().optional(),
    telegram_opt_in: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.web_push_opt_in !== undefined || body.telegram_opt_in !== undefined, {
    message: 'at least one pref required',
  });
export type WaitingRoomPrefsPatch = z.output<typeof waitingRoomPrefsPatchSchema>;

export const waitingRoomDataSchema = z
  .object({
    phase: waitingRoomPhaseSchema,
    sync: waitingRoomSyncSchema,
    device: waitingRoomDeviceSchema.nullable(),
    active_flight: waitingRoomActiveFlightSchema.nullable(),
    last_landing: waitingRoomLandingSchema.nullable(),
    entitlements: waitingRoomEntitlementsSchema,
    prefs: waitingRoomPrefsSchema,
  })
  .strict();
export type WaitingRoomData = z.output<typeof waitingRoomDataSchema>;

export const waitingRoomMetaSchema = z
  .object({
    generated_at: utcDateTimeSchema,
    poll_after_s: z.number().int().positive(),
    catalog_version: z.literal(WAITING_ROOM_CATALOG_VERSION),
  })
  .strict();
export type WaitingRoomMeta = z.output<typeof waitingRoomMetaSchema>;

export const waitingRoomResponseSchema = z
  .object({
    data: waitingRoomDataSchema,
    meta: waitingRoomMetaSchema,
  })
  .strict();
export type WaitingRoomResponse = z.output<typeof waitingRoomResponseSchema>;

/** Pro / Lifetime / unlimited — push/Telegram каналы. */
export function planAllowsWaitingRoomPush(planCode: string): boolean {
  return planCode === 'pro' || planCode === 'lifetime' || planCode === 'unlimited';
}
