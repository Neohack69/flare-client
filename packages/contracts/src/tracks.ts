import { z } from 'zod';
import { flightStatusSchema } from './flight.js';
import {
  aircraftIcaoSchema,
  airportIcaoSchema,
  latitudeSchema,
  longitudeSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './primitives.js';
import { scoreGradeSchema } from './scoring.js';

/**
 * `GET /v1/tracks` — карта всех рейсов пользователя (T86, api.md §3.2.3).
 *
 * Ответ — GeoJSON `FeatureCollection`: один `Feature` на рейс, `geometry`
 * LineString `[lon, lat, altitude_m]`, `properties` — агрегаты рейса без PII
 * (нет user_id/device_id/callsign). `score`/`grade` — `null`, если касания нет
 * (`no_score`, T29): клиент не подменяет отсутствие балла нулём.
 */
export const trackFeaturePropertiesSchema = z
  .object({
    flight_id: uuidSchema,
    aircraft_icao: aircraftIcaoSchema.nullable(),
    origin_icao: airportIcaoSchema.nullable(),
    destination_icao: airportIcaoSchema.nullable(),
    started_at: utcDateTimeSchema,
    score: z.number().int().min(0).max(100).nullable(),
    grade: scoreGradeSchema.nullable(),
    status: flightStatusSchema,
  })
  .strict();
export type TrackFeatureProperties = z.output<typeof trackFeaturePropertiesSchema>;

/** GeoJSON LineString; высота — третья координата в метрах (MapLibre `[lon, lat, z]`). */
export const trackLineStringSchema = z
  .object({
    type: z.literal('LineString'),
    coordinates: z.array(z.tuple([longitudeSchema, latitudeSchema, z.number().finite()])),
  })
  .strict();

export const trackFeatureSchema = z
  .object({
    type: z.literal('Feature'),
    geometry: trackLineStringSchema,
    properties: trackFeaturePropertiesSchema,
  })
  .strict();
export type TrackFeature = z.output<typeof trackFeatureSchema>;

export const tracksMetaSchema = z
  .object({
    /** Эффективное разрешение: `auto` в ответе не появляется. */
    resolution: z.enum(['full', '1hz']),
    flight_count: z.number().int().nonnegative(),
    point_count: z.number().int().nonnegative(),
    /** Часть точек отброшена из-за cap — карта показывает не весь объём. */
    truncated: z.boolean(),
  })
  .strict();
export type TracksMeta = z.output<typeof tracksMetaSchema>;

export const tracksResponseSchema = z
  .object({
    type: z.literal('FeatureCollection'),
    features: z.array(trackFeatureSchema),
    /** Foreign member (RFC 7946 §6.1): метаданные агрегата, не геометрия. */
    meta: tracksMetaSchema,
  })
  .strict();
export type TracksResponse = z.output<typeof tracksResponseSchema>;
