import { z } from 'zod';
import { simRunwaySchema } from './runway.js';

/**
 * WAVE 4 (FOQA): контракты per-landing анализа (`landings.analysis`) и
 * whitelist-агрегатов рейса, которые клиент присылает в `/complete`.
 *
 * Листовой модуль: зависит только от `zod`, чтобы `scoring.ts` (для
 * `landingSummarySchema.analysis`) и `flight.ts` (для `/complete.stats`) могли
 * импортировать его без циклических зависимостей.
 */

/**
 * Источник фактической посадочной массы в `flights.stats`
 * (`landing_weight_source`). `sim` — SimVar `TOTAL WEIGHT`; `plan` — из
 * закреплённого плана SimBrief; `null` — данных нет. Аддитивно: старые рейсы
 * ключ не содержат (отсутствие ≠ 0).
 */
export const landingWeightSourceSchema = z.enum(['sim', 'plan']);
export type LandingWeightSource = z.output<typeof landingWeightSourceSchema>;

/**
 * WAVE 4 (FOQA): версия формы `landings.analysis` (per-landing jsonb). Меняется
 * только при несовместимом изменении полей; аддитивные поля версию не трогают.
 */
export const LANDING_ANALYSIS_VERSION = 'analysis/1' as const;

/**
 * FOQA-DATUM-1: версия правил калибровки датума AGL. Меняется только при
 * несовместимом изменении семантики калибровки. Аддитивные поля не трогают.
 */
export const AGL_DATUM_VERSION = 'agl-datum/1' as const;

/** Число, допускающее отсутствие; `null` — измерения нет (absent ≠ 0). */
const nullableFinite = z.number().finite().nullable();

/** Максимум точек на каждую серию (объём jsonb ограничен). */
export const LANDING_ANALYSIS_SERIES_MAX = 240;

/**
 * Одна точка bounded time-series для графиков подхода (ILS deviation, AoA,
 * конфигурация). `t_s` — секунды относительно касания (≤ 0 — до касания).
 * `value: null` — в этот отсчёт SimVar не давал значения.
 */
export const landingAnalysisSeriesPointSchema = z
  .object({
    t_s: z.number().finite(),
    value: nullableFinite,
  })
  .strip();
export type LandingAnalysisSeriesPoint = z.output<typeof landingAnalysisSeriesPointSchema>;

/** Конфигурация ВС в контрольной точке (1000/500 ft AGL). `null` — поля нет. */
export const flightConfigSnapshotSchema = z
  .object({
    flaps_percent: nullableFinite,
    spoilers_percent: nullableFinite,
    spoilers_armed: z.boolean().nullable(),
    gear_down: z.boolean().nullable(),
    autopilot_master: z.boolean().nullable(),
    autothrottle_active: z.boolean().nullable(),
  })
  .strip();
export type FlightConfigSnapshot = z.output<typeof flightConfigSnapshotSchema>;

/**
 * Честный режим двигателя в кадре. Выводится только из однозначных сигналов
 * (реверс, тяга у малого газа/максимума); `climb`/`cruise`/`approach`
 * зарезервированы под калиброванные N1-пороги и пока не эмитятся.
 */
export const engineModeSchema = z.enum([
  'takeoff_thrust',
  'climb',
  'cruise',
  'approach',
  'idle',
  'reverse',
  'unknown',
]);
export type EngineMode = z.output<typeof engineModeSchema>;

/**
 * Агрегат двигателей за окно (1000/500 ft, касание, пробег).
 * `mode` — доминирующий честный режим; `null` — двигательных данных нет.
 * `reverse_duration_s`/`duration_s` заполняются только для пробега.
 */
export const engineAggregateSchema = z
  .object({
    mode: engineModeSchema.nullable(),
    samples: z.number().int().nonnegative(),
    n1_mean_percent: nullableFinite,
    n1_max_percent: nullableFinite,
    throttle_mean_percent: nullableFinite,
    throttle_max_percent: nullableFinite,
    reverse_engaged: z.boolean().nullable(),
    reverse_duration_s: nullableFinite,
    fuel_flow_pph_mean: nullableFinite,
    fuel_flow_pph_max: nullableFinite,
    duration_s: nullableFinite,
  })
  .strip();
export type EngineAggregate = z.output<typeof engineAggregateSchema>;

