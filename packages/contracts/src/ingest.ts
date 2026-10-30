import { z } from 'zod';

import { clientProvenanceShape } from './flight.js';
import { utcDateTimeSchema, uuidSchema } from './primitives.js';
import {
  TRACK_INT_MAX,
  TRACK_NUMBER_RULES,
  sanitizeOptionalNumber,
  sanitizeRequiredNumber,
} from './sanitize.js';
import type { TrackPoint } from './flight.js';

/**
 * Толерантный приём телеметрии (INC-UPLOAD1, api.md §13.3).
 *
 * Старые клиенты (< T-PLUGIN18) отдают сохранённые строки `points.ndjson` **как
 * есть**, без пере-сериализации. Поэтому исторический буфер может содержать
 * значения, которые строгая `trackPointSchema` отвергает: дробный `vs_fpm`
 * (`0.000142`), `null` у опциональных полей (сим не отдал SimVar), выход за
 * диапазон `g`/`gs_kt`/`heading_deg`, `NaN`/`Infinity` от неинициализированных
 * SimVar. Каждая такая точка давала `422` на весь батч — буфер «залипал».
 *
 * Контракт приёма остаётся совместимым: неизвестные поля игнорируются, но вместо
 * отказа числа приводятся к допустимому виду (санитайз), а не отбрасываются:
 *   - `vs_fpm` — любое конечное число округляется до целого (`Math.round`);
 *   - `g`/`gs_kt`/`ias_kt` — клампятся к разумным границам;
 *   - `heading_deg`/`wind_dir_deg` — нормализуются по кругу в `[0, 360]`;
 *   - `null`/отсутствие — безопасный дефолт, а не ошибка;
 *   - точка с непригодной идентичностью/геометрией (`client_point_id`, `ts`,
 *     `lat`, `lon`) отбрасывается поштучно — батч из-за неё НЕ валится.
 *
 * Обязательный минимум формы (`api.md` §13.2) не ослабляется: в батче должна
 * остаться хотя бы одна пригодная точка, иначе — `422`.
 */

/** Число с плавающей точкой, допускающее `NaN`/`±Infinity` из JSON-оверфлоу. */
const ingestNumber = z.union([z.number(), z.nan()]);
const ingestOptionalNumber = ingestNumber.nullish();

export const trackPointIngestSchema = z
  .object({
    client_point_id: uuidSchema,
    seq: ingestOptionalNumber,
    ts: utcDateTimeSchema,
    lat: ingestNumber,
    lon: ingestNumber,
    alt_ft: ingestOptionalNumber,
    agl_ft: ingestOptionalNumber,
    gs_kt: ingestOptionalNumber,
    ias_kt: ingestOptionalNumber,
    vs_fpm: ingestOptionalNumber,
    heading_deg: ingestOptionalNumber,
    pitch_deg: ingestOptionalNumber,
    bank_deg: ingestOptionalNumber,
    g: ingestOptionalNumber,
    on_ground: z.boolean().nullish(),
    quality: ingestOptionalNumber,
    wind_dir_deg: ingestOptionalNumber,
    wind_speed_kt: ingestOptionalNumber,
    wind_gust_kt: ingestOptionalNumber,
    temp_c: ingestOptionalNumber,
    qnh_hpa: ingestOptionalNumber,
    precip: ingestOptionalNumber,
    visibility_m: ingestOptionalNumber,
  })
  // Толерантная точка: неизвестные SimVar-поля новой/старой версии клиента
  // отбрасываются, а не отклоняются (§13.3).
  .strip();
export type TrackPointIngest = z.output<typeof trackPointIngestSchema>;

/**
 * Нормализует угол-пеленг по кругу в `[0, 360]` (курс/направление ветра).
 * `360` остаётся `360`; `NaN`/`±Infinity`/не-число уходят в санитайз чисел.
 */
function wrapBearing(value: number | null | undefined): number | null | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  if (value >= 0 && value <= 360) return value;
  const wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Было ли присутствующее числовое значение изменено санитайзом. */
function wasAdjusted(raw: number | null | undefined, clean: number | null | undefined): boolean {
  return typeof raw === 'number' && raw !== clean;
}

export interface NormalizedTrackPoint {
  point: TrackPoint;
  /** Санитайз изменил хотя бы одно присутствующее числовое поле. */
  changed: boolean;
}

/**
 * Приводит сырую точку к канонической `TrackPoint`. Возвращает `null`, если
 * точка непригодна (не пройден обязательный минимум `api.md` §13.2:
 * `client_point_id`, `ts`, `lat`, `lon`) — тогда её отбрасывает вызывающий.
 */
