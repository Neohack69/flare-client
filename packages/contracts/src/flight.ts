import { z } from 'zod';
import { aircraftSummarySchema } from './aircraft.js';
import { aircraftModelSourceStringSchema } from './aircraft-model.js';
import { flightAggregatesSchema } from './analysis.js';
import {
  aircraftIcaoSchema,
  airportIcaoSchema,
  callsignSchema,
  latitudeSchema,
  longitudeSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './primitives.js';
import { qualityFlagsSchema } from './quality.js';
import { runwaySchema, simRunwaySchema } from './runway.js';
import { landingSummarySchema } from './scoring.js';
import { flightWeatherSummarySchema, weatherSampleShape } from './weather.js';

export {
  runwayMatchSchema,
  runwaySchema,
  runwaySourceSchema,
  simRunwayEndSchema,
  simRunwaySchema,
  type Runway,
  type RunwayMatch,
  type RunwaySource,
  type SimRunway,
  type SimRunwayEnd,
} from './runway.js';

export const flightStatusSchema = z.enum([
  'in_progress',
  'completed',
  'failed',
  'archived',

  /**
   * T-FLIGHTDET1: a recording that never really flew (below the confirmed-start /
   * minimum-flight thresholds) or an `in_progress` flight with no fresh data for
   * a long time. It is NOT a flight: hidden from user lists, excluded from
   * limits/counters and never scored. Additive status (old clients treat it as an
   * unknown string; the value is only returned for the owner's own resource).
   */
  'abandoned',
]);
export type FlightStatus = z.output<typeof flightStatusSchema>;

export const flightVisibilitySchema = z.enum(['private', 'unlisted', 'public']);
export type FlightVisibility = z.output<typeof flightVisibilitySchema>;

/**
 * Источник телеметрии полёта (ADR-0023, решение 1): `msfs2024` | `xplane12`.
 * Отдельное измерение от `source` (`flights.stats.source`/`devices.source` —
 * «канал доставки», api.md §3.3.3) и от quality-битов: XP-рейс может быть
 * `leaderboard_eligible=true` и всё равно не попадать в публичные таблицы —
 * это отдельный серверный фильтр по `sim` (ADR-0023, решение 4). Добавление
 * третьего сима — аддитивное расширение enum (как `flightSourceSchema`).
 */
export const flightSimSchema = z.enum(['msfs2024', 'xplane12']);
export type FlightSim = z.output<typeof flightSimSchema>;

/**
 * Сим по умолчанию: клиенты без поля `sim` (0.3.x) трактуются как MSFS-путь,
 * поэтому сервер резолвит отсутствие в `msfs2024` (обратная совместимость,
 * ADR-0023 решение 1). Контракт намеренно не делает поле обязательным нигде.
 */
export const DEFAULT_FLIGHT_SIM: FlightSim = 'msfs2024';

/**
 * Честное состояние «сессия без посадки»: рейс, который начал запись, но так и
 * не получил подтверждённого касания (например, сим закрыт в середине полёта).
 * Не новый статус в БД, а **производное** от уже существующих полей — сервер
 * оставляет `status='completed'`, `landings_count=0` и `is_partial`; клиент
 * обязан показать это честно (без балла и вне лидербордов), а не как обычный рейс.
 */
export type FlightNoLandingKind = 'none' | 'no_landing' | 'interrupted';

export interface FlightNoLandingInput {
  status: FlightStatus;
  /** Число подтверждённых касаний сессии (ADR-0010); `0` — касания нет. */
  landings_count: number;
  /** Запись потеряла данные (сим закрыт / нет данных в терминал), ADR-0008. */
  is_partial: boolean;
  /** Время касания, если оно есть; `null`/отсутствует — касания нет. */
  touchdown_at?: string | null;
}

/** Есть ли у сессии подтверждённая посадка (по денормализации + касанию). */
export function hasFlightLanding(input: FlightNoLandingInput): boolean {
  return (input.landings_count ?? 0) > 0 || (input.touchdown_at != null && input.touchdown_at !== '');
}

/**
 * Производное состояние «без посадки»:
 * - `none` — есть посадка, рейс ещё идёт или запись отозвана (`abandoned` — не рейс);
 * - `interrupted` — запись прервана без касания (`is_partial`: сим закрыт/нет данных);
 * - `no_landing` — терминальный рейс без касания, но без признака потери данных.
 */
export function flightNoLandingKind(input: FlightNoLandingInput): FlightNoLandingKind {
  if (hasFlightLanding(input)) return 'none';
  if (input.status === 'in_progress' || input.status === 'abandoned') return 'none';
  if (input.is_partial) return 'interrupted';
  return 'no_landing';
}

/**
 * Известные источники телеметрии (api.md §3.3.3): `agent` | `msfs-plugin` |
 * `electron` (канон) плюс упомянутые в продукте `desktop` | `web` | `unknown`.
 * Это лишь подсказка для аналитики: приём **никогда** не гейтится по значению
 * источника (§13.1), поэтому ниже `source` — свободная строка, а не закрытый
 * enum (новое значение enum — аддитивное изменение, §13.3).
 */
export const KNOWN_CLIENT_SOURCES = [
  'agent',
  'msfs-plugin',
  'electron',
  'desktop',
  'web',
  'unknown',
] as const;

/**
 * Информационный источник записи (api.md §3.3.3). Не `.enum()`: неизвестное
 * будущее значение не должно превращаться в `422` (forward-compat §13.3).
 */
export const flightSourceSchema = z.string().trim().min(1).max(64);
export type FlightSource = z.output<typeof flightSourceSchema>;

/** Версия клиента — semver-строка (информационно, без проверки совместимости). */
export const clientVersionSchema = z.string().trim().min(1).max(64);
export type ClientVersion = z.output<typeof clientVersionSchema>;

export {
  AGL_DATUM_VERSION,
  LANDING_ANALYSIS_SERIES_MAX,
  LANDING_ANALYSIS_VERSION,
  engineAggregateSchema,
  engineModeSchema,
  flightAggregatesSchema,
  flightConfigSnapshotSchema,
  flightPhaseStatsSchema,
  flightStabilityStatsSchema,
  flightTrendEventSchema,
  ilsDeviationStatsSchema,
  landingAnalysisSchema,
  landingAnalysisSeriesPointSchema,
  landingWeightSourceSchema,
  touchdownPointSchema,
  windShearSchema,
  type EngineAggregate,
  type EngineMode,
  type FlightAggregates,
  type FlightAggregatesInput,
  type FlightConfigSnapshot,
  type FlightPhaseStats,
  type FlightStabilityStats,
  type FlightTrendEvent,
  type IlsDeviationStats,
  type LandingAnalysis,
  type LandingAnalysisInput,
  type LandingAnalysisSeriesPoint,
  type LandingWeightSource,
  type TouchdownPoint,
  type WindShear,
} from './analysis.js';

/**
 * Информационные поля происхождения источника (api.md §3.3.3): `source`,
 * `version` и синоним `client_version`. Все опциональны; сервер сохраняет их в
 * аналитику и **никогда** не отвергает запись из-за значения/отсутствия (§13.1).
 */
export const clientProvenanceShape = {
  source: flightSourceSchema.optional(),
  version: clientVersionSchema.optional(),
  client_version: clientVersionSchema.optional(),
} as const;

/** POST /v1/flights — agent upserts a flight at recording start. */
export const flightCreateSchema = z
  .object({
    client_flight_id: uuidSchema,
    aircraft_icao: aircraftIcaoSchema,
    callsign: callsignSchema.nullish(),
    origin_icao: airportIcaoSchema.nullish(),
    destination_icao: airportIcaoSchema.nullish(),
    started_at: utcDateTimeSchema,
    device_id: uuidSchema.nullish(),
    /**
     * T-D §5.6: сырая строка `ATC MODEL`/`TITLE`/addon-имя от агента, сохраняется
     * в `flights.stats.aircraft_model_raw` для обучения словаря. Аддитивно и
     * опционально: при отсутствии поле просто не появляется.
     */
    aircraft_model_raw: aircraftModelSourceStringSchema.optional(),
    /**
     * ADR-0023: источник телеметрии (`msfs2024`|`xplane12`). **Опционально** —
     * клиент 0.3.x поле не шлёт, сервер резолвит `msfs2024` (без смены валидации
     * старых клиентов, §13.3). Не влияет на приём (§13.1).
     */
    sim: flightSimSchema.optional(),
    ...clientProvenanceShape,
  })
  // Не `.strict()`: неизвестные поля от новой/старой версии клиента отбрасываются,
  // а не приводят к 422 (api.md §13.3 forward-compat).
  .strip();
export type FlightCreate = z.output<typeof flightCreateSchema>;
export type FlightCreateInput = z.input<typeof flightCreateSchema>;

/** PATCH /v1/flights/{id} — user edits (LWW). */
export const flightPatchSchema = z
  .object({
    callsign: callsignSchema.nullish(),
    visibility: flightVisibilitySchema.optional(),
    origin_icao: airportIcaoSchema.nullish(),
    destination_icao: airportIcaoSchema.nullish(),
    /**
     * T-D §4.1: правка типа ВС владельцем. Сервер создаёт stub-строку
     * `aircraft` при free-text ICAO, обновляет `stats.aircraft_icao_source='user'`
     * и пересчитывает скоринг по порогам нового типа.
     */
    aircraft_icao: aircraftIcaoSchema.optional(),
  })
  .strict();
export type FlightPatch = z.output<typeof flightPatchSchema>;

/**
 * POST /v1/flights/{id}/complete — finalize and trigger scoring.
 * `is_partial`/`paused_total_s`/`quality_flags` — аддитивная передача агрегатов
 * качества, вычисленных агентом (ADR-0008); сервер может пересчитать их сам.
 * `stats` — WAVE 4: финализированные FOQA-агрегаты (whitelist-ключи) и
 * `landings_analysis` (карта seq → analysis), которые сервер персистит в
 * `flights.stats`/`landings.analysis`. Аддитивно: старые клиенты не шлют.
 */
export const flightCompleteSchema = z
  .object({
    ended_at: utcDateTimeSchema,
    client_flight_id: uuidSchema,
    is_partial: z.boolean().optional(),
    paused_total_s: z.number().int().nonnegative().optional(),
    quality_flags: qualityFlagsSchema.optional(),
    stats: flightAggregatesSchema.optional(),
    /**
     * R1: геометрия ВПП от самого симулятора (X-Plane apt.dat / MSFS ATC).
     * Сервер предпочитает её OurAirports при расчёте геометрии касания.
     */
    sim_runway: simRunwaySchema.optional(),
    /**
     * ADR-0023: источник телеметрии, если клиент его шлёт (аддитивно). Отсутствие
     * не гейтит `/complete` — сервер сохраняет уже выбранный при `POST /v1/flights`
     * `sim` (дефолт `msfs2024`).
     */
    sim: flightSimSchema.optional(),
    ...clientProvenanceShape,
  })
  // Толерантный приём (§13.3): лишние поля игнорируются, версия не гейтит `/complete`.
  .strip();
export type FlightComplete = z.output<typeof flightCompleteSchema>;

/**
 * POST /v1/flights/{id}/abandon — T-FLIGHTDET1 (agent). Withdraws a recording
 * that must not be treated as a flight (below the minimum thresholds, or a
 * `in_progress` flight the server auto-expired). Additive endpoint; the body
 * mirrors `/complete` minus the end timestamp (the server seals `ended_at`).
 */
export const flightAbandonSchema = z
  .object({
    client_flight_id: uuidSchema,
    /**
     * Почему агент отзывает сессию (диагностика; рейс всё равно `abandoned`).
     * `no_flight_evidence` — не подтвердился отрыв (стоянка/руление).
     */
    discard_reason: z.enum(['no_flight_evidence', 'teleport', 'slew', 'position_glitch']).optional(),
    ...clientProvenanceShape,
  })
  // Толерантный приём (§13.3): неизвестные поля игнорируются.
  .strip();
export type FlightAbandon = z.output<typeof flightAbandonSchema>;

/** Full flight resource returned by the API. */
export const flightSchema = z
  .object({
    id: uuidSchema,
    user_id: uuidSchema,
    device_id: uuidSchema.nullable(),
    client_flight_id: uuidSchema,
    /**
     * Заглушка `ZZZZ` при неизвестном типе (ADR-0008 §4). `null` — тип не
     * определён/не передан (колонка БД nullable, T63/BUG-REG-02); `aircraft`
     * при этом остаётся `unknown`-объектом.
     */
    aircraft_icao: aircraftIcaoSchema.nullable(),
    /**
     * Метаданные типа ВС для 3D/UI (ADR-0009, api.md §3.2.2). `null` — если JOIN
     * справочника не выполнялся; для нераспознанных типов сервер отдаёт объект
     * с `category='unknown'` (не пропускает ключ).
     */
    aircraft: aircraftSummarySchema.nullable().default(null),
    callsign: callsignSchema.nullable(),
    origin_icao: airportIcaoSchema.nullable(),
    destination_icao: airportIcaoSchema.nullable(),
    status: flightStatusSchema.default('in_progress'),
    visibility: flightVisibilitySchema.default('private'),
    /**
     * ADR-0023, решение 1: источник телеметрии полёта. Аддитивное поле ответа;
     * `default('msfs2024')` — старые payload без `sim` остаются валидными
     * (MSFS-семантика). Доступно и в детали, и в списке рейсов.
     */
    sim: flightSimSchema.default(DEFAULT_FLIGHT_SIM),
    started_at: utcDateTimeSchema,
    ended_at: utcDateTimeSchema.nullable(),
    server_received_at: utcDateTimeSchema,
    duration_s: z.number().int().nonnegative().nullable(),
    distance_m: z.number().int().nonnegative().nullable(),
    /**
     * «Часы в воздухе» по треку в секундах (ADR-0019 §2.1). Аддитивное поле:
     * `null` — нет достоверного воздушного интервала (нет трека/одна точка/всё
     * на земле); отсутствие данных отличимо от нуля. Block time остаётся в
     * `duration_s`.
     */
    airborne_s: z.number().int().nonnegative().nullable().default(null),
    max_altitude_ft: z.number().int().nullable(),
    touchdown_at: utcDateTimeSchema.nullable(),
    paused_total_s: z.number().int().nonnegative().default(0),
    is_partial: z.boolean().default(false),
    leaderboard_eligible: z.boolean().default(true),
    quality_flags: qualityFlagsSchema.default(0),
    point_count: z.number().int().nonnegative().default(0),
    /** Число посадок сессии (ADR-0010); 0 — нет касания. */
    landings_count: z.number().int().nonnegative().default(0),
    stats: z.record(z.string(), z.unknown()).default({}),
    /**
     * Посадки сессии (ADR-0010, api.md §3.2.4). Аддитивное поле; `[]`, если
     * касаний нет (`in_progress`/`failed`/`no_score`). Список тянет только
     * деталь рейса и `GET .../landings`; `GET /v1/flights` его не отдаёт.
     */
    landings: z.array(landingSummarySchema).default([]),
    /**
     * Прилётная ВПП (T100): реальная полоса аэропорта назначения по курсу
     * касания, иначе `null` (клиент берёт синтетическую). Заполняется деталью
     * рейса; `GET /v1/flights` отдаёт `null`.
     */
    runway: runwaySchema.nullable().default(null),
    /**
     * Погодная сводка рейса (T-weather): снимки на взлёте/касании и агрегаты.
     * `null` — погода не читалась (старые рейсы/моки).
     */
    weather: flightWeatherSummarySchema.nullable().default(null),
    /**
     * T183: есть ли личная заметка журнала. Только boolean на detail;
     * текст — `GET /v1/flights/{id}/journal`. List / public — без поля
     * (default false для старых payload).
     */
    has_journal: z.boolean().default(false),
    created_at: utcDateTimeSchema,
    updated_at: utcDateTimeSchema,
  })
  .strict();
export type Flight = z.output<typeof flightSchema>;
export type FlightInput = z.input<typeof flightSchema>;

/** GET /v1/flights/{id}/track query parameters. */
export const trackResolutionSchema = z.enum(['auto', 'full', '1hz']);
export type TrackResolution = z.output<typeof trackResolutionSchema>;

export const trackFormatSchema = z.enum(['geojson', 'points']);
export type TrackFormat = z.output<typeof trackFormatSchema>;

/** A single telemetry point (POST /v1/flights/{id}/track/batch). */
export const trackPointSchema = z
  .object({
    /** UUID v4, генерируется агентом один раз при материализации (ADR-0007). */
    client_point_id: uuidSchema,
    seq: z.number().int().positive(),
    ts: utcDateTimeSchema,
    lat: latitudeSchema,
    lon: longitudeSchema,
    alt_ft: z.number().finite(),
    agl_ft: z.number().finite().nullish(),
    gs_kt: z.number().finite().min(0),
    ias_kt: z.number().finite().nullish(),
    vs_fpm: z.number().int().nullish(),
    heading_deg: z.number().finite().min(0).max(360),
    pitch_deg: z.number().finite().min(-90).max(90),
    bank_deg: z.number().finite().min(-180).max(180),
    g: z.number().finite().min(0),
    on_ground: z.boolean(),
    quality: z.number().int().min(0).default(0),
    ...weatherSampleShape,
  })
  // Толерантная точка: неизвестные SimVar-поля новой/старой версии клиента
  // отбрасываются, а не отклоняются (§13.3).
  .strip();
export type TrackPoint = z.output<typeof trackPointSchema>;
export type TrackPointInput = z.input<typeof trackPointSchema>;

export const trackBatchSchema = z
  .object({
    points: z.array(trackPointSchema).min(1).max(5000),
    ...clientProvenanceShape,
  })
  // Батч — информационный контейнер: лишние поля игнорируются (§13.3).
  .strip();
export type TrackBatch = z.output<typeof trackBatchSchema>;

export const trackBatchResponseSchema = z
  .object({
    accepted: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    /**
     * INC-UPLOAD1: сколько принятых точек было санитизировано (дробный `vs_fpm`,
     * кламп диапазонов, `null`/NaN → дефолт) и сколько отброшено поштучно.
     * Аддитивные поля с дефолтом `0`: старые ответы/клиенты не ломаются.
     */
    sanitized: z.number().int().nonnegative().default(0),
    dropped: z.number().int().nonnegative().default(0),
    server_max_seq: z.number().int().nonnegative(),
    next_expected_seq: z.number().int().positive(),
  })
  .strict();
export type TrackBatchResponse = z.output<typeof trackBatchResponseSchema>;

/**
 * Read-модель точки трека (`GET /v1/flights/{id}/track?format=points`). В отличие
 * от ingest-контракта `trackPointSchema` здесь нет `client_point_id` (сервер его не
 * отдаёт) и поля могут быть `null` для отсутствующих SimVar. Клиент толерантен к
 * `null` и не делает вид, что значение есть.
 */
export const trackPointReadSchema = z
  .object({
    seq: z.number().int().positive(),
    ts: utcDateTimeSchema,
    lat: latitudeSchema,
    lon: longitudeSchema,
    alt_ft: z.number().finite().nullable(),
    agl_ft: z.number().finite().nullable(),
    gs_kt: z.number().finite().nullable(),
    ias_kt: z.number().finite().nullable(),
    vs_fpm: z.number().int().nullable(),
    heading_deg: z.number().finite().nullable(),
    pitch_deg: z.number().finite().nullable(),
    bank_deg: z.number().finite().nullable(),
    g: z.number().finite().nullable(),
    on_ground: z.boolean(),
    quality: z.number().int().min(0),
    ...weatherSampleShape,
  })
  .strict();
export type TrackPointRead = z.output<typeof trackPointReadSchema>;

/** Ответ `GET /v1/flights/{id}/track?format=points` (api.md §3.2). */
export const trackPointsResponseSchema = z
  .object({
    data: z.array(trackPointReadSchema),
    meta: z
      .object({
        resolution: z.enum(['full', '1hz']),
        count: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type TrackPointsResponse = z.output<typeof trackPointsResponseSchema>;

export const flightEventTypeSchema = z.enum([
  'engine_start',
  'taxi',
  'takeoff',
  'gear_up',
  'gear_down',
  'touchdown',
  'bounce',
  'go_around',
  'stall',
  'overspeed',
  'engine_stop',
  'landing',
  'crash',
  'pause',
  'resume',
  'fuel_change',
]);
export type FlightEventType = z.output<typeof flightEventTypeSchema>;

export const flightEventSchema = z
  .object({
    client_event_id: uuidSchema,
    type: flightEventTypeSchema,
    ts: utcDateTimeSchema,
    severity: z.number().int().min(0).default(0),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  // Толерантно: неизвестные поля события игнорируются (§13.3).
  .strip();
export type FlightEvent = z.output<typeof flightEventSchema>;
export type FlightEventInput = z.input<typeof flightEventSchema>;

export const flightEventsBatchSchema = z
  .object({
    events: z.array(flightEventSchema).min(1).max(200),
    ...clientProvenanceShape,
  })
  // Батч — информационный контейнер: лишние поля игнорируются (§13.3).
  .strip();
export type FlightEventsBatch = z.output<typeof flightEventsBatchSchema>;

export const flightEventsBatchResponseSchema = z
  .object({
    accepted: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
  })
  .strict();
export type FlightEventsBatchResponse = z.output<typeof flightEventsBatchResponseSchema>;
