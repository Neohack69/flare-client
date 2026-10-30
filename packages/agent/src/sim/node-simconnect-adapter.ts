import type { Protocol, SimConnectConnection } from 'node-simconnect';

import { TypedEmitter } from '../util/emitter.js';
import { deriveEngineMode } from './engine-mode.js';
import type {
  SimSource,
  SimSourceCapabilities,
  SimSourceDiagnostics,
  SimSourceEvents,
  SimSourceId,
  SimSourceOpenInfo,
} from './source.js';
import type { TelemetrySample } from './types.js';

/** Читатель бинарного буфера SimConnect (подмножество RawBuffer). */
export interface SimVarReader {
  readFloat64(): number | undefined;
  readInt32(): number | undefined;
  readString256(): string | undefined;
  /** Остаток буфера в байтах (`RawBuffer.remaining`), если доступен. */
  remaining?(): number;
}

/**
 * Базовый (known-good) набор SimVar клиента 0.2.5: **29 полей = 940 байт**.
 *
 * Порядок полей критичен: значения читаются из бинарного буфера в том же
 * порядке, в котором переменные добавлены в data definition.
 * Список соответствует полям `data-model.md` (§5.1 track_points) и `api.md` (§3.3).
 *
 * ⚠️ Каждый новый SimVar обязан быть проверен на ЖИВОМ MSFS 2024 перед релизом.
 * SimConnect молча отклоняет неизвестные переменные, из-за чего фактический
 * размер буфера расходится с ожидаемым layout и хвост полей перестаёт читаться
 * (инцидент клиента 0.3.x: ожидалось 1312 байт = 81 поле, пришло 1308 — один
 * Bool/Enum SimVar был отвергнут симом).
 *
 * WAVE 3b (`TOTAL WEIGHT`) и WAVE 4 (FOQA) вынесены в `FOQA_SIMVAR_GROUPS`.
 * **По умолчанию включены ВСЕ live-проверенные группы** (база 940 Б + 440 Б =
 * **1380 Б / 90 полей**, env не нужен). Env `FLIGHTLOG_FOQA_SIMVARS` — override для
 * staging/bisect: CSV заменяет набор, `all` — все группы, `none` — диагностический
 * opt-out до базы 940 Б. Поля `VERIFY-LIVE` не входят в дефолт (см.
 * `buildSimVarDefinition`); сейчас таких не осталось — engine-mode подтверждены
 * на живом MSFS 2024 (2026-10-20). Типы/агрегаты в `types.ts` уже опциональны,
 * поэтому выключенные поля приходят `null`/отсутствующими («нет данных») без
 * изменения контрактов. Активный набор — `SIMVAR_DEFINITION` (база + включённые группы).
 */
export const BASE_SIMVAR_DEFINITION = [
  { name: 'PLANE LATITUDE', unit: 'degrees', type: 'float64', field: 'lat' },
  { name: 'PLANE LONGITUDE', unit: 'degrees', type: 'float64', field: 'lon' },
  { name: 'PLANE ALTITUDE', unit: 'feet', type: 'float64', field: 'alt_ft' },
  { name: 'PLANE ALT ABOVE GROUND', unit: 'feet', type: 'float64', field: 'agl_ft' },
  { name: 'GROUND VELOCITY', unit: 'knots', type: 'float64', field: 'gs_kt' },
  { name: 'AIRSPEED INDICATED', unit: 'knots', type: 'float64', field: 'ias_kt' },
  { name: 'VERTICAL SPEED', unit: 'feet per minute', type: 'float64', field: 'vs_fpm' },
  { name: 'PLANE HEADING DEGREES TRUE', unit: 'degrees', type: 'float64', field: 'heading_deg' },
  { name: 'PLANE PITCH DEGREES', unit: 'degrees', type: 'float64', field: 'pitch_deg' },
  { name: 'PLANE BANK DEGREES', unit: 'degrees', type: 'float64', field: 'bank_deg' },
  { name: 'G FORCE', unit: 'GForce', type: 'float64', field: 'g' },
  { name: 'SIM ON GROUND', unit: 'Bool', type: 'int32', field: 'on_ground' },
  { name: 'GEAR HANDLE POSITION', unit: 'Bool', type: 'int32', field: 'gear_down' },
  { name: 'FUEL TOTAL QUANTITY', unit: 'gallons', type: 'float64', field: 'fuel_qty_gal' },
  { name: 'GENERAL ENG COMBUSTION:1', unit: 'Bool', type: 'int32', field: 'engine_running' },
  { name: 'GENERAL ENG COMBUSTION:2', unit: 'Bool', type: 'int32', field: 'engine_2' },
  { name: 'GENERAL ENG COMBUSTION:3', unit: 'Bool', type: 'int32', field: 'engine_3' },
  { name: 'GENERAL ENG COMBUSTION:4', unit: 'Bool', type: 'int32', field: 'engine_4' },
  { name: 'IS SLEW ACTIVE', unit: 'Bool', type: 'int32', field: 'slew' },
  // Погода/ветер (MSFS SimVars, read-only). Порыва ветра в MSFS нет: `AMBIENT
  // WIND VELOCITY` уже включает порывы, отдельного `AMBIENT WIND GUST` не существует
  // (sdk.flightsimulator.com, Miscellaneous/Ambient). Поле `wind_gust_kt` — null.
  { name: 'AMBIENT WIND DIRECTION', unit: 'degrees', type: 'float64', field: 'wind_dir_deg' },
  { name: 'AMBIENT WIND VELOCITY', unit: 'knots', type: 'float64', field: 'wind_speed_kt' },
  { name: 'AMBIENT TEMPERATURE', unit: 'celsius', type: 'float64', field: 'temp_c' },
  { name: 'SEA LEVEL PRESSURE', unit: 'millibars', type: 'float64', field: 'qnh_hpa' },
  { name: 'AMBIENT PRECIP STATE', unit: 'Enum', type: 'int32', field: 'precip' },
  { name: 'AMBIENT VISIBILITY', unit: 'meters', type: 'float64', field: 'visibility_m' },
  { name: 'AMBIENT IN CLOUD', unit: 'Bool', type: 'int32', field: 'in_cloud' },
  { name: 'ATC MODEL', unit: null, type: 'string256', field: 'atc_model' },
  { name: 'ATC TYPE', unit: null, type: 'string256', field: 'atc_type' },
  { name: 'TITLE', unit: null, type: 'string256', field: 'title' },
] as const satisfies readonly SimVarDefinition[];

export interface SimVarDefinition {
  readonly name: string;
  /** `null` для строковых SimVars (ATC MODEL/TYPE). */
  readonly unit: string | null;
  readonly type: 'float64' | 'int32' | 'string256';
  readonly field: SimVarField;
  /**
   * `VERIFY-LIVE` — имя ещё не подтверждено на живом MSFS 2024. Такие поля по
   * умолчанию НЕ попадают в runtime-набор (иначе `NAME_UNRECOGNIZED` сдвигает
   * layout и ломает запись). Включаются только явным
   * `FLIGHTLOG_FOQA_UNVERIFIED=1` / `--include-unverified` для live-пробы.
   */
  readonly verification?: 'VERIFY-LIVE' | 'live';
}

export type SimVarField =
  | 'lat'
  | 'lon'
  | 'alt_ft'
  | 'agl_ft'
  | 'gs_kt'
  | 'ias_kt'
  | 'vs_fpm'
  | 'heading_deg'
  | 'pitch_deg'
  | 'bank_deg'
  | 'g'
  | 'on_ground'
  | 'gear_down'
  | 'fuel_qty_gal'
  | 'total_weight_lb'
  | 'engine_running'
  | 'engine_2'
  | 'engine_3'
  | 'engine_4'
  | 'slew'
  | 'wind_dir_deg'
  | 'wind_speed_kt'
  | 'temp_c'
  | 'qnh_hpa'
  | 'precip'
  | 'visibility_m'
  | 'in_cloud'
  | 'flaps_index'
  | 'flaps_percent'
  | 'spoilers_percent'
  | 'spoilers_armed'
  | 'gear_position_0'
  | 'gear_position_1'
  | 'gear_position_2'
  | 'n1_1'
  | 'n1_2'
  | 'n1_3'
  | 'n1_4'
  | 'egt_1'
  | 'egt_2'
  | 'egt_3'
  | 'egt_4'
  | 'fuel_flow_pph_1'
  | 'fuel_flow_pph_2'
  | 'fuel_flow_pph_3'
  | 'fuel_flow_pph_4'
  | 'throttle_1'
  | 'throttle_2'
  | 'throttle_3'
  | 'throttle_4'
  | 'reverse_1'
  | 'reverse_2'
  | 'reverse_3'
  | 'reverse_4'
  | 'reverse_engaged'
  | 'elevator_position'
  | 'aileron_position'
  | 'rudder_position'
  | 'brake_left_position'
  | 'brake_right_position'
  | 'autopilot_master'
  | 'autothrottle_active'
  | 'autopilot_approach_hold'
  | 'autopilot_glideslope_hold'
  | 'incidence_alpha_rad'
  | 'incidence_beta_rad'
  | 'hsi_cdi_needle'
  | 'hsi_cdi_needle_valid'
  | 'hsi_gsi_needle'
  | 'hsi_gsi_needle_valid'
  | 'hsi_has_localizer'
  | 'nav_glide_slope_error_deg'
  | 'nav_radial_error_deg'
  | 'surface_condition'
  | 'surface_type'
  | 'on_any_runway'
  | 'radio_height_ft'
  | 'cg_percent'
  | 'atc_runway_relative_x_m'
  | 'atc_runway_relative_z_m'
  | 'atc_runway_tdpoint_relative_x_m'
  | 'atc_runway_tdpoint_relative_z_m'
  | 'atc_runway_start_distance_m'
  | 'atc_runway_end_distance_m'
  | 'atc_runway_heading_deg'
  | 'atc_runway_length_m'
  | 'atc_runway_width_m'
  | 'atc_model'
  | 'atc_type'
  | 'title';