export function normalizeTrackPoint(raw: unknown): NormalizedTrackPoint | null {
  const parsed = trackPointIngestSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const rules = TRACK_NUMBER_RULES;

  const lat = sanitizeRequiredNumber(p.lat, rules.lat);
  const lon = sanitizeRequiredNumber(p.lon, rules.lon);
  const alt_ft = sanitizeRequiredNumber(p.alt_ft, rules.alt_ft);
  const agl_ft = sanitizeOptionalNumber(p.agl_ft, rules.agl_ft);
  const gs_kt = sanitizeRequiredNumber(p.gs_kt, rules.gs_kt);
  const ias_kt = sanitizeOptionalNumber(p.ias_kt, rules.ias_kt);
  const vs_fpm = sanitizeOptionalNumber(p.vs_fpm, rules.vs_fpm);
  const heading_deg = sanitizeRequiredNumber(wrapBearing(p.heading_deg), rules.heading_deg);
  const pitch_deg = sanitizeRequiredNumber(p.pitch_deg, rules.pitch_deg);
  const bank_deg = sanitizeRequiredNumber(p.bank_deg, rules.bank_deg);
  const g = sanitizeRequiredNumber(p.g, rules.g);
  const quality = sanitizeRequiredNumber(p.quality, rules.quality);
  const wind_dir_deg = sanitizeOptionalNumber(wrapBearing(p.wind_dir_deg), rules.wind_dir_deg);
  const wind_speed_kt = sanitizeOptionalNumber(p.wind_speed_kt, rules.wind_speed_kt);
  const wind_gust_kt = sanitizeOptionalNumber(p.wind_gust_kt, rules.wind_gust_kt);
  const temp_c = sanitizeOptionalNumber(p.temp_c, rules.temp_c);
  const qnh_hpa = sanitizeOptionalNumber(p.qnh_hpa, rules.qnh_hpa);
  const precip = sanitizeOptionalNumber(p.precip, rules.precip);
  const visibility_m = sanitizeOptionalNumber(p.visibility_m, rules.visibility_m);
  const seq = sanitizeRequiredNumber(p.seq, {
    min: 1,
    max: TRACK_INT_MAX,
    decimals: 0,
    fallback: 1,
  });

  const point: TrackPoint = {
    client_point_id: p.client_point_id,
    seq,
    ts: p.ts,
    lat,
    lon,
    alt_ft,
    agl_ft,
    gs_kt,
    ias_kt,
    vs_fpm,
    heading_deg,
    pitch_deg,
    bank_deg,
    g,
    on_ground: p.on_ground ?? false,
    quality,
    wind_dir_deg,
    wind_speed_kt,
    wind_gust_kt,
    temp_c,
    qnh_hpa,
    precip,
    visibility_m,
  };

  const changed =
    wasAdjusted(p.seq, seq) ||
    wasAdjusted(p.lat, lat) ||
    wasAdjusted(p.lon, lon) ||
    wasAdjusted(p.alt_ft, alt_ft) ||
    wasAdjusted(p.agl_ft, agl_ft) ||
    wasAdjusted(p.gs_kt, gs_kt) ||
    wasAdjusted(p.ias_kt, ias_kt) ||
    wasAdjusted(p.vs_fpm, vs_fpm) ||
    wasAdjusted(p.heading_deg, heading_deg) ||
    wasAdjusted(p.pitch_deg, pitch_deg) ||
    wasAdjusted(p.bank_deg, bank_deg) ||
    wasAdjusted(p.g, g) ||
    wasAdjusted(p.quality, quality) ||
    wasAdjusted(p.wind_dir_deg, wind_dir_deg) ||
    wasAdjusted(p.wind_speed_kt, wind_speed_kt) ||
    wasAdjusted(p.wind_gust_kt, wind_gust_kt) ||
    wasAdjusted(p.temp_c, temp_c) ||
    wasAdjusted(p.qnh_hpa, qnh_hpa) ||
    wasAdjusted(p.precip, precip) ||
    wasAdjusted(p.visibility_m, visibility_m);

  return { point, changed };
}

export interface NormalizedTrackBatch {
  points: TrackPoint[];
  /** Сколько принятых точек санитизировано (изменено хотя бы одно поле). */
  sanitized: number;
  /** Сколько точек отброшено поштучно (не прошли обязательный минимум). */
  dropped: number;
}

/** Поштучная нормализация массива сырых точек; испорченные точки отбрасываются. */
export function normalizeTrackPoints(rawPoints: readonly unknown[]): NormalizedTrackBatch {
  const points: TrackPoint[] = [];
  let sanitized = 0;
  let dropped = 0;
  for (const raw of rawPoints) {
    const result = normalizeTrackPoint(raw);
    if (!result) {
      dropped += 1;
      continue;
    }
    if (result.changed) sanitized += 1;
    points.push(result.point);
  }
  return { points, sanitized, dropped };
}

/** Конверт батча: точки — `unknown[]`, чтобы битая точка не валила весь батч. */
const trackBatchEnvelopeSchema = z
  .object({
    points: z.array(z.unknown()).min(1).max(5000),
    ...clientProvenanceShape,
  })
  .strip();

export const trackBatchIngestSchema = trackBatchEnvelopeSchema
  .transform((body) => {
    const { points, sanitized, dropped } = normalizeTrackPoints(body.points);
    return {
      points,
      sanitized,
      dropped,
      source: body.source,
      version: body.version,
      client_version: body.client_version,
    };
  })
  // Если пригодных точек не осталось — это несовместимость формы (§13.2), а не
  // «грязные числа»: честный 422 вместо пустого батча.
  .refine((batch) => batch.points.length > 0, {
    message: 'no usable track points: each point requires client_point_id, ts, lat, lon',
  });

export type TrackBatchIngest = z.output<typeof trackBatchIngestSchema>;
