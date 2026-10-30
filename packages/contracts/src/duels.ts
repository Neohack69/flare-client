import { z } from 'zod';

import { aircraftIcaoSchema, airportIcaoSchema, uuidSchema } from './primitives.js';
import { handleSchema } from './handle.js';
import { friendSchema } from './friends.js';

/** Architect defaults (T177 OPEN #1–#2): Free 3 create/mo + 1 pending; TTL 14d. */
export const DUEL_TTL_DAYS = 14;
export const DUEL_FREE_CREATE_PER_MONTH = 3;
export const DUEL_FREE_MAX_PENDING = 1;
export const DUEL_LIST_CAP = 50;

export const duelStatusSchema = z.enum(['pending', 'resolved', 'expired', 'cancelled']);
export type DuelStatus = z.output<typeof duelStatusSchema>;

export const duelOutcomeSchema = z.enum(['win', 'lose', 'tie']);
export type DuelOutcome = z.output<typeof duelOutcomeSchema>;

export const duelRoleFilterSchema = z.enum(['challenger', 'opponent', 'any']);
export type DuelRoleFilter = z.output<typeof duelRoleFilterSchema>;

export const duelSchema = z
  .object({
    id: uuidSchema,
    status: duelStatusSchema,
    outcome: duelOutcomeSchema.nullable(),
    challenger: friendSchema,
    opponent: friendSchema,
    destination_icao: airportIcaoSchema,
    runway_icao: z.string().min(1).max(8),
    aircraft_icao: aircraftIcaoSchema,
    target_score: z.number().int().min(0).max(100),
    attempt_score: z.number().int().min(0).max(100).nullable(),
    created_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }),
    resolved_at: z.string().datetime({ offset: true }).nullable(),
    /** Raw share token — only after resolved (OPEN #4). Pending → null. */
    share_token: z.string().min(8).max(128).nullable(),
  })
  .strict();
export type Duel = z.output<typeof duelSchema>;

export const duelCreateSchema = z
  .object({
    opponent_handle: handleSchema,
    airport: z
      .string()
      .trim()
      .toUpperCase()
      .pipe(airportIcaoSchema),
    runway: z
      .string()
      .trim()
      .toUpperCase()
      .min(1)
      .max(8),
    aircraft_icao: z
      .string()
      .trim()
      .toUpperCase()
      .pipe(aircraftIcaoSchema),
  })
  .strict();
export type DuelCreate = z.output<typeof duelCreateSchema>;

export const duelListQuerySchema = z
  .object({
    role: duelRoleFilterSchema.default('any'),
    status: duelStatusSchema.optional(),
  })
  .strict();
export type DuelListQuery = z.output<typeof duelListQuerySchema>;

export const duelsListSchema = z
  .object({
    duels: z.array(duelSchema).max(DUEL_LIST_CAP),
  })
  .strict();
export type DuelsList = z.output<typeof duelsListSchema>;

/** Public share card — aggregates only (no AI, track, email). */
export const publicDuelSchema = z
  .object({
    status: z.literal('resolved'),
    outcome: duelOutcomeSchema,
    challenger: z
      .object({
        handle: handleSchema.nullable(),
        display_name: z.string(),
      })
      .strict(),
    opponent: z
      .object({
        handle: handleSchema.nullable(),
        display_name: z.string(),
      })
      .strict(),
    destination_icao: airportIcaoSchema,
    runway_icao: z.string().min(1).max(8),
    aircraft_icao: aircraftIcaoSchema,
    target_score: z.number().int().min(0).max(100),
    attempt_score: z.number().int().min(0).max(100),
    resolved_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type PublicDuel = z.output<typeof publicDuelSchema>;