/**
 * FOQA SimVars (Wave 3b/4), сгруппированные по batch'ам
 * `docs/architecture/foqa-simvars-staging.md`.
 *
 * Поля дописываются к `BASE_SIMVAR_DEFINITION` в порядке `FOQA_GROUP_ORDER`,
 * поэтому offsets базовых полей стабильны независимо от включённых групп.
 * Размеры (байты): config +52, autopilot +16, ils +44, aoa +24, touchdown +92,
 * engines +204 (все 26 полей), weight +8 → база 940 + 440 = **1380**
 * (полный Wave-4, 90 полей).
 *
 * `engines` live-validated на MSFS 2024 (probe `scripts/simvar-probe.mjs`):
 * 4 поля EGT заменены на `TURB ENG ITT:1..4` (приняты симом); отвергнутые
 * `TURB ENG EXHAUST GAS TEMPERATURE:i`/`EXHAUST GAS TEMPERATURE:i` давали
 * 4×NAME_UNRECOGNIZED и дефицит 32 Б. Число полей/байт группы не изменилось.
 *
 * ENGINE-MODE: 4 тяги РУД + 4 nozzle + 1 Bool реверса — `verification: 'live'`
 * (MSFS 2024, 2026-10-20: 90 accepted / 0 rejected, 1380 B, CLEAN). Входят в
 * дефолт вместе с остальными группами. X-Plane-ветка использует свои dataref'ы
 * (`throttle_ratio`, `throttle_beta_rev_ratio`, `thrust_reverser_deploy_ratio`)
 * и от этого флага не зависит.
 */
export const FOQA_SIMVAR_GROUPS = {
  config: [
    { name: 'FLAPS HANDLE INDEX', unit: 'Number', type: 'float64', field: 'flaps_index' },
    { name: 'FLAPS HANDLE PERCENT', unit: 'percent', type: 'float64', field: 'flaps_percent' },
    {
      name: 'SPOILERS HANDLE POSITION',
      unit: 'percent',
      type: 'float64',
      field: 'spoilers_percent',
    },
    { name: 'SPOILERS ARMED', unit: 'Bool', type: 'int32', field: 'spoilers_armed' },
    { name: 'GEAR POSITION:0', unit: 'percent', type: 'float64', field: 'gear_position_0' },
    { name: 'GEAR POSITION:1', unit: 'percent', type: 'float64', field: 'gear_position_1' },
    { name: 'GEAR POSITION:2', unit: 'percent', type: 'float64', field: 'gear_position_2' },
  ],
  autopilot: [
    { name: 'AUTOPILOT MASTER', unit: 'Bool', type: 'int32', field: 'autopilot_master' },
    { name: 'AUTOTHROTTLE ACTIVE', unit: 'Bool', type: 'int32', field: 'autothrottle_active' },
    {
      name: 'AUTOPILOT APPROACH HOLD',
      unit: 'Bool',
      type: 'int32',
      field: 'autopilot_approach_hold',
    },
    {
      name: 'AUTOPILOT GLIDESLOPE HOLD',
      unit: 'Bool',
      type: 'int32',
      field: 'autopilot_glideslope_hold',
    },
  ],
  ils: [
    { name: 'HSI CDI NEEDLE', unit: 'Number', type: 'float64', field: 'hsi_cdi_needle' },
    {
      name: 'HSI CDI NEEDLE VALID',
      unit: 'Bool',
      type: 'int32',
      field: 'hsi_cdi_needle_valid',
    },
    { name: 'HSI GSI NEEDLE', unit: 'Number', type: 'float64', field: 'hsi_gsi_needle' },
    {
      name: 'HSI GSI NEEDLE VALID',
      unit: 'Bool',
      type: 'int32',
      field: 'hsi_gsi_needle_valid',
    },
    { name: 'HSI HAS LOCALIZER', unit: 'Bool', type: 'int32', field: 'hsi_has_localizer' },
    {
      name: 'NAV GLIDE SLOPE ERROR',
      unit: 'degrees',
      type: 'float64',
      field: 'nav_glide_slope_error_deg',
    },
    { name: 'NAV RADIAL ERROR', unit: 'degrees', type: 'float64', field: 'nav_radial_error_deg' },
  ],
  aoa: [
    { name: 'INCIDENCE ALPHA', unit: 'radians', type: 'float64', field: 'incidence_alpha_rad' },
    { name: 'INCIDENCE BETA', unit: 'radians', type: 'float64', field: 'incidence_beta_rad' },
    { name: 'CG PERCENT', unit: 'percent', type: 'float64', field: 'cg_percent' },
  ],
  touchdown: [
    { name: 'SURFACE CONDITION', unit: 'Enum', type: 'int32', field: 'surface_condition' },
    { name: 'SURFACE TYPE', unit: 'Enum', type: 'int32', field: 'surface_type' },
    { name: 'ON ANY RUNWAY', unit: 'Bool', type: 'int32', field: 'on_any_runway' },
    { name: 'RADIO HEIGHT', unit: 'feet', type: 'float64', field: 'radio_height_ft' },
    {
      name: 'ATC RUNWAY RELATIVE POSITION X',
      unit: 'meters',
      type: 'float64',
      field: 'atc_runway_relative_x_m',
    },
    {
      name: 'ATC RUNWAY RELATIVE POSITION Z',
      unit: 'meters',
      type: 'float64',
      field: 'atc_runway_relative_z_m',
    },
    {
      name: 'ATC RUNWAY TDPOINT RELATIVE POSITION X',
      unit: 'meters',
      type: 'float64',
      field: 'atc_runway_tdpoint_relative_x_m',
    },
    {
      name: 'ATC RUNWAY TDPOINT RELATIVE POSITION Z',
      unit: 'meters',
      type: 'float64',
      field: 'atc_runway_tdpoint_relative_z_m',
    },
    {
      name: 'ATC RUNWAY START DISTANCE',
      unit: 'meters',
      type: 'float64',
      field: 'atc_runway_start_distance_m',
    },
    {
      name: 'ATC RUNWAY END DISTANCE',
      unit: 'meters',
      type: 'float64',
      field: 'atc_runway_end_distance_m',
    },
    {
      name: 'ATC RUNWAY HEADING DEGREES TRUE',
      unit: 'degrees',
      type: 'float64',
      field: 'atc_runway_heading_deg',
    },
    { name: 'ATC RUNWAY LENGTH', unit: 'meters', type: 'float64', field: 'atc_runway_length_m' },
    { name: 'ATC RUNWAY WIDTH', unit: 'meters', type: 'float64', field: 'atc_runway_width_m' },
  ],
  engines: [
    { name: 'TURB ENG N1:1', unit: 'percent', type: 'float64', field: 'n1_1' },
    { name: 'TURB ENG N1:2', unit: 'percent', type: 'float64', field: 'n1_2' },
    { name: 'TURB ENG N1:3', unit: 'percent', type: 'float64', field: 'n1_3' },
    { name: 'TURB ENG N1:4', unit: 'percent', type: 'float64', field: 'n1_4' },
    // MSFS 2024 не знает `TURB ENG EXHAUST GAS TEMPERATURE:i` и
    // `EXHAUST GAS TEMPERATURE:i` (live-probe: NAME_UNRECOGNIZED, инцидент
    // sendId 68..71, дефицит 32 Б). Принятый аналог турбинной температуры —
    // `TURB ENG ITT:i` (interstage turbine temperature, unit `celsius`,
    // подтверждено read-only probe `scripts/simvar-probe.mjs` на живом симе).
    // Поле контракта остаётся `egt_*`/`egt_c` (turbine temperature) без миграций.
    { name: 'TURB ENG ITT:1', unit: 'celsius', type: 'float64', field: 'egt_1' },
    { name: 'TURB ENG ITT:2', unit: 'celsius', type: 'float64', field: 'egt_2' },
    { name: 'TURB ENG ITT:3', unit: 'celsius', type: 'float64', field: 'egt_3' },
    { name: 'TURB ENG ITT:4', unit: 'celsius', type: 'float64', field: 'egt_4' },
    { name: 'TURB ENG FUEL FLOW PPH:1', unit: 'pph', type: 'float64', field: 'fuel_flow_pph_1' },
    { name: 'TURB ENG FUEL FLOW PPH:2', unit: 'pph', type: 'float64', field: 'fuel_flow_pph_2' },
    { name: 'TURB ENG FUEL FLOW PPH:3', unit: 'pph', type: 'float64', field: 'fuel_flow_pph_3' },
    { name: 'TURB ENG FUEL FLOW PPH:4', unit: 'pph', type: 'float64', field: 'fuel_flow_pph_4' },
    { name: 'ELEVATOR POSITION', unit: 'percent', type: 'float64', field: 'elevator_position' },
    { name: 'AILERON POSITION', unit: 'percent', type: 'float64', field: 'aileron_position' },
    { name: 'RUDDER POSITION', unit: 'percent', type: 'float64', field: 'rudder_position' },
    {
      name: 'BRAKE LEFT POSITION',
      unit: 'percent',
      type: 'float64',
      field: 'brake_left_position',
    },
    {
      name: 'BRAKE RIGHT POSITION',
      unit: 'percent',
      type: 'float64',
      field: 'brake_right_position',
    },
    // ENGINE-MODE: verified live on MSFS 2024 (2026-10-20). Read-only probe
    // `pnpm --filter @flightlog/agent simvar:probe -- --groups all --include-unverified`
    // → 90 accepted / 0 rejected, EXPECTED/OBSERVED 1380 B, RESULT: CLEAN. Names:
    // `GENERAL ENG THROTTLE LEVER POSITION:1..4` (Percent),
    // `TURB ENG REVERSE NOZZLE PERCENT:1..4` (Percent),
    // `GENERAL ENG REVERSE THRUST ENGAGED` (Bool).
    {
      name: 'GENERAL ENG THROTTLE LEVER POSITION:1',
      unit: 'percent',
      type: 'float64',
      field: 'throttle_1',
      verification: 'live',
    },
    {
      name: 'GENERAL ENG THROTTLE LEVER POSITION:2',
      unit: 'percent',
      type: 'float64',
      field: 'throttle_2',
      verification: 'live',
    },
    {
      name: 'GENERAL ENG THROTTLE LEVER POSITION:3',
      unit: 'percent',
      type: 'float64',
      field: 'throttle_3',
      verification: 'live',
    },
    {
      name: 'GENERAL ENG THROTTLE LEVER POSITION:4',
      unit: 'percent',
      type: 'float64',
      field: 'throttle_4',
      verification: 'live',
    },
    {
      name: 'TURB ENG REVERSE NOZZLE PERCENT:1',
      unit: 'percent',
      type: 'float64',
      field: 'reverse_1',
      verification: 'live',
    },
    {
      name: 'TURB ENG REVERSE NOZZLE PERCENT:2',
      unit: 'percent',
      type: 'float64',
      field: 'reverse_2',
      verification: 'live',
    },
    {
      name: 'TURB ENG REVERSE NOZZLE PERCENT:3',
      unit: 'percent',
      type: 'float64',
      field: 'reverse_3',
      verification: 'live',
    },
    {
      name: 'TURB ENG REVERSE NOZZLE PERCENT:4',
      unit: 'percent',
      type: 'float64',
      field: 'reverse_4',
      verification: 'live',
    },
    {
      name: 'GENERAL ENG REVERSE THRUST ENGAGED',
      unit: 'Bool',
      type: 'int32',
      field: 'reverse_engaged',
      verification: 'live',
    },
  ],
  weight: [{ name: 'TOTAL WEIGHT', unit: 'Pounds', type: 'float64', field: 'total_weight_lb' }],
} as const satisfies Record<string, readonly SimVarDefinition[]>;