/** Агрегаты отклонений ILS/NAV за заход (max |CDI|/|GSI|, extremes GSE). */
export const ilsDeviationStatsSchema = z
  .object({
    samples: z.number().int().nonnegative(),
    max_abs_cdi: nullableFinite,
    max_abs_gsi: nullableFinite,
    min_glide_slope_error_deg: nullableFinite,
    max_glide_slope_error_deg: nullableFinite,
    /* Validity flags are tri-state: `null` = unknown (sim has no equivalent,
     * e.g. X-Plane), not `false`. Relaxed additively (analysis/1 stays). */
    cdi_valid: z.boolean().nullable(),
    gsi_valid: z.boolean().nullable(),
    has_localizer: z.boolean().nullable(),
  })
  .strip();
export type IlsDeviationStats = z.output<typeof ilsDeviationStatsSchema>;

/**
 * Точка касания относительно порога (X/Z) и посадочного aiming point (TDPOINT),
 * плюс геометрия выбранной ATC полосы (если `ATC RUNWAY SELECTED` дал данные).
 */
export const touchdownPointSchema = z
  .object({
    relative_x_m: nullableFinite,
    relative_z_m: nullableFinite,
    aiming_x_m: nullableFinite,
    aiming_z_m: nullableFinite,
    start_distance_m: nullableFinite,
    end_distance_m: nullableFinite,
    heading_deg_true: nullableFinite,
    length_m: nullableFinite,
    width_m: nullableFinite,
  })
  .strip();
export type TouchdownPoint = z.output<typeof touchdownPointSchema>;

/**
 * WAVE 4: wind shear выводится из вариативности ветра за заход (отдельного
 * SimVar в MSFS нет). `max_*` — максимальный размах по соседним отсчётам окна.
 */
export const windShearSchema = z
  .object({
    samples: z.number().int().nonnegative(),
    max_wind_speed_delta_kt: nullableFinite,
    max_wind_dir_delta_deg: nullableFinite,
  })
  .strip();
export type WindShear = z.output<typeof windShearSchema>;

/**
 * FOQA-анализ одной посадки (`landings.analysis`). Все поля nullable: значение
 * `null` означает «измерения нет», а не 0. Неизвестные поля отбрасываются.
 *
 * FOQA-DATUM-1 (аддитивно): записанный `agl_ft`/`RADIO HEIGHT` — это высота
 * **опорной точки** модели над землёй, а не колёс (у A220 на стоянке ≈ +10 ft).
 * Поэтому `flare_height_ft` и `radio_height_touchdown_ft` — высоты опорной точки;
 * корректированные «высоты колёс» — в новых полях `*_wheel_ft`
 * (`null`, если датум для рейса измерить не удалось: `height_datum_calibrated=false`).
 */
