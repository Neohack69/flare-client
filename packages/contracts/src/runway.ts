import { z } from 'zod';
import { airportIcaoSchema } from './primitives.js';

/**
 * Источник геометрии ВПП (T100): OurAirports или синтетика клиента.
 * `heading_deg` — значение справочника (OurAirports; на практике магнитное),
 * `heading_deg_true` — истинный курс оси, вычисленный по координатам торцов.
 */
export const runwaySourceSchema = z.enum(['ourairports', 'synthetic', 'sim']);
export type RunwaySource = z.output<typeof runwaySourceSchema>;

/**
 * Provenance пер-посадочного подбора ВПП (`landings.runway_match`): `position` —
 * по координатам касания (T5), `median`/`heading` — legacy-подбор по курсу,
 * `longest` — последний legacy-fallback, `none` — полоса не разрешена.
 */
export const runwayMatchSchema = z.enum([
  'position',
  'median',
  'heading',
  'longest',
  'none',
  'sim',
]);
export type RunwayMatch = z.output<typeof runwayMatchSchema>;

export const runwaySchema = z
  .object({
    airport_icao: airportIcaoSchema,
    designator: z.string().min(1).max(8),
    length_m: z.number().int().positive(),
    width_m: z.number().int().positive().nullable().default(null),
    heading_deg: z.number().min(0).max(360),
    source: runwaySourceSchema,
    /** Широта прилётного порога (OurAirports). Нет — реплей ставит касание на 15% длины. */
    threshold_lat: z.number().finite().gte(-90).lte(90).nullable().optional(),
    /** Долгота прилётного порога (OurAirports). */
    threshold_lon: z.number().finite().gte(-180).lte(180).nullable().optional(),
    /** Широта дальнего торца (конца полосы в направлении посадки). */
    end_lat: z.number().finite().gte(-90).lte(90).nullable().optional(),
    /** Долгота дальнего торца. */
    end_lon: z.number().finite().gte(-180).lte(180).nullable().optional(),
    /**
     * Истинный курс оси в направлении посадки, °. Геометрия касания и ветровые
     * составляющие используют его; `heading_deg` — значение справочника.
     */
    heading_deg_true: z.number().min(0).max(360).nullable().optional(),
  })
  .strict();
export type Runway = z.output<typeof runwaySchema>;

/**
 * R1: runway geometry supplied by the simulator itself (X-Plane apt.dat or
 * MSFS ATC RUNWAY values), sent as `/complete.sim_runway`. Coordinates are
 * WGS84, distances in metres, `heading_deg` is true heading threshold→end.
 */
export const simRunwayEndSchema = z
  .object({
    lat: z.number().finite().gte(-90).lte(90),
    lon: z.number().finite().gte(-180).lte(180),
    elev_ft: z.number().finite().nullable().optional(),
  })
  .strict();
export type SimRunwayEnd = z.output<typeof simRunwayEndSchema>;

export const simRunwaySchema = z
  .object({
    ident: z.string().trim().min(1).max(8),
    threshold: simRunwayEndSchema,
    end: simRunwayEndSchema,
    width_m: z.number().finite().min(15).max(100),
    length_m: z.number().finite().min(500).max(6000),
    heading_deg: z.number().finite().min(0).max(360),
    surface_code: z.number().int().min(0).max(256).nullable().optional(),
  })
  .strict();
export type SimRunway = z.output<typeof simRunwaySchema>;