export type FoqaSimVarGroup = keyof typeof FOQA_SIMVAR_GROUPS;

/** Канонический порядок групп (совпадает с порядком batch'ей staging-доки). */
export const FOQA_GROUP_ORDER = [
  'config',
  'autopilot',
  'ils',
  'aoa',
  'touchdown',
  'engines',
  'weight',
] as const satisfies readonly FoqaSimVarGroup[];

/** Env-флаг FOQA-групп: CSV имён (`config,ils`), `all` или `none`. */
export const FOQA_SIMVARS_ENV = 'FLIGHTLOG_FOQA_SIMVARS';

/**
 * Env-флаг live-пробы: `1` добавляет поля с `verification: 'VERIFY-LIVE'`.
 * Сейчас таких полей нет (engine-mode подтверждены 2026-10-20), поэтому флаг
 * не меняет набор; оставлен для будущих кандидатов.
 */
export const FOQA_UNVERIFIED_ENV = 'FLIGHTLOG_FOQA_UNVERIFIED';

/**
 * FOQA-группы по умолчанию (env не задан): **все live-проверенные группы**.
 * База остаётся 29 полей / 940 Б; FOQA дописывается после неё (61 поле / +440 Б
 * → **90 полей / 1380 Б**). `VERIFY-LIVE`-поля (если появятся) отсекаются в
 * `buildSimVarDefinition`.
 */
export const DEFAULT_FOQA_GROUPS: readonly FoqaSimVarGroup[] = [...FOQA_GROUP_ORDER];

export interface FoqaGroupSelection {
  /** Включённые группы в каноническом порядке. */
  groups: FoqaSimVarGroup[];
  /** Неизвестные имена (игнорируются, но логируются). */
  unknown: string[];
}

function isFoqaSimVarGroup(value: string): value is FoqaSimVarGroup {
  return Object.prototype.hasOwnProperty.call(FOQA_SIMVAR_GROUPS, value);
}

function groupDefinitions(group: FoqaSimVarGroup): readonly SimVarDefinition[] {
  return FOQA_SIMVAR_GROUPS[group];
}

function canonicalGroups(requested: ReadonlySet<FoqaSimVarGroup>): FoqaSimVarGroup[] {
  return FOQA_GROUP_ORDER.filter((group) => requested.has(group));
}

/**
 * Разбирает значение `FLIGHTLOG_FOQA_SIMVARS` (CSV имён групп, `all`, `none`).
 *
 * **Default:** все live-проверенные группы включены без env (90 полей / 1380 Б).
 * **Override:** непустой env заменяет набор — `config,ils` = только эти группы,
 * `all` = все, `none` = база 940 Б. `none,config` = только `config` (сначала
 * opt-out, затем явные группы). Неизвестные имена не бросают ошибку, а
 * возвращаются в `unknown`; env из одних неизвестных имён дефолт не отключает.
 */
export function parseFoqaGroups(raw: string | null | undefined): FoqaGroupSelection {
  const unknown: string[] = [];
  if (typeof raw !== 'string') return { groups: [...DEFAULT_FOQA_GROUPS], unknown };

  const tokens = raw
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return { groups: [...DEFAULT_FOQA_GROUPS], unknown };

  const requested = new Set<FoqaSimVarGroup>();
  let all = false;
  let none = false;
  for (const token of tokens) {
    if (token === 'all') {
      all = true;
    } else if (token === 'none') {
      none = true;
    } else if (isFoqaSimVarGroup(token)) {
      requested.add(token);
    } else if (!unknown.includes(token)) {
      unknown.push(token);
    }
  }
  if (all) return { groups: [...FOQA_GROUP_ORDER], unknown };
  // Опечатка в env не должна тихо отключать FOQA: набор остаётся дефолтным.
  if (none || requested.size > 0) return { groups: canonicalGroups(requested), unknown };
  return { groups: [...DEFAULT_FOQA_GROUPS], unknown };
}

export interface BuildSimVarDefinitionOptions {
  /**
   * Включить поля `VERIFY-LIVE` (live-проба). В клиенте не используется:
   * непроверенный SimVar может быть отвергнут симом.
   */
  includeUnverified?: boolean;
}

/** Собирает runtime-набор: `BASE_SIMVAR_DEFINITION` + выбранные FOQA-группы. */
export function buildSimVarDefinition(
  groups: readonly FoqaSimVarGroup[] = [],
  options: BuildSimVarDefinitionOptions = {},
): readonly SimVarDefinition[] {
  const enabled = new Set<FoqaSimVarGroup>(groups);
  const definition: SimVarDefinition[] = [...BASE_SIMVAR_DEFINITION];
  for (const group of FOQA_GROUP_ORDER) {
    if (!enabled.has(group)) continue;
    for (const def of groupDefinitions(group)) {
      if (!options.includeUnverified && def.verification === 'VERIFY-LIVE') continue;
      definition.push(def);
    }
  }
  return definition;
}