export const landingAnalysisSchema = z
  .object({
    version: z.literal(LANDING_ANALYSIS_VERSION),
    config_at_1000ft: flightConfigSnapshotSchema.nullable(),
    config_at_500ft: flightConfigSnapshotSchema.nullable(),
    ap_disconnect_agl_ft: nullableFinite,
    at_disconnect_agl_ft: nullableFinite,
    /** Высота **опорной точки** (не колёс) в начале выравнивания, ft. */
    flare_height_ft: nullableFinite,
    flare_duration_s: nullableFinite,
    ils: ilsDeviationStatsSchema.nullable(),
    aoa_touchdown_deg: nullableFinite,
    aoa_max_near_touchdown_deg: nullableFinite,
    cg_percent_touchdown: nullableFinite,
    surface_condition: z.number().int().min(0).max(32).nullable(),
    surface_type: z.number().int().min(0).max(256).nullable(),
    on_any_runway: z.boolean().nullable(),
    touchdown_point: touchdownPointSchema.nullable(),
    /**
     * R1: геометрия ВПП от симулятора, по которой считалась геометрия касания
     * (прозрачность происхождения; `null`/отсутствие — OurAirports/нет данных).
     */
    sim_runway: simRunwaySchema.nullable().optional(),
    /** Сырой `RADIO HEIGHT` (высота опорной точки) в момент касания, ft. */
    radio_height_touchdown_ft: nullableFinite,
    /**
     * D1: источник VS касания. `sim` — мгновенный VS кадра перехода;
     * `altitude` — производная `altitude_ft` за 0.5 с до касания (выбрана при
     * расхождении >10% и |sim VS| >50 fpm). `null` — старый клиент/не измерено.
     */
    vs_source: z.enum(['sim', 'altitude']).nullable().optional(),
    /** D1: VS по `altitude_ft` до касания (fpm); `null` — окно высоты недоступно. */
    vs_altitude_fpm: nullableFinite.optional(),
    /**
     * FOQA-DATUM-1 (аддитивно): измеренный датум-сдвиг рейса — медианный
     * `agl_ft` на наземной площадке (стоянка/пробег), ft. `null` — не измерен.
     * Версия правил — `agl_datum_version`. Отсутствие ключа = старый клиент.
     */
    agl_datum_offset_ft: nullableFinite.optional(),
    agl_datum_version: z.literal(AGL_DATUM_VERSION).optional(),
    /** Измерен ли датум для этого рейса (иначе `*_wheel_ft` = `null`). */
    height_datum_calibrated: z.boolean().optional(),
    /** Высота **колёс** в начале выравнивания (`flare_height_ft − datum`), ft. */
    flare_height_wheel_ft: nullableFinite.optional(),
    /** Высота **колёс** в момент касания (`radio_height_touchdown_ft − datum`), ft. */
    wheel_height_touchdown_ft: nullableFinite.optional(),
    /**
     * ENGINE-MODE (аддитивно): двигатели на 1000/500 ft, касании и пробеге —
     * N1 (mean/max), тяга (throttle), реверс и расход топлива. Отсутствие ключа =
     * старый клиент/нет данных; `null` внутри = измерения нет.
     */
    engine_at_1000ft: engineAggregateSchema.nullable().optional(),
    engine_at_500ft: engineAggregateSchema.nullable().optional(),
    engine_touchdown: engineAggregateSchema.nullable().optional(),
    engine_rollout: engineAggregateSchema.nullable().optional(),
    wind_shear: windShearSchema.nullable(),
    series: z
      .object({
        ils_cdi: z.array(landingAnalysisSeriesPointSchema).max(LANDING_ANALYSIS_SERIES_MAX),
        ils_gsi: z.array(landingAnalysisSeriesPointSchema).max(LANDING_ANALYSIS_SERIES_MAX),
        aoa_deg: z.array(landingAnalysisSeriesPointSchema).max(LANDING_ANALYSIS_SERIES_MAX),
        flaps_percent: z.array(landingAnalysisSeriesPointSchema).max(LANDING_ANALYSIS_SERIES_MAX),
      })
      .strip(),
  })
  .strip();
export type LandingAnalysis = z.output<typeof landingAnalysisSchema>;
export type LandingAnalysisInput = z.input<typeof landingAnalysisSchema>;

/** Фазы рейса в `flights.stats.phases` (форма для AI Debrief, llm-debrief-prompt.md). */
export const flightPhaseStatsSchema = z
  .object({
    takeoff: z.object({ vs_mean_fpm: nullableFinite, pitch_mean_deg: nullableFinite }).strip(),
    climb: z.object({ avg_ias_kt: nullableFinite, avg_vs_fpm: nullableFinite }).strip(),
    cruise: z.object({ altitude_ft: nullableFinite, avg_gs_kt: nullableFinite }).strip(),
    descent: z.object({ avg_vs_fpm: nullableFinite, max_ias_kt: nullableFinite }).strip(),
    approach: z
      .object({
        avg_gs_kt: nullableFinite,
        gs_at_1000ft_kt: nullableFinite,
        gs_at_500ft_kt: nullableFinite,
        sink_rate_1000_500_fpm: nullableFinite,
      })
      .strip(),
  })
  .strip();
export type FlightPhaseStats = z.output<typeof flightPhaseStatsSchema>;

/** Стабилизация захода в `flights.stats.stability`. */
export const flightStabilityStatsSchema = z
  .object({
    stabilized_by_1000ft: z.boolean().nullable(),
    stabilized_by_500ft: z.boolean().nullable(),
    gs_variation_kt_1000_500: nullableFinite,
    vertical_speed_variation_fpm: nullableFinite,
    /**
     * A2: число **эпизодов** крена > 10° (гистерезис 8°, ≥ 1 с) в финальном
     * окне 1000→500 ft AGL, не число кадров. `null` — окно не измеримо.
     */
    bank_excursions_count: z.number().int().nonnegative().nullable(),
    /** A2: максимум |bank| в окне 1000→500 ft AGL, град; `null` — нет окна. */
    bank_max_deg_1000_500: z.number().nullable().optional(),
    /** A2: версия семантики стабилизации; 2 — эпизоды + новый classifyPhase. */
    stability_version: z.number().int().optional(),
  })
  .strip();
