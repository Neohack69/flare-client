import {
  flightEventSchema,
  sanitizeRequiredNumber,
  sanitizeOptionalNumber,
  TRACK_NUMBER_RULES,
  trackPointSchema,
  type FlightEvent,
  type FlightEventType,
  type TrackPoint,
} from '@flightlog/contracts';

import type { TelemetrySample } from '../sim/types.js';

export interface TrackPointOptions {
  /** UUID v4 точки; генерируется один раз при материализации (ADR-0007). */
  clientPointId: string;
  /** Битовая маска качества точки (api.md §3.3.1). */
  quality?: number;
}

/** Нормализация курса в диапазон [0, 360). */
export function normalizeHeading(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Формирование `TrackPoint` строго по схеме `@flightlog/contracts` (T9).
 * Значения санитизируются, чтобы аномальный сэмпл сима не ронял рекордер.
 */
export function toTrackPoint(
  sample: TelemetrySample,
  seq: number,
  options: TrackPointOptions,
): TrackPoint {
  return trackPointSchema.parse({
    client_point_id: options.clientPointId,
    seq,
    ts: sample.ts,
    lat: sanitizeRequiredNumber(sample.lat, TRACK_NUMBER_RULES.lat),
    lon: sanitizeRequiredNumber(sample.lon, TRACK_NUMBER_RULES.lon),
    alt_ft: sanitizeRequiredNumber(sample.alt_ft, TRACK_NUMBER_RULES.alt_ft),
    agl_ft: sanitizeOptionalNumber(sample.agl_ft, TRACK_NUMBER_RULES.agl_ft),
    gs_kt: sanitizeRequiredNumber(sample.gs_kt, TRACK_NUMBER_RULES.gs_kt),
    ias_kt: sanitizeOptionalNumber(sample.ias_kt, TRACK_NUMBER_RULES.ias_kt),
    vs_fpm: sanitizeOptionalNumber(sample.vs_fpm, TRACK_NUMBER_RULES.vs_fpm),
    heading_deg: sanitizeRequiredNumber(
      normalizeHeading(sample.heading_deg),
      TRACK_NUMBER_RULES.heading_deg,
    ),
    pitch_deg: sanitizeRequiredNumber(sample.pitch_deg, TRACK_NUMBER_RULES.pitch_deg),
    bank_deg: sanitizeRequiredNumber(sample.bank_deg, TRACK_NUMBER_RULES.bank_deg),
    g: sanitizeRequiredNumber(sample.g, TRACK_NUMBER_RULES.g),
    on_ground: sample.on_ground,
    quality: sanitizeRequiredNumber(options.quality ?? 0, TRACK_NUMBER_RULES.quality),
    wind_dir_deg: sanitizeOptionalNumber(sample.wind_dir_deg, TRACK_NUMBER_RULES.wind_dir_deg),
    wind_speed_kt: sanitizeOptionalNumber(sample.wind_speed_kt, TRACK_NUMBER_RULES.wind_speed_kt),
    wind_gust_kt: sanitizeOptionalNumber(sample.wind_gust_kt, TRACK_NUMBER_RULES.wind_gust_kt),
    temp_c: sanitizeOptionalNumber(sample.temp_c, TRACK_NUMBER_RULES.temp_c),
    qnh_hpa: sanitizeOptionalNumber(sample.qnh_hpa, TRACK_NUMBER_RULES.qnh_hpa),
    precip: sanitizeOptionalNumber(sample.precip, TRACK_NUMBER_RULES.precip),
    visibility_m: sanitizeOptionalNumber(sample.visibility_m, TRACK_NUMBER_RULES.visibility_m),
  });
}

/**
 * Формирование `FlightEvent` строго по схеме `@flightlog/contracts` (T9).
 * `client_event_id` генерируется вызывающим (идемпотентность, ADR-0007).
 */
export function toFlightEvent(
  type: FlightEventType,
  sample: TelemetrySample,
  data: Record<string, unknown>,
  clientEventId: string,
  severity = 0,
): FlightEvent {
  return flightEventSchema.parse({
    client_event_id: clientEventId,
    type,
    ts: sample.ts,
    severity,
    data,
  });
}