/** Имя FOQA-группы, которой принадлежит поле (`null` для базового набора). */
export function findFoqaGroupForField(field: SimVarField): FoqaSimVarGroup | null {
  for (const group of FOQA_GROUP_ORDER) {
    if (groupDefinitions(group).some((def) => def.field === field)) return group;
  }
  return null;
}

const RUNTIME_FOQA_SELECTION = parseFoqaGroups(process.env[FOQA_SIMVARS_ENV]);

/** `FLIGHTLOG_FOQA_UNVERIFIED=1` — live-проба ещё не подтверждённых SimVars. */
export const INCLUDE_UNVERIFIED_FOQA: boolean = process.env[FOQA_UNVERIFIED_ENV] === '1';

/** FOQA-группы, включённые в текущем процессе (из env; default — все группы). */
export const ENABLED_FOQA_GROUPS: readonly FoqaSimVarGroup[] = RUNTIME_FOQA_SELECTION.groups;

/** Неизвестные имена FOQA-групп из env (игнорируются; логируются при connect). */
export const UNKNOWN_FOQA_GROUPS: readonly string[] = RUNTIME_FOQA_SELECTION.unknown;

/**
 * Активный runtime-набор SimVars: база + включённые FOQA-группы.
 * По умолчанию (env не задан) — **90 полей / 1380 Б** (база 940 Б + все
 * live-проверенные группы). `FLIGHTLOG_FOQA_SIMVARS=none` → 29 полей / 940 Б,
 * `engines` → 55 / 1144. `FLIGHTLOG_FOQA_UNVERIFIED=1` теперь ничего не меняет
 * (все engine-mode поля подтверждены live).
 */
export const SIMVAR_DEFINITION: readonly SimVarDefinition[] = buildSimVarDefinition(
  ENABLED_FOQA_GROUPS,
  { includeUnverified: INCLUDE_UNVERIFIED_FOQA },
);

const DATA_DEFINITION_ID = 1;
const DATA_REQUEST_ID = 1;
/**
 * Верхний предел частоты исходящих сэмплов. D1: 20 Гц — окно касания пишется
 * 20 Гц (`AdaptiveSampler.touchdownHz`), иначе сэмплер не получает 20 Гц.
 */
const DEFAULT_MAX_SAMPLE_HZ = 20;

export const DEFAULT_CLIENT_NAME = 'Flare (read-only)';

export const DEFAULT_PROTOCOL = 'sunrise' as const;

export type SimConnectProtocolName = 'sunrise' | 'kittyhawk' | 'fsx_sp2';

/**
 * Дешёвая read-only проба MSFS для `auto`-дискавери (ADR-0023 §3): `SimConnect.open`
 * fail-fast + немедленный `close`. Ничего не читает и не пишет в сим. Вызывается
 * ТОЛЬКО когда уже подтверждён запущенный не-дефолтный сим (X-Plane), поэтому
 * поведение MSFS-only пользователя не меняется (проба не выполняется вовсе).
 */
export async function probeSimConnectAvailability(
  options: { clientName?: string; protocol?: SimConnectProtocolName } = {},
): Promise<boolean> {
  try {
    const mod = await import('node-simconnect');
    const protocolName = options.protocol ?? DEFAULT_PROTOCOL;
    const protocol =
      protocolName === 'kittyhawk'
        ? mod.Protocol.KittyHawk
        : protocolName === 'fsx_sp2'
          ? mod.Protocol.FSX_SP2
          : mod.Protocol.SunRise;
    const { handle } = await mod.open(options.clientName ?? DEFAULT_CLIENT_NAME, protocol);
    handle.close();
    return true;
  } catch {
    return false;
  }
}