export type FlightStabilityStats = z.output<typeof flightStabilityStatsSchema>;

/** Одно событие относительно касания в `flights.stats.events` (для AI). */
export const flightTrendEventSchema = z
  .object({
    type: z.string().min(1).max(32),
    at_sec_from_touchdown: z.number().finite(),
  })
  .strip();
export type FlightTrendEvent = z.output<typeof flightTrendEventSchema>;

/**
 * WAVE 4: агрегаты, которые клиент присылает в `POST /v1/flights/{id}/complete`
 * и сервер вливает в `flights.stats` по **whitelist** (никакого mass assignment).
 * `landings_analysis` — карта `seq → landingAnalysisSchema`; сервер раскладывает
 * её по `landings.analysis`, а не кладёт в `flights.stats`. Все поля аддитивны.
 */
export const flightAggregatesSchema = z
  .object({
    landing_weight_kg: z.number().int().positive().nullable().optional(),
    landing_weight_source: landingWeightSourceSchema.nullable().optional(),
    /**
     * MSFS-диагностика: на кадре касания `ATC RUNWAY …` непригодны (`missing`/
     * `zero`/`no_heading`), поэтому сервер использует OurAirports. `true` —
     * фолбэк случился; ключа нет, если данные были валидны (не MSFS).
     */
    atc_runway_missing: z.literal(true).nullable().optional(),
    phases: flightPhaseStatsSchema.nullable().optional(),
    stability: flightStabilityStatsSchema.nullable().optional(),
    events: z.array(flightTrendEventSchema).max(64).nullable().optional(),
    config_at_1000ft: flightConfigSnapshotSchema.nullable().optional(),
    config_at_500ft: flightConfigSnapshotSchema.nullable().optional(),
    ap_disconnect_agl_ft: z.number().finite().nullable().optional(),
    at_disconnect_agl_ft: z.number().finite().nullable().optional(),
    /** Высота опорной точки в начале выравнивания (представительная посадка), ft. */
    flare_height_ft: z.number().finite().nullable().optional(),
    flare_duration_s: z.number().finite().nullable().optional(),
    /**
     * FOQA-DATUM-1 (аддитивно): датум-калибровка представительной посадки.
     * `agl_datum_offset_ft=null`/`height_datum_calibrated=false` → `*_wheel_ft`
     * отсутствуют (не подделываем значение).
     */
    agl_datum_offset_ft: z.number().finite().nullable().optional(),
    agl_datum_version: z.literal(AGL_DATUM_VERSION).optional(),
    height_datum_calibrated: z.boolean().optional(),
    flare_height_wheel_ft: z.number().finite().nullable().optional(),
    wheel_height_touchdown_ft: z.number().finite().nullable().optional(),
    ils: ilsDeviationStatsSchema.nullable().optional(),
    aoa_touchdown_deg: z.number().finite().nullable().optional(),
    aoa_max_near_touchdown_deg: z.number().finite().nullable().optional(),
    cg_percent_touchdown: z.number().finite().nullable().optional(),
    surface_condition: z.number().int().min(0).max(32).nullable().optional(),
    surface_type: z.number().int().min(0).max(256).nullable().optional(),
    touchdown_point: touchdownPointSchema.nullable().optional(),
    radio_height_touchdown_ft: z.number().finite().nullable().optional(),
    /** ENGINE-MODE: двигатели представительной посадки (касание и пробег). */
    engine_touchdown: engineAggregateSchema.nullable().optional(),
    engine_rollout: engineAggregateSchema.nullable().optional(),
    wind_shear: windShearSchema.nullable().optional(),
    landings_analysis: z.record(z.string(), landingAnalysisSchema).optional(),
  })
  // Толерантный приём: неизвестные ключи агрегатов отбрасываются (§13.3).
  .strip();
export type FlightAggregates = z.output<typeof flightAggregatesSchema>;
export type FlightAggregatesInput = z.input<typeof flightAggregatesSchema>;
