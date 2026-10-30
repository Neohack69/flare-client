import type { EngineMode } from '@flightlog/contracts';

/**
 * Тонкий read-only SimConnect-слой (T8).
 *
 * Жёсткие ограничения (AGENTS.md):
 * - только чтение SimVars; никаких write-операций SimConnect;
 * - никаких pause/unpause, изменения переменных сима или вмешательства в полёт.
 */

/** Нормализованный сэмпл телеметрии (один кадр SimConnect). */
export interface TelemetrySample {
  /** ISO 8601 UTC (клиентское время приёма). */
  ts: string;
  lat: number;
  lon: number;
  alt_ft: number;
  agl_ft: number | null;
  gs_kt: number;
  ias_kt: number | null;
  vs_fpm: number | null;
  heading_deg: number;
  pitch_deg: number;
  bank_deg: number;
  g: number;
  on_ground: boolean;
  /**
   * `GEAR HANDLE POSITION` (Bool): `true` — шасси выпущено, `false` — убрано,
   * `null`/`undefined` — SimVar недоступен. Для событий `gear_down`/`gear_up`.
   */
  gear_down?: boolean | null;
  fuel_qty_gal: number | null;
  /**
   * WAVE 3b: общая масса ВС (`TOTAL WEIGHT`, фунты). `null`/`undefined` —
   * SimVar недоступен (старые/неподдерживаемые сборки). Переводится в кг на
   * касании для агрегата рейса (`stats.landing_weight_kg`).
   */
  total_weight_lb?: number | null;
  /** Хотя бы один двигатель работает (для фаз/старта). */
  engine_running: boolean;
  /** Число работающих двигателей `GENERAL ENG COMBUSTION:1..4` (0..4). */
  engines_running?: number;
  /** `ATC MODEL` (string SimVar) — источник `aircraft_icao` (ADR-0008). */
  atc_model?: string | null;
  /** `ATC TYPE` (string SimVar) — источник `aircraft_icao` (ADR-0008). */
  atc_type?: string | null;
  /** `TITLE` (string SimVar) — имя ВС; fallback-источник `aircraft_icao` (T84). */
  title?: string | null;
  /** Ветер: `AMBIENT WIND DIRECTION` (откуда дует, град). */
  wind_dir_deg?: number | null;
  /** Ветер: `AMBIENT WIND VELOCITY` (узлы, уже включает порывы). */
  wind_speed_kt?: number | null;
  /**
   * Порыв ветра (узлы). В MSFS отдельного SimVar порыва нет — поле `null` и
   * зарезервировано под источники, где порыв доступен.
   */
  wind_gust_kt?: number | null;
  /** `AMBIENT TEMPERATURE` (градусы Цельсия). */
  temp_c?: number | null;
  /** `SEA LEVEL PRESSURE` (миллибары ≈ гПа). */
  qnh_hpa?: number | null;
  /** `AMBIENT PRECIP STATE` (маска: 2 = нет, 4 = дождь, 8 = снег). */
  precip?: number | null;
  /** `AMBIENT VISIBILITY` (метры). */
  visibility_m?: number | null;
  /** `AMBIENT IN CLOUD`. */
  in_cloud?: boolean | null;
  /**
   * WAVE 4 (FOQA). Все поля опциональны и `null`-able: недоступный SimVar даёт
   * `null`/отсутствие, а не поддельный 0. Названия SimVars — в
   * `node-simconnect-adapter.ts` (`SIMVAR_DEFINITION`).
   */
  flaps_index?: number | null;
  /** `FLAPS HANDLE PERCENT` (0..100 %). */
  flaps_percent?: number | null;
  /** `SPOILERS HANDLE POSITION` (0..100 %). */
  spoilers_percent?: number | null;
  spoilers_armed?: boolean | null;
  /** `GEAR POSITION:0..2` (0..100 %) по механизмам. */
  gear_position?: Array<number | null> | null;
  /** `TURB ENG N1:1..4` (0..100 %) по двигателям. */
  n1_percent?: Array<number | null> | null;
  /**
   * Турбинная температура по двигателям (°C). SimVar — `TURB ENG ITT:1..4`
   * (MSFS 2024 не знает `TURB ENG EXHAUST GAS TEMPERATURE`; live-probe).
   */
  egt_c?: Array<number | null> | null;
  /** `TURB ENG FUEL FLOW PPH:1..4` (фунт/час). */
  fuel_flow_pph?: Array<number | null> | null;
  /**
   * ENGINE-MODE: положение РУД по двигателям, % (0..100; у X-Plane idle ≈ 8 %).
   * `null`/отсутствует — SimVar/dataref недоступен.
   */
  throttle_percent?: Array<number | null> | null;
  /** Сырое развёртывание реверса по двигателям, % (MSFS nozzle / XP deploy ratio). */
  reverse_percent?: Array<number | null> | null;
  /** Реверс включён хотя бы на одном двигателе; `null` — сигнала нет. */
  reverse_engaged?: boolean | null;
  /**
   * Честный режим двигателя (только однозначные сигналы: reverse/idle/max).
   * `null`/отсутствует — старый сэмпл или данных нет.
   */
  engine_mode?: EngineMode | null;
  /** `ELEVATOR/AILERON/RUDDER POSITION` (−100..100 %). */
  elevator_position?: number | null;
  aileron_position?: number | null;
  rudder_position?: number | null;
  /** `BRAKE LEFT/RIGHT POSITION` (0..100 %). */
  brake_left_position?: number | null;
  brake_right_position?: number | null;
  autopilot_master?: boolean | null;
  autothrottle_active?: boolean | null;
  autopilot_approach_hold?: boolean | null;
  autopilot_glideslope_hold?: boolean | null;
  /** `INCIDENCE ALPHA/BETA` (радианы). */
  incidence_alpha_rad?: number | null;
  incidence_beta_rad?: number | null;
  /** `HSI CDI/GSI NEEDLE` (отклонение, ед. прибора) и валидность. */
  hsi_cdi_needle?: number | null;
  hsi_cdi_needle_valid?: boolean | null;
  hsi_gsi_needle?: number | null;
  hsi_gsi_needle_valid?: boolean | null;
  hsi_has_localizer?: boolean | null;
  /** `NAV GLIDE SLOPE ERROR`/`NAV RADIAL ERROR` (град). */
  nav_glide_slope_error_deg?: number | null;
  nav_radial_error_deg?: number | null;
  /** `SURFACE CONDITION`/`SURFACE TYPE` (enum). */
  surface_condition?: number | null;
  surface_type?: number | null;
  on_any_runway?: boolean | null;
  /** `RADIO HEIGHT` (ft AGL по радиовысотомеру). */
  radio_height_ft?: number | null;
  /** `CG PERCENT` (0..100 %). */
  cg_percent?: number | null;
  /** `ATC RUNWAY ... RELATIVE POSITION X/Z` (м) — точка касания к порогу/TDPOINT. */
  atc_runway_relative_x_m?: number | null;
  atc_runway_relative_z_m?: number | null;
  atc_runway_tdpoint_relative_x_m?: number | null;
  atc_runway_tdpoint_relative_z_m?: number | null;
  atc_runway_start_distance_m?: number | null;
  atc_runway_end_distance_m?: number | null;
  atc_runway_heading_deg?: number | null;
  atc_runway_length_m?: number | null;
  atc_runway_width_m?: number | null;
  slew: boolean;
  /**
   * Симулятор в режиме повтора (X-Plane: `sim/time/is_in_replay`). Кадры повтора
   * не являются полётом и не должны попадать в запись. В MSFS флага нет.
   */
  replay?: boolean;
}

export interface SimConnectOpenInfo {
  applicationName: string;
  applicationVersion: string;
  simConnectVersion: string;
}

export interface SimConnectAdapterEvents {
  open: (info: SimConnectOpenInfo) => void;
  sample: (sample: TelemetrySample) => void;
  disconnect: (reason?: string) => void;
  error: (error: Error) => void;
}

/** Read-only адаптер SimConnect. Реализации: NodeSimConnectAdapter, MockSimConnectAdapter. */
export interface SimConnectAdapter {
  readonly connected: boolean;
  connect(): Promise<SimConnectOpenInfo>;
  disconnect(): Promise<void>;
  on<K extends keyof SimConnectAdapterEvents>(event: K, handler: SimConnectAdapterEvents[K]): void;
  off<K extends keyof SimConnectAdapterEvents>(event: K, handler: SimConnectAdapterEvents[K]): void;
}