/** Минимальный контракт логгера адаптера (совместим с `Logger` из `cli/logger`). */
export interface SimConnectAdapterLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface NodeSimConnectAdapterOptions {
  clientName?: string;
  protocol?: SimConnectProtocolName;
  remote?: { host: string; port: number };
  /** Верхний предел частоты исходящих сэмплов (SimConnect SIM_FRAME может быть выше). */
  maxSampleHz?: number;
  /** Runtime-набор SimVars (по умолчанию `SIMVAR_DEFINITION` — база + env-группы). */
  definition?: readonly SimVarDefinition[];
  /** Включённые FOQA-группы (по умолчанию из env) — только для диагностики. */
  foqaGroups?: readonly FoqaSimVarGroup[];
  /** Неизвестные FOQA-группы из env (по умолчанию из env) — только для диагностики. */
  unknownFoqaGroups?: readonly string[];
  /** Диагностика при connect: enabled группы + ожидаемый размер payload. */
  logger?: SimConnectAdapterLogger;
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** Неотрицательное конечное число или `null` (скорости/видимость). */
function nonNegativeOrNull(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** `Bool` SimVar: `0`/`1` → `false`/`true`; `undefined` (не читалось) → `null`. */
function boolOrNull(value: number | undefined): boolean | null {
  return value === undefined ? null : value !== 0;
}

/** Enum SimVar в допустимом диапазоне `[0, max]`, иначе `null`. */
function enumOrNull(value: number | undefined, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    return null;
  }
  return value;
}

/** Нормализация направления ветра в `[0, 360)`. */
function normalizeDirection(value: number): number {
  const wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function cleanString(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Размер одного поля data definition в байтах: `float64`=8, `int32`=4, `string256`=256. */
export function simVarFieldSize(type: SimVarDefinition['type']): number {
  if (type === 'string256') return 256;
  if (type === 'int32') return 4;
  return 8;
}

/** Ожидаемый размер payload SimConnect (в байтах) для набора SimVars. */
export function expectedSimVarLayoutSize(
  definition: readonly SimVarDefinition[] = SIMVAR_DEFINITION,
): number {
  let total = 0;
  for (const def of definition) total += simVarFieldSize(def.type);
  return total;
}

export interface SimVarDefinitionDiagnostics {
  message: string;
  meta: Record<string, unknown>;
}

/**
 * One-time диагностика активного набора при connect: включённые FOQA-группы и
 * ожидаемый размер payload (тот же расчёт, что печатает probe `simvar-layout.mjs`).
 * Числа из meta сверяются с `expected X / got Y` из лога расхождения.
 */
export function describeSimVarDefinition(
  definition: readonly SimVarDefinition[],
  groups: readonly FoqaSimVarGroup[] = ENABLED_FOQA_GROUPS,
  unknown: readonly string[] = UNKNOWN_FOQA_GROUPS,
): SimVarDefinitionDiagnostics {
  const expectedBytes = expectedSimVarLayoutSize(definition);
  return {
    message:
      `SimConnect data definition: ${definition.length} fields, expected payload ` +
      `${expectedBytes} bytes; FOQA groups: ${groups.length > 0 ? groups.join(', ') : 'none'}`,
    meta: {
      fields: definition.length,
      expected_bytes: expectedBytes,
      foqa_groups: [...groups],
      foqa_env: FOQA_SIMVARS_ENV,
      ...(unknown.length > 0 ? { unknown_groups: [...unknown] } : {}),
    },
  };
}

/** Расхождение фактического размера буфера с ожидаемым layout. */
export interface SimVarLayoutMismatch {
  expectedBytes: number;
  actualBytes: number;
  /** `true` — буфер короче ожидаемого (хвост полей обрезан). */
  truncated: boolean;
  /** Индекс первого поля, не помещающегося в буфер. */
  fieldIndex: number;
  field: SimVarField;
  simVar: string;
  unit: string | null;
  /** FOQA-группа поля (`null` — базовый набор). */
  group: FoqaSimVarGroup | null;
}

/** Диагностика расхождения размера буфера: первые байты, которых не хватает. */
export function detectSimVarLayoutMismatch(
  actualBytes: number,
  definition: readonly SimVarDefinition[] = SIMVAR_DEFINITION,
): SimVarLayoutMismatch | null {
  const expectedBytes = expectedSimVarLayoutSize(definition);
  if (actualBytes === expectedBytes) return null;

  let offset = 0;
  for (let index = 0; index < definition.length; index += 1) {
    const def = definition[index];
    if (!def) break;
    const size = simVarFieldSize(def.type);
    if (offset + size > actualBytes) {
      return {
        expectedBytes,
        actualBytes,
        truncated: true,
        fieldIndex: index,
        field: def.field,
        simVar: def.name,
        unit: def.unit,
        group: findFoqaGroupForField(def.field),
      };
    }
    offset += size;
  }

  const last = definition[definition.length - 1];
  return {
    expectedBytes,
    actualBytes,
    truncated: false,
    fieldIndex: definition.length,
    field: last?.field ?? 'title',
    simVar: last?.name ?? 'TITLE',
    unit: last?.unit ?? null,
    group: last ? findFoqaGroupForField(last.field) : null,
  };
}

/** Одно зарегистрированное поле data definition вместе с `sendId`-пакетом. */
export interface SimVarSendIdEntry {
  /** 0-based id AddToDataDefinition-пакета (`addToDataDefinition` возвращает его же). */
  sendId: number;
  /** 0-based позиция поля в data definition. */
  index: number;
  def: SimVarDefinition;
  /** FOQA-группа поля (`null` — базовый набор). */
  group: FoqaSimVarGroup | null;
}

/**
 * Строит карту `sendId → поле` по фактическим id, возвращённым
 * `addToDataDefinition` при регистрации (порядок = порядок `definition`).
 * Нужна, чтобы связать `NAME_UNRECOGNIZED`-исключение (по `sendId`) с именем
 * SimVar: сим молча выкидывает неизвестную переменную из layout.
 */
export function buildSimVarSendIdMap(
  definition: readonly SimVarDefinition[],
  sendIds: readonly number[],
): Map<number, SimVarSendIdEntry> {
  const map = new Map<number, SimVarSendIdEntry>();
  for (let index = 0; index < definition.length; index += 1) {
    const def = definition[index];
    const sendId = sendIds[index];
    if (!def || sendId === undefined) continue;
    map.set(sendId, { sendId, index, def, group: findFoqaGroupForField(def.field) });
  }
  return map;
}

/** Поле, отвергнутое симом (`NAME_UNRECOGNIZED`), найденное по `sendId`. */
export interface RejectedSimVar {
  sendId: number;
  index: number;
  simVar: string;
  unit: string | null;
  field: SimVarField;
  group: FoqaSimVarGroup | null;
  exceptionName: string;
}

/** Минимальная форма исключения SimConnect для сопоставления по sendId. */
export interface SimConnectExceptionLike {
  sendId?: number;
  exception?: number;
  exceptionName?: string;
}

const NAME_UNRECOGNIZED_CODE = 7;

function isNameUnrecognized(exception: SimConnectExceptionLike): boolean {
  return exception.exceptionName === 'NAME_UNRECOGNIZED' ||
    exception.exception === NAME_UNRECOGNIZED_CODE;
}

/**
 * Возвращает отвергнутое поле для `NAME_UNRECOGNIZED`-исключения, если его
 * `sendId` есть в карте регистрации; иначе `null` (исключение не про SimVar).
 */
export function selectRejectedSimVar(
  sendIdMap: ReadonlyMap<number, SimVarSendIdEntry>,
  exception: SimConnectExceptionLike,
): RejectedSimVar | null {
  if (!isNameUnrecognized(exception)) return null;
  const { sendId } = exception;
  if (typeof sendId !== 'number') return null;
  const entry = sendIdMap.get(sendId);
  if (!entry) return null;
  return {
    sendId,
    index: entry.index,
    simVar: entry.def.name,
    unit: entry.def.unit,
    field: entry.def.field,
    group: entry.group,
    exceptionName: exception.exceptionName ?? 'NAME_UNRECOGNIZED',
  };
}

/** Сообщение об отвергнутом SimVar: имя, поле, группа и код исключения. */
export function describeRejectedSimVar(rejected: RejectedSimVar): string {
  const groupSuffix = rejected.group ? `, FOQA group '${rejected.group}'` : '';
  return (
    `SimConnect rejected SimVar '${rejected.simVar}' (${rejected.field}${groupSuffix})` +
    ` — ${rejected.exceptionName}`
  );
}

/** Компактный формат числа для one-time диагностики (до 6 значащих цифр). */
function formatDiagnosticNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs < 1e-3 || abs >= 1e6) return value.toExponential(4);
  return value.toPrecision(6);
}

/**
 * Сообщение об инертном показании двигателя (ambient-as-ITT / ~0 flow): называет
 * SimVar, поле, FOQA-группу, причину и значение. Стиль совпадает с
 * `describeRejectedSimVar`; строка пишется one-time на поле за сессию.
 */
export function describeInertEngineReading(reading: InertEngineReading): string {
  const group = findFoqaGroupForField(reading.field);
  const groupSuffix = group ? `, FOQA group '${group}'` : '';
  const n1 = reading.n1_percent === null ? 'n/a' : `${formatDiagnosticNumber(reading.n1_percent)}%`;
  let reason: string;
  if (reading.reason === 'itt_sentinel') {
    reason =
      `sentinel ${formatDiagnosticNumber(reading.value)} ${reading.unit ?? '°C'} ` +
      `(0 K = engine absent)`;
  } else if (reading.reason === 'itt_ambient') {
    reason =
      `ambient-as-ITT (${formatDiagnosticNumber(reading.value)} °C ≈ ambient ` +
      `${formatDiagnosticNumber(reading.ambient_c)} °C) while N1=${n1}`;
  } else {
    reason = `inert ~0 fuel flow (${formatDiagnosticNumber(reading.value)} ${reading.unit ?? ''}) while N1=${n1}`;
  }
  return (
    `SimConnect engine SimVar '${reading.simVar}' (${reading.field}${groupSuffix}) ` +
    `carries no real reading — ${reason}; reporting null`
  );
}

/**
 * Обёртка над бинарным читателем, устойчивая к обрезанному/разъехавшемуся буферу.
 * Если поле не влезает (по `remaining()`) или чтение бросает `RangeError`, оно
 * возвращается как `undefined` (→ `null` в сэмпле) вместо исключения. Благодаря
 * этому `parseSample` не падает на телеметрии и запись рейса не теряется.
 */
export function createResilientReader(
  reader: SimVarReader,
  definition: readonly SimVarDefinition[] = SIMVAR_DEFINITION,
): {
  reader: SimVarReader;
  layoutMismatch: () => SimVarLayoutMismatch | null;
} {
  const expectedBytes = expectedSimVarLayoutSize(definition);
  const startRemaining = reader.remaining?.();
  const actualBytes = startRemaining ?? expectedBytes;
  let fieldIndex = 0;
  let mismatch: SimVarLayoutMismatch | null = null;

  const recordMismatch = (): undefined => {
    if (mismatch) return undefined;
    const def = definition[fieldIndex];
    mismatch = detectSimVarLayoutMismatch(actualBytes, definition) ?? {
      expectedBytes,
      actualBytes,
      truncated: true,
      fieldIndex,
      field: def?.field ?? 'title',
      simVar: def?.name ?? 'TITLE',
      unit: def?.unit ?? null,
      group: findFoqaGroupForField(def?.field ?? 'title'),
    };
    return undefined;
  };

  const guard = <T>(size: number, read: () => T): T | undefined => {
    if (mismatch) return undefined;
    const remaining = reader.remaining?.();
    if (remaining !== undefined && remaining < size) return recordMismatch();
    try {
      const value = read();
      fieldIndex += 1;
      return value;
    } catch {
      return recordMismatch();
    }
  };

  return {
    reader: {
      readFloat64: () => guard(8, () => reader.readFloat64()),
      readInt32: () => guard(4, () => reader.readInt32()),
      readString256: () => guard(256, () => reader.readString256()),
    },
    layoutMismatch: () => mismatch,
  };
}

/**
 * Защита от «принятого, но инертного» SimVar в `engines`-группе (FOQA).
 *
 * Live-probe MSFS 2024 (A220-300/BCS3, FL370) показал, что сим принимает имена,
 * но значения не являются показаниями двигателя:
 * - `TURB ENG ITT:n` возвращает ambient (температуру воздуха, −55.7 °C при
 *   ambient −55.7 °C) — псевдо-ITT;
 * - `TURB ENG FUEL FLOW PPH:n` возвращает ~1.7e-5 pph (~0) при работающей
 *   турбине (N1 ≈ 75…99 %), `ENG FUEL FLOW PPH/GPH` — то же;
 * - все альтернативы (`TURB ENG EGT`, `EXHAUST GAS TEMPERATURE`,
 *   `TURB ENG OIL TEMPERATURE`, `TURB ENG FUEL FLOW GPH`, `... SSL`,
 *   `GENERAL ENG FUEL FLOW`) сим отвергает (`NAME_UNRECOGNIZED`);
 * - пустые слоты двигателей (3/4 у двухмоторного) отдают sentinel: ITT −273.15 °C
 *   (= 0 K), расход 0.
 *
 * Явного флага «нет данных» сим не даёт, поэтому единственный честный выход —
 * распознать инертное/невозможное значение и отдать `null` (никогда не
 * ambient-as-ITT и не 0-as-flow в анализ/AI). Реальные показания (напр. у
 * дефолтных ВС) проходят guard без изменений.
 */
/** `0 K` в абсолютной шкале = −273.15 °C: sentinel «двигателя нет». */
export const EGT_SENTINEL_MAX_C = -200;
/** Минимальный подъём ITT над ambient для работающей турбины (°C). */
export const EGT_RUNNING_RISE_MIN_C = 5;
/** N1 (%), выше которого турбина считается работающей. */
export const N1_RUNNING_PERCENT = 5;
/** Минимальный правдоподобный расход работающей турбины (фунт/час). */
export const MIN_PLAUSIBLE_FUEL_FLOW_PPH = 1;

export type InertEngineReadingReason = 'itt_sentinel' | 'itt_ambient' | 'flow_inert';

/** Инертное показание двигателя, деградированное в `null` (для one-time лога). */
export interface InertEngineReading {
  field: SimVarField;
  simVar: string;
  unit: string | null;
  /** 0-based индекс двигателя в плоском массиве `egt_c`/`fuel_flow_pph`. */
  index: number;
  reason: InertEngineReadingReason;
  /** Сырое (инертное) значение из сима. */
  value: number;
  n1_percent: number | null;
  ambient_c: number | null;
}

export interface EngineSanitizeResult {
  value: number | null;
  reason: InertEngineReadingReason | null;
}

/**
 * Турбинная температура: `null` для sentinel (0 K) и для ambient-as-ITT
 * (работающая турбина, но значение у ambient). Иначе — значение как есть.
 */
export function sanitizeEngineTemperature(
  value: number | null,
  n1Percent: number | null,
  ambientC: number | null,
): EngineSanitizeResult {
  if (value === null) return { value: null, reason: null };
  if (value <= EGT_SENTINEL_MAX_C) return { value: null, reason: 'itt_sentinel' };
  const running = n1Percent !== null && n1Percent >= N1_RUNNING_PERCENT;
  if (running && ambientC !== null && value < ambientC + EGT_RUNNING_RISE_MIN_C) {
    return { value: null, reason: 'itt_ambient' };
  }
  return { value, reason: null };
}

/**
 * Топливный расход: значение ниже правдоподобного минимума (~0) неотличимо от
 * инертного/отсутствующего канала → `null`.
 */
export function sanitizeFuelFlow(value: number | null): EngineSanitizeResult {
  if (value === null) return { value: null, reason: null };
  if (value < MIN_PLAUSIBLE_FUEL_FLOW_PPH) return { value: null, reason: 'flow_inert' };
  return { value, reason: null };
}

export interface ParsedSample {
  sample: TelemetrySample;
  /** Расхождение layout буфера, если было; иначе `null`. */
  layoutMismatch: SimVarLayoutMismatch | null;
  /** Инертные показания двигателей (ambient-as-ITT / ~0 flow), отданные `null`. */
  inertEngineReadings: InertEngineReading[];
}

/**
 * Каноническая конвенция отношения (`TelemetrySample`, scoring, replay):
 * `pitch_deg > 0` — нос вверх, `bank_deg > 0` — правое полукрыло вниз (правый крен).
 *
 * MSFS SimConnect отдаёт `PLANE PITCH DEGREES` / `PLANE BANK DEGREES` с обратным знаком
 * относительно этой конвенции. Нормализуем знак на границе адаптера, а не в скоринге или
 * реплее: иначе MSFS-рейсы получают `-5.6°` вместо `+5.6°` и неверный критерий `attitude`.
 */
export function canonicalMsfsAttitude(
  pitchDeg: number,
  bankDeg: number,
): { pitch_deg: number; bank_deg: number } {
  return { pitch_deg: -pitchDeg, bank_deg: -bankDeg };
}

/**
 * Разбор одного кадра SimConnect с диагностикой layout (чистая функция).
 * Никогда не бросает на телеметрии: нечитаемые поля деградируют в `null`.
 */
export function parseSampleWithMeta(
  reader: SimVarReader,
  ts: string,
  definition: readonly SimVarDefinition[] = SIMVAR_DEFINITION,
): ParsedSample {
  const { reader: safe, layoutMismatch } = createResilientReader(reader, definition);

  const raw: Partial<Record<SimVarField, number>> = {};
  const text: Partial<Record<SimVarField, string>> = {};
  for (const def of definition) {
    if (def.type === 'float64') raw[def.field] = safe.readFloat64();
    else if (def.type === 'int32') raw[def.field] = safe.readInt32();
    else text[def.field] = safe.readString256();
  }

  const enginesRunning = ['engine_running', 'engine_2', 'engine_3', 'engine_4'].filter(
    (field) => (raw[field as SimVarField] ?? 0) !== 0,
  ).length;

  const windDir = finiteOrNull(raw.wind_dir_deg ?? Number.NaN);
  const precip = raw.precip;

  // WAVE 4 (FOQA): per-engine/gear-массивы собираются из плоских SimVar-полей.
  // Пока FOQA-переменные убраны из data definition, поля приходят `undefined` → `null`.
  const perEngine = (fields: readonly SimVarField[]): Array<number | null> =>
    fields.map((field) => finiteOrNull(raw[field] ?? Number.NaN));
  const gearPositions = [raw.gear_position_0, raw.gear_position_1, raw.gear_position_2].map(
    (value) => nonNegativeOrNull(value ?? Number.NaN),
  );

  // Inert-engine guards: ambient-as-ITT / ~0-flow не должны утечь в анализ/AI.
  const defByField = new Map<SimVarField, SimVarDefinition>();
  for (const def of definition) defByField.set(def.field, def);

  const inertEngineReadings: InertEngineReading[] = [];
  const recordInert = (
    field: SimVarField,
    index: number,
    reason: InertEngineReadingReason,
    value: number,
    n1Percent: number | null,
    ambientC: number | null,
  ): void => {
    const def = defByField.get(field);
    inertEngineReadings.push({
      field,
      simVar: def?.name ?? field,
      unit: def?.unit ?? null,
      index,
      reason,
      value,
      n1_percent: n1Percent,
      ambient_c: ambientC,
    });
  };

  const n1 = perEngine(['n1_1', 'n1_2', 'n1_3', 'n1_4']);
  const ambientC = finiteOrNull(raw.temp_c ?? Number.NaN);

  const egtC = (['egt_1', 'egt_2', 'egt_3', 'egt_4'] as const).map((field, index) => {
    const value = finiteOrNull(raw[field] ?? Number.NaN);
    const n1Value = n1[index] ?? null;
    const result = sanitizeEngineTemperature(value, n1Value, ambientC);
    if (result.reason !== null && value !== null) {
      recordInert(field, index, result.reason, value, n1Value, ambientC);
    }
    return result.value;
  });

  const fuelFlow = (
    ['fuel_flow_pph_1', 'fuel_flow_pph_2', 'fuel_flow_pph_3', 'fuel_flow_pph_4'] as const
  ).map((field, index) => {
    const value = finiteOrNull(raw[field] ?? Number.NaN);
    const result = sanitizeFuelFlow(value);
    if (result.reason !== null && value !== null) {
      recordInert(field, index, result.reason, value, n1[index] ?? null, ambientC);
    }
    return result.value;
  });

  // ENGINE-MODE: РУД и реверс (verified live on MSFS 2024, 2026-10-20; без
  // сигналов приходят `undefined` → null, режим выводится из доступных полей).
  const throttle = perEngine(['throttle_1', 'throttle_2', 'throttle_3', 'throttle_4']);
  const reversePercent = perEngine(['reverse_1', 'reverse_2', 'reverse_3', 'reverse_4']);
  const reverseFlag = boolOrNull(raw.reverse_engaged);
  const reverseFromPercent = reversePercent.some((value) => value !== null && value > 5);
  const reverseEngaged =
    reverseFlag === true
      ? true
      : reverseFlag === false
        ? false
        : reversePercent.every((value) => value === null)
          ? null
          : reverseFromPercent;

  const attitude = canonicalMsfsAttitude(raw.pitch_deg ?? 0, raw.bank_deg ?? 0);

  const sample: TelemetrySample = {
    ts,
    lat: raw.lat ?? Number.NaN,
    lon: raw.lon ?? Number.NaN,
    alt_ft: raw.alt_ft ?? Number.NaN,
    agl_ft: finiteOrNull(raw.agl_ft ?? Number.NaN),
    gs_kt: Math.max(0, raw.gs_kt ?? 0),
    ias_kt: finiteOrNull(raw.ias_kt ?? Number.NaN),
    vs_fpm: finiteOrNull(raw.vs_fpm ?? Number.NaN),
    heading_deg: raw.heading_deg ?? 0,
    pitch_deg: attitude.pitch_deg,
    bank_deg: attitude.bank_deg,
    g: Math.max(0, raw.g ?? 0),
    on_ground: (raw.on_ground ?? 0) !== 0,
    gear_down: raw.gear_down === undefined ? null : raw.gear_down !== 0,
    fuel_qty_gal: finiteOrNull(raw.fuel_qty_gal ?? Number.NaN),
    total_weight_lb: nonNegativeOrNull(raw.total_weight_lb ?? Number.NaN),
    engine_running: enginesRunning > 0,
    engines_running: enginesRunning,
    atc_model: cleanString(text.atc_model),
    atc_type: cleanString(text.atc_type),
    title: cleanString(text.title),
    wind_dir_deg: windDir === null ? null : normalizeDirection(windDir),
    wind_speed_kt: nonNegativeOrNull(raw.wind_speed_kt ?? Number.NaN),
    wind_gust_kt: null,
    temp_c: finiteOrNull(raw.temp_c ?? Number.NaN),
    qnh_hpa: finiteOrNull(raw.qnh_hpa ?? Number.NaN),
    precip: typeof precip === 'number' && Number.isInteger(precip) && precip >= 0 ? precip : null,
    visibility_m: nonNegativeOrNull(raw.visibility_m ?? Number.NaN),
    in_cloud: raw.in_cloud === undefined ? null : raw.in_cloud !== 0,
    // WAVE 4 (FOQA): конфигурация/двигатели/управление/автоматика/AoA/ILS/
    // поверхность/точка касания. Недоступный SimVar → `null`, не 0.
    flaps_index: nonNegativeOrNull(raw.flaps_index ?? Number.NaN),
    flaps_percent: nonNegativeOrNull(raw.flaps_percent ?? Number.NaN),
    spoilers_percent: nonNegativeOrNull(raw.spoilers_percent ?? Number.NaN),
    spoilers_armed: boolOrNull(raw.spoilers_armed),
    gear_position: gearPositions,
    n1_percent: n1,
    egt_c: egtC,
    fuel_flow_pph: fuelFlow,
    throttle_percent: throttle,
    reverse_percent: reversePercent,
    reverse_engaged: reverseEngaged,
    engine_mode: deriveEngineMode({
      engineRunning: enginesRunning > 0,
      onGround: (raw.on_ground ?? 0) !== 0,
      n1Percent: n1,
      throttlePercent: throttle,
      reverseEngaged,
    }),
    elevator_position: finiteOrNull(raw.elevator_position ?? Number.NaN),
    aileron_position: finiteOrNull(raw.aileron_position ?? Number.NaN),
    rudder_position: finiteOrNull(raw.rudder_position ?? Number.NaN),
    brake_left_position: nonNegativeOrNull(raw.brake_left_position ?? Number.NaN),
    brake_right_position: nonNegativeOrNull(raw.brake_right_position ?? Number.NaN),
    autopilot_master: boolOrNull(raw.autopilot_master),
    autothrottle_active: boolOrNull(raw.autothrottle_active),
    autopilot_approach_hold: boolOrNull(raw.autopilot_approach_hold),
    autopilot_glideslope_hold: boolOrNull(raw.autopilot_glideslope_hold),
    incidence_alpha_rad: finiteOrNull(raw.incidence_alpha_rad ?? Number.NaN),
    incidence_beta_rad: finiteOrNull(raw.incidence_beta_rad ?? Number.NaN),
    hsi_cdi_needle: finiteOrNull(raw.hsi_cdi_needle ?? Number.NaN),
    hsi_cdi_needle_valid: boolOrNull(raw.hsi_cdi_needle_valid),
    hsi_gsi_needle: finiteOrNull(raw.hsi_gsi_needle ?? Number.NaN),
    hsi_gsi_needle_valid: boolOrNull(raw.hsi_gsi_needle_valid),
    hsi_has_localizer: boolOrNull(raw.hsi_has_localizer),
    nav_glide_slope_error_deg: finiteOrNull(raw.nav_glide_slope_error_deg ?? Number.NaN),
    nav_radial_error_deg: finiteOrNull(raw.nav_radial_error_deg ?? Number.NaN),
    surface_condition: enumOrNull(raw.surface_condition, 3),
    surface_type: enumOrNull(raw.surface_type, 255),
    on_any_runway: boolOrNull(raw.on_any_runway),
    radio_height_ft: nonNegativeOrNull(raw.radio_height_ft ?? Number.NaN),
    cg_percent: nonNegativeOrNull(raw.cg_percent ?? Number.NaN),
    atc_runway_relative_x_m: finiteOrNull(raw.atc_runway_relative_x_m ?? Number.NaN),
    atc_runway_relative_z_m: finiteOrNull(raw.atc_runway_relative_z_m ?? Number.NaN),
    atc_runway_tdpoint_relative_x_m: finiteOrNull(
      raw.atc_runway_tdpoint_relative_x_m ?? Number.NaN,
    ),
    atc_runway_tdpoint_relative_z_m: finiteOrNull(
      raw.atc_runway_tdpoint_relative_z_m ?? Number.NaN,
    ),
    atc_runway_start_distance_m: finiteOrNull(raw.atc_runway_start_distance_m ?? Number.NaN),
    atc_runway_end_distance_m: finiteOrNull(raw.atc_runway_end_distance_m ?? Number.NaN),
    atc_runway_heading_deg: finiteOrNull(raw.atc_runway_heading_deg ?? Number.NaN),
    atc_runway_length_m: nonNegativeOrNull(raw.atc_runway_length_m ?? Number.NaN),
    atc_runway_width_m: nonNegativeOrNull(raw.atc_runway_width_m ?? Number.NaN),
    slew: (raw.slew ?? 0) !== 0,
  };

  return { sample, layoutMismatch: layoutMismatch(), inertEngineReadings };
}

/** Разбор одного кадра SimConnect в нормализованный сэмпл (чистая функция, тестируема). */
export function parseSample(
  reader: SimVarReader,
  ts: string,
  definition: readonly SimVarDefinition[] = SIMVAR_DEFINITION,
): TelemetrySample {
  return parseSampleWithMeta(reader, ts, definition).sample;
}

/**
 * Реальная реализация поверх `node-simconnect` (чистый TS-клиент протокола SimConnect).
 * Поддерживает MSFS 2024 (protocol `SunRise`), только read-only запросы SimVars.
 * `node-simconnect` грузится лениво, чтобы импорт модуля не тянул нативный реестр
 * на неподдерживаемых платформах и не ломал unit-тесты.
 *
 * Реализует порт `SimSource` (ADR-0023): это MSFS-источник v1. Поведение
 * (SimVar layout, диагностика, FOQA-группы (default `all` verified), лог-строки) не меняется.
 */
export class NodeSimConnectAdapter extends TypedEmitter<SimSourceEvents> implements SimSource {
  readonly id: SimSourceId = 'msfs2024';
  readonly readOnly = true;

