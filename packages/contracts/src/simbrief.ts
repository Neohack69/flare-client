import { z } from 'zod';

import { utcDateTimeSchema } from './primitives.js';

/**
 * Имя пилота SimBrief или числовой user id. Только безопасный набор символов:
 * из него собирается query официального fetcher, и больше ничего.
 */
export const simbriefUsernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Точка маршрута OFP: идентификатор и координаты, без топлива и текста navlog. */
export const simbriefFixSchema = z
  .object({
    ident: z.string().trim().min(1).max(8),
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180),
  })
  .strict();
export type SimbriefFix = z.output<typeof simbriefFixSchema>;

/** Последний загруженный OFP: нормализованные поля, без сырого navlog. */
export const simbriefPlanSchema = z
  .object({
    origin_icao: z.string().nullable(),
    destination_icao: z.string().nullable(),
    alternate_icao: z.string().nullable(),
    aircraft_icao: z.string().nullable(),
    flight_number: z.string().nullable(),
    cruise_altitude_ft: z.number().int().nonnegative().nullable(),
    route: z.string().nullable(),
    enroute_seconds: z.number().int().nonnegative().nullable(),
    fuel_burn: z.number().int().nonnegative().nullable(),
    fuel_unit: z.enum(['lb', 'kg']).nullable(),
    /**
     * WAVE 3b: плановая посадочная масса OFP, нормализованная в кг. `null` —
     * поля нет или не распознана единица (не «0»). Аддитивно и nullable.
     */
    landing_weight_kg: z.number().int().nonnegative().nullable(),
    fixes: z.array(simbriefFixSchema).max(80),
    fetched_at: utcDateTimeSchema,
  })
  .strict();
export type SimbriefPlan = z.output<typeof simbriefPlanSchema>;

/** `GET/POST /v1/me/simbrief`: сохранённое имя и последний план (или пусто). */
export const simbriefStatusSchema = z
  .object({
    username: simbriefUsernameSchema.nullable(),
    plan: simbriefPlanSchema.nullable(),
  })
  .strict();
export type SimbriefStatus = z.output<typeof simbriefStatusSchema>;

/** `POST /v1/me/simbrief`: сохранить имя и сразу запросить последний план. */
export const simbriefLoadSchema = z
  .object({
    username: simbriefUsernameSchema,
  })
  .strict();
export type SimbriefLoad = z.output<typeof simbriefLoadSchema>;

/** `GET /v1/flights/{id}/simbrief`: план, закреплённый за этим рейсом, или пусто. */
export const simbriefFlightSchema = z
  .object({
    plan: simbriefPlanSchema.nullable(),
  })
  .strict();
export type SimbriefFlight = z.output<typeof simbriefFlightSchema>;
