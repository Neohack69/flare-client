import { z } from 'zod';

import { planCodeSchema } from './billing.js';
import { airportIcaoSchema, aircraftIcaoSchema, utcDateTimeSchema } from './primitives.js';
import { scoreGradeSchema } from './scoring.js';

/** Окно клипа относительно касания (t=0), секунды. */
export const touchdownClipWindowSchema = z
  .object({
    t_start_s: z.number().finite(),
    t_end_s: z.number().finite(),
    duration_s: z.number().finite().min(3).max(8),
    has_bounce: z.boolean(),
  })
  .strict();
export type TouchdownClipWindow = z.output<typeof touchdownClipWindowSchema>;

/**
 * T178 poster-first MVP: метаданные постера + окно клипа.
 * Без track_points. MP4 — later (`media: 'poster'`).
 * Arch: docs/architecture/t178-touchdown-clip.md §6.1.
 */
export const touchdownClipSchema = z
  .object({
    available: z.boolean(),
    /** Почему недоступен; при available=true — `ok`. */
    reason: z.enum(['ok', 'no_landing', 'insufficient_track']),
    media: z.literal('poster'),
    window: touchdownClipWindowSchema.nullable(),
    /** Free watermark; Pro/Lifetime/unlimited — false (plan из БД). */
    watermark: z.boolean(),
    plan_code: planCodeSchema,
    landing_seq: z.number().int().min(1).nullable(),
    score: z.number().int().min(0).max(100).nullable(),
    grade: scoreGradeSchema.nullable(),
    vs_fpm: z.number().int().nullable(),
    origin_icao: airportIcaoSchema.nullable(),
    destination_icao: airportIcaoSchema.nullable(),
    runway_icao: z.string().max(32).nullable(),
    aircraft_icao: aircraftIcaoSchema.nullable(),
    touchdown_at: utcDateTimeSchema.nullable(),
    /**
     * Путь `/s/{token}?t=0&mark=touchdown&seq=N&clip=1`, если есть public_token.
     * Иначе null — UI создаёт share через POST /share.
     */
    share_path: z.string().nullable(),
  })
  .strict();
export type TouchdownClip = z.output<typeof touchdownClipSchema>;

export const touchdownClipResponseSchema = z
  .object({ data: touchdownClipSchema })
  .strict();
export type TouchdownClipResponse = z.output<typeof touchdownClipResponseSchema>;