  private handle: SimConnectConnection | null = null;
  private isConnected = false;
  private lastEmitMs = 0;
  private layoutMismatchLogged = false;
  private definitionDiagnosticsLogged = false;
  /** `sendId → поле` текущей регистрации (для связи исключений с SimVar). */
  private sendIdMap = new Map<number, SimVarSendIdEntry>();
  /** Уже сообщённые sendId отвергнутых SimVars (один лог на поле за сессию). */
  private readonly reportedRejections = new Set<number>();
  /** Уже сообщённые инертные поля двигателей (один лог на поле за сессию). */
  private readonly reportedInertEngineFields = new Set<SimVarField>();
  /** Отвергнутые симом поля текущей сессии (для отчёта о расхождении layout). */
  private readonly rejectedSimVars: RejectedSimVar[] = [];
  private readonly maxSampleHz: number;
  private readonly definition: readonly SimVarDefinition[];
  private readonly foqaGroups: readonly FoqaSimVarGroup[];
  private readonly unknownFoqaGroups: readonly string[];
  private readonly logger: SimConnectAdapterLogger | undefined;

  constructor(private readonly options: NodeSimConnectAdapterOptions = {}) {
    super();
    this.maxSampleHz = options.maxSampleHz ?? DEFAULT_MAX_SAMPLE_HZ;
    this.definition = options.definition ?? SIMVAR_DEFINITION;
    this.foqaGroups = options.foqaGroups ?? ENABLED_FOQA_GROUPS;
    this.unknownFoqaGroups = options.unknownFoqaGroups ?? UNKNOWN_FOQA_GROUPS;
    this.logger = options.logger;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get capabilities(): SimSourceCapabilities {
    return {
      sim: this.id,
      maxSampleHz: this.maxSampleHz,
      // MSFS не даёт прямого датчика паузы — пауза детектится gap-based (ADR-0008 §1).
      pauseDetection: 'gap',
      adapter: `simconnect-${this.options.protocol ?? DEFAULT_PROTOCOL}`,
    };
  }

  async connect(): Promise<SimSourceOpenInfo> {
    const mod = await import('node-simconnect');
    const protocol = this.resolveProtocol(mod.Protocol);
    const connectionOptions = this.options.remote ? { remote: this.options.remote } : undefined;
    const { recvOpen, handle } = await mod.open(
      this.options.clientName ?? DEFAULT_CLIENT_NAME,
      protocol,
      connectionOptions,
    );

    this.handle = handle;
    this.isConnected = true;

    const sendIds: number[] = [];
    for (const def of this.definition) {
      sendIds.push(
        handle.addToDataDefinition(
          DATA_DEFINITION_ID,
          def.name,
          def.unit,
          toSimConnectDataType(mod.SimConnectDataType, def.type),
        ),
      );
    }
    // `sendId → поле`: связываем последующие NAME_UNRECOGNIZED-исключения с SimVar.
    this.sendIdMap = buildSimVarSendIdMap(this.definition, sendIds);
    // One-time: какие FOQA-группы включены и сколько байт ожидаем в буфере.
    this.reportDefinitionDiagnostics();

    handle.on('simObjectData', (recv) => {
      if (recv.requestID !== DATA_REQUEST_ID) return;
      const now = Date.now();
      if (this.maxSampleHz > 0 && now - this.lastEmitMs < 1000 / this.maxSampleHz) return;
      this.lastEmitMs = now;
      try {
        const { sample, layoutMismatch, inertEngineReadings } = parseSampleWithMeta(
          recv.data,
          new Date(now).toISOString(),
          this.definition,
        );
        // Self-check layout на первом сэмпле: несовпадение логируется один раз.
        if (layoutMismatch) this.reportLayoutMismatch(layoutMismatch);
        this.reportInertEngineReadings(inertEngineReadings);
        this.emit('sample', sample);
      } catch (error) {
        this.emit('error', toError(error));
      }
    });

    handle.on('error', (error) => this.emit('error', error));
    handle.on('exception', (exception) => this.reportException(exception));
    handle.on('quit', () => this.markDisconnected('simulator quit'));
    handle.on('close', () => this.markDisconnected('connection closed'));

    handle.requestDataOnSimObject(
      DATA_REQUEST_ID,
      DATA_DEFINITION_ID,
      mod.SimConnectConstants.OBJECT_ID_USER,
      mod.SimConnectPeriod.SIM_FRAME,
    );

    const applicationVersion = `${recvOpen.applicationVersionMajor}.${recvOpen.applicationVersionMinor}`;
    const protocolName = this.options.protocol ?? DEFAULT_PROTOCOL;
    const info: SimSourceOpenInfo = {
      applicationName: recvOpen.applicationName,
      applicationVersion,
      simConnectVersion: `${recvOpen.simConnectVersionMajor}.${recvOpen.simConnectVersionMinor}`,
      sim: this.id,
      simVersion: applicationVersion,
      adapter: `simconnect-${protocolName}`,
      protocol: protocolName,
    };
    this.emit('open', info);
    return info;
  }

  /** One-time диагностика канонического набора SimVars (та же, что логируется при connect). */
  diagnostics(): SimSourceDiagnostics {
    return describeSimVarDefinition(this.definition, this.foqaGroups, this.unknownFoqaGroups);
  }

  async disconnect(): Promise<void> {
    if (this.handle) {
      this.handle.close();
      this.handle = null;
    }
    this.markDisconnected('client requested disconnect');
  }

  private markDisconnected(reason: string): void {
    if (!this.isConnected) return;
    this.isConnected = false;
    this.emit('disconnect', reason);
  }

  /** Один раз сообщает о включённых FOQA-группах и ожидаемом размере payload. */
  private reportDefinitionDiagnostics(): void {
    if (this.definitionDiagnosticsLogged) return;
    this.definitionDiagnosticsLogged = true;
    const diagnostics = describeSimVarDefinition(
      this.definition,
      this.foqaGroups,
      this.unknownFoqaGroups,
    );
    this.logger?.info(diagnostics.message, diagnostics.meta);
    if (this.unknownFoqaGroups.length > 0) {
      this.logger?.warn(
        `${FOQA_SIMVARS_ENV}: unknown FOQA group(s) ignored: ` +
          `${this.unknownFoqaGroups.join(', ')} (known: ${FOQA_GROUP_ORDER.join(', ')})`,
        { unknown_groups: [...this.unknownFoqaGroups] },
      );
    }
  }

  /**
   * Связывает исключение SimConnect с полем по `sendId`. Для
   * `NAME_UNRECOGNIZED` сообщает точное имя SimVar (один раз на поле за сессию)
   * и копит список отвергнутых полей для отчёта о расхождении layout; прочие
   * исключения — как раньше, общим сообщением.
   */
  private reportException(exception: SimConnectExceptionLike): void {
    const rejected = selectRejectedSimVar(this.sendIdMap, exception);
    if (!rejected) {
      this.emit('error', new Error(`SimConnect exception: ${JSON.stringify(exception)}`));
      return;
    }
    if (this.reportedRejections.has(rejected.sendId)) return;
    this.reportedRejections.add(rejected.sendId);
    this.rejectedSimVars.push(rejected);
    this.emit('error', new Error(describeRejectedSimVar(rejected)));
  }

  /**
   * One-time диагностика инертных показаний двигателей: `TURB ENG ITT` может
   * отдавать ambient, а `TURB ENG FUEL FLOW PPH` — ~0 при работающей турбине.
   * Такие значения уже деградированы в `null` (`sanitizeEngine*`); здесь называем
   * поле/SimVar/причину, чтобы аналитика и AI не принимали мусор за данные.
   * Один лог на поле за сессию.
   */
  private reportInertEngineReadings(readings: readonly InertEngineReading[]): void {
    for (const reading of readings) {
      if (this.reportedInertEngineFields.has(reading.field)) continue;
      this.reportedInertEngineFields.add(reading.field);
      this.logger?.warn(describeInertEngineReading(reading), {
        field: reading.field,
        simvar: reading.simVar,
        index: reading.index,
        reason: reading.reason,
        value: reading.value,
        n1_percent: reading.n1_percent,
        ambient_c: reading.ambient_c,
      });
    }
  }

  /** Список отвергнутых полей (имя + поле) для отчёта о расхождении layout. */
  private rejectedSimVarsNote(): string {
    if (this.rejectedSimVars.length === 0) return '';
    const names = this.rejectedSimVars.map((item) => `'${item.simVar}' (${item.field})`).join(', ');
    return ` Rejected SimVar(s): ${names}.`;
  }

  /** Один раз сообщает о расхождении layout, чтобы не спамить на каждый кадр. */
  private reportLayoutMismatch(mismatch: SimVarLayoutMismatch): void {
    if (this.layoutMismatchLogged) return;
    this.layoutMismatchLogged = true;
    const direction = mismatch.truncated ? 'shorter' : 'longer';
    const groupSuffix = mismatch.group ? `, FOQA group '${mismatch.group}'` : '';
    const rejected = this.rejectedSimVarsNote();
    const where =
      mismatch.fieldIndex < this.definition.length
        ? `Secondary: fields from #${mismatch.fieldIndex} '${mismatch.simVar}' (${mismatch.field}${groupSuffix}) onward are unusable (first field that does not fit the received buffer).`
        : `Secondary: extra bytes follow the last field '${mismatch.simVar}'.`;
    this.emit(
      'error',
      new Error(
        `SimConnect data layout mismatch: buffer is ${direction} than expected ` +
          `(expected ${mismatch.expectedBytes} bytes, got ${mismatch.actualBytes}).${rejected} ` +
          `${where} `.trim() +
          ' Validate SIMVAR_DEFINITION against a live MSFS before release.',
      ),
    );
  }

  private resolveProtocol(protocols: {
    SunRise: Protocol;
    KittyHawk: Protocol;
    FSX_SP2: Protocol;
  }): Protocol {
    switch (this.options.protocol ?? DEFAULT_PROTOCOL) {
      case 'kittyhawk':
        return protocols.KittyHawk;
      case 'fsx_sp2':
        return protocols.FSX_SP2;
      case 'sunrise':
      default:
        return protocols.SunRise;
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toSimConnectDataType(
  types: {
    FLOAT64: SimConnectDataTypeValue;
    INT32: SimConnectDataTypeValue;
    STRING256: SimConnectDataTypeValue;
  },
  type: SimVarDefinition['type'],
): SimConnectDataTypeValue {
  if (type === 'float64') return types.FLOAT64;
  if (type === 'string256') return types.STRING256;
  return types.INT32;
}

type SimConnectDataTypeValue = Parameters<SimConnectConnection['addToDataDefinition']>[3];
