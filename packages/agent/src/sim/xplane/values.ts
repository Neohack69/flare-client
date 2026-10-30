/**
 * X-Plane 12 → канонический `TelemetrySample` (чистые функции).
 *
 * Правило честной деградации (`xplane-12-canonical-fields.md` §9): поле либо
 * заполнено, либо `null` — НИКОГДА не поддельный 0. Поля без эквивалента у XP
 * (`XPLANE_NO_EQUIVALENT_FIELDS`) всегда `null`. Обязательные числовые поля
 * контракта (не nullable) при отсутствии датарефа дают `NaN` — рекордер отсекает
 * такие кадры `checkSampleSanity`, а не фабрикует координату/высоту.
 *
 * Единицы/конверсии — кандидаты `VERIFY-LIVE-TOMORROW` (таблица в `datarefs.ts`).
 */
import { Buffer } from 'node:buffer';

import { deriveEngineMode } from '../engine-mode.js';
import type { TelemetrySample } from '../types.js';
import {
  XPLANE_DATAREFS,
  xplaneDatarefName,
  type XPlaneDatarefRole,
  type XPlaneDatarefSpec,
  type XPlaneSubscriptionTarget,
} from './datarefs.js';

export type XPlaneRawValue = number | readonly (number | null)[] | string | null;
export type XPlaneValueMap = ReadonlyMap<string, XPlaneRawValue>;

/** Метры → футы (canonical-fields §1). */
export const METERS_TO_FEET = 3.28084;
/** м/с → узлы (canonical-fields §3). */
export const MPS_TO_KNOTS = 1.943844;
/** кг → фунты: 1 / 0.45359237. */
export const LB_PER_KG = 1 / 0.45359237;
/** кг/с → фунт/час (canonical-fields §6). */
export const KG_PER_SEC_TO_PPH = 7936.64;
/** Паскали → гПа (canonical-fields §7; QNH: `sim/weather/region/sealevel_pressure_pas`). */
export const PASCALS_TO_HPA = 0.01;
/** Статутные мили → метры (canonical-fields §7; visibility). */
export const STATUTE_MILES_TO_METERS = 1609.344;
/** Градусы → радианы (canonical-fields §2). */
export const DEG_TO_RAD = Math.PI / 180;
/** Допуск «sim_speed == 1» (time-warp детект). */
export const TIME_WARP_TOLERANCE = 0.01;
/**
 * Минимальная физически осмысленная ITT (турбина) при работающем двигателе, °C.
 * Ниже порога значение на Laminar A320 равно ambient (ITT не смоделирован) —
 * отдаём `null`, а не поддельную температуру.
 */
export const MIN_PLAUSIBLE_RUNNING_ITT_C = 100;

/** Управляющие символы/замена — признак «это не была base64-строка». */
function hasNonPrintable(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const allowedWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    if ((code < 0x20 && !allowedWhitespace) || code === 0x7f || code === 0xfffd) return true;
  }
  return false;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Числовое значение dataref по роли (`null`, если датареф отсутствует/не число). */
export function readXPlaneNumber(map: XPlaneValueMap, role: XPlaneDatarefRole): number | null {
  return finite(asNumber(map.get(xplaneDatarefName(role))));
}

/** Числовой массив dataref по роли (элементы не-числа → `NaN`), либо `null`. */
export function readXPlaneNumbers(
  map: XPlaneValueMap,
  role: XPlaneDatarefRole,
): number[] | null {
  const raw = map.get(xplaneDatarefName(role));
  if (!Array.isArray(raw)) return null;
  return raw.map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN));
}

/** `Bool`-dataref: `0/1` → `false/true`; отсутствие → `null`. */
export function readXPlaneBool(map: XPlaneValueMap, role: XPlaneDatarefRole): boolean | null {
  const value = readXPlaneNumber(map, role);
  return value === null ? null : value !== 0;
}

function asNumber(value: XPlaneRawValue | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

/** Нормализация направления в `[0, 360)`. */
export function normalizeDirection(value: number): number {
  const wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Декодирует `data`-dataref (byte[] / string) в строку до NUL-терминатора.
 *
 * Web API (и REST, и WS — подтверждено на 12.4.3) отдаёт `data`/`byte` dataref
 * как **base64** (`"QTIwTg=="` → `A20N`). Функция сначала пробует base64 и
 * откатывается к «сырой» строке, если вход base64-строкой не является
 * (например, plain `A320`, `B738\0trailing`) — так сохраняется толерантность.
 * RREF строк не поддерживает.
 */
export function decodeXPlaneString(value: XPlaneRawValue | undefined): string | null {
  if (typeof value === 'string') {
    const base64 = decodeBase64Text(value);
    return base64 !== null ? base64 : stripAtNul(value);
  }
  if (Array.isArray(value)) {
    const bytes: number[] = [];
    for (const item of value) {
      if (typeof item !== 'number' || !Number.isFinite(item) || item === 0) break;
      bytes.push(item & 0xff);
    }
    if (bytes.length === 0) return null;
    return decodeUtf8(Uint8Array.from(bytes));
  }
  return null;
}

function stripAtNul(text: string): string | null {
  const trimmed = text.replace(/\0[\s\S]*$/, '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Байты (до NUL) → UTF-8-строка; `null`, если вышли непечатаемые символы. */
function decodeUtf8(input: Uint8Array): string | null {
  const bytes = Buffer.from(input);
  const nul = bytes.indexOf(0);
  const slice = nul >= 0 ? bytes.subarray(0, nul) : bytes;
  const decoded = slice.toString('utf8');
  if (hasNonPrintable(decoded)) return null;
  const trimmed = decoded.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Пробует декодировать base64 (с/без padding); `null`, если это не base64/мусор. */
function decodeBase64Text(text: string): string | null {
  const normalized = text.replace(/\s+/g, '');
  if (normalized.length < 4 || normalized.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    return decodeUtf8(Buffer.from(padded, 'base64'));
  } catch {
    return null;
  }
}

/**
 * `sim_speed` **> 1** → time-warp (value-бит `slew`, ADR-0023 §2.3/R5).
 *
 * Авторитетен только **командный** `sim_speed`: при перемотке пользователя он
 * равен 2/4/8. `sim_speed_actual` — производная от времени кадра и «плавает»
 * вокруг 1.0 на любом FPS (шум железа, а не читерство), поэтому в решении не
 * участвует: live-рейс XP получал 79 ложных `SLEW` по всему полёту (такси 9 kt,
 * cruise 400 kt, на земле) без скачков позиции и с dt ≈ 1 с.
 *
 * Только **ускорение** считается time-warp. Замедление сима при нехватке кадров
 * — деградация железа, не читерство. Пауза (`sim_speed = 0`) детектится
 * отдельно (`sim/time/paused` → бит `PAUSED`, поток подавляется) и сюда не
 * относится.
 */
export function timeWarpActive(map: XPlaneValueMap): boolean {
  const speed = readXPlaneNumber(map, 'sim_speed');
  return speed !== null && speed > 1 + TIME_WARP_TOLERANCE;
}

/**
 * `sim/time/is_in_replay` → replay-режим. Кадры повтора рекордер отбрасывает
 * целиком, поэтому это отдельный флаг, а не `slew`.
 */
export function replayActive(map: XPlaneValueMap): boolean {
  return readXPlaneBool(map, 'is_in_replay') === true;
}

/**
 * Записывает значение целевого dataref в карту значений (ключ — базовое имя
 * dataref). Для поэлементных RREF-целей собирает массив из отдельных `dataref[i]`.
 */
export function setXPlaneValue(
  map: Map<string, XPlaneRawValue>,
  target: XPlaneSubscriptionTarget,
  value: XPlaneRawValue,
): void {
  const spec: XPlaneDatarefSpec = XPLANE_DATAREFS[target.role];
  if (target.element === null) {
    map.set(spec.dataref, value);
    return;
  }
  const length = spec.arrayLength ?? target.element + 1;
  const existing = map.get(spec.dataref);
  const array: Array<number | null> =
    existing !== undefined && Array.isArray(existing)
      ? [...(existing as readonly (number | null)[])]
      : new Array<number | null>(length).fill(null);
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null;
  array[target.element] = numeric;
  map.set(spec.dataref, array);
}

function scaleArray(
  map: XPlaneValueMap,
  role: XPlaneDatarefRole,
  count: number,
  factor: number,
): Array<number | null> | null {
  const values = readXPlaneNumbers(map, role);
  if (values === null) return null;
  const out: Array<number | null> = [];
  for (let index = 0; index < count; index += 1) {
    const value = values[index];
    out.push(typeof value === 'number' && Number.isFinite(value) ? value * factor : null);
  }
  return out;
}

function scaled(
  map: XPlaneValueMap,
  role: XPlaneDatarefRole,
  factor: number,
): number | null {
  const value = readXPlaneNumber(map, role);
  return value === null ? null : value * factor;
}

function nonNegative(map: XPlaneValueMap, role: XPlaneDatarefRole): number | null {
  const value = readXPlaneNumber(map, role);
  return value === null ? null : Math.max(0, value);
}

/** `clamp(>=0, value × factor)` — для единиц, которые приходят «как есть». */
function nonNegativeScaled(
  map: XPlaneValueMap,
  role: XPlaneDatarefRole,
  factor: number,
): number | null {
  const value = readXPlaneNumber(map, role);
  return value === null ? null : Math.max(0, value * factor);
}

/**
 * ITT (°C), срез 4, с проверкой реалистичности: если двигатель горит, а ITT
 * физически слишком низкая (< `MIN_PLAUSIBLE_RUNNING_ITT_C`), значит сим не
 * моделирует ITT (Laminar A320) → честный `null`, а не поддельная температура.
 */
function ittCelsius(map: XPlaneValueMap): Array<number | null> | null {
  const itt = readXPlaneNumbers(map, 'ITT_deg_C');
  if (itt === null) return null;
  const burning = readXPlaneNumbers(map, 'engine_is_burning_fuel');
  const out: Array<number | null> = [];
  for (let index = 0; index < 4; index += 1) {
    const value = itt[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      out.push(null);
      continue;
    }
    const running =
      burning !== null && typeof burning[index] === 'number' && burning[index] !== 0;
    out.push(running && value < MIN_PLAUSIBLE_RUNNING_ITT_C ? null : value);
  }
  return out;
}

/**
 * Собирает нормализованный `TelemetrySample` из карты значений X-Plane.
 * Поля без XP-эквивалента выставляются в `null` (честная деградация).
 */
export function buildXPlaneSample(map: XPlaneValueMap, ts: string): TelemetrySample {
  const elevation = readXPlaneNumber(map, 'elevation');
  const agl = readXPlaneNumber(map, 'y_agl');
  const groundspeed = readXPlaneNumber(map, 'groundspeed');
  const heading = readXPlaneNumber(map, 'true_psi');
  const engines = readXPlaneNumbers(map, 'engine_is_burning_fuel');
  const enginesRunning =
    engines === null
      ? null
      : engines
          .slice(0, 4)
          .filter((value) => typeof value === 'number' && Number.isFinite(value) && value !== 0)
          .length;

  const flapRatio = readXPlaneNumber(map, 'flap_ratio');
  const flapDetents = readXPlaneNumber(map, 'flap_detents');
  const flapsIndex =
    flapRatio !== null && flapDetents !== null && flapDetents > 0
      ? Math.round(flapRatio * flapDetents)
      : null;
  const speedbrake = readXPlaneNumber(map, 'speedbrake_ratio');
  const weightKg = readXPlaneNumber(map, 'm_total');
  const rain = readXPlaneNumber(map, 'rain_percent');
  const qnhPa = readXPlaneNumber(map, 'sealevel_pressure_pas');
  const windDir = readXPlaneNumber(map, 'wind_direction_degt');
  // ENGINE-MODE: тяга РУД + реверс (beta_rev < −1 = reverse; deploy ratio > 5 %).
  const throttlePercent = scaleArray(map, 'throttle_ratio', 4, 100);
  const reversePercent = scaleArray(map, 'thrust_reverser_deploy_ratio', 4, 100);
  const betaRev = readXPlaneNumbers(map, 'throttle_beta_rev_ratio');
  const betaReverse =
    betaRev !== null &&
    betaRev
      .slice(0, 4)
      .some((value) => typeof value === 'number' && Number.isFinite(value) && value < -1 + 1e-3);
  const deployReverse =
    reversePercent !== null &&
    reversePercent.some((value) => typeof value === 'number' && Number.isFinite(value) && value > 5);
  const reverseEngaged =
    reversePercent === null && betaRev === null ? null : betaReverse || deployReverse;
  const engineRunning = enginesRunning !== null && enginesRunning > 0;

  return {
    ts,
    lat: readXPlaneNumber(map, 'latitude') ?? Number.NaN,
    lon: readXPlaneNumber(map, 'longitude') ?? Number.NaN,
    alt_ft: elevation === null ? Number.NaN : elevation * METERS_TO_FEET,
    agl_ft: agl === null ? null : agl * METERS_TO_FEET,
    gs_kt: groundspeed === null ? Number.NaN : Math.max(0, groundspeed * MPS_TO_KNOTS),
    ias_kt: readXPlaneNumber(map, 'indicated_airspeed'),
    vs_fpm: readXPlaneNumber(map, 'vh_ind_fpm'),
    heading_deg: heading === null ? Number.NaN : normalizeDirection(heading),
    pitch_deg: readXPlaneNumber(map, 'true_theta') ?? Number.NaN,
    bank_deg: readXPlaneNumber(map, 'true_phi') ?? Number.NaN,
    g: readXPlaneNumber(map, 'g_nrml') ?? Number.NaN,
    on_ground: readXPlaneBool(map, 'onground_any') ?? false,
    gear_down: readXPlaneBool(map, 'gear_handle_down'),
    // FUEL TOTAL QUANTITY у XP в кг → точной конверсии в галлоны нет: честный null.
    fuel_qty_gal: null,
    total_weight_lb: weightKg === null ? null : weightKg * LB_PER_KG,
    engine_running: enginesRunning !== null && enginesRunning > 0,
    engines_running: enginesRunning ?? undefined,
    atc_model: decodeXPlaneString(map.get(xplaneDatarefName('acf_ICAO'))),
    atc_type: null,
    title: decodeXPlaneString(map.get(xplaneDatarefName('acf_descrip'))),
    wind_dir_deg: windDir === null ? null : normalizeDirection(windDir),
    // `sim/weather/aircraft/wind_now_speed_msc`: имя честно `_msc`, единица m/s → узлы.
    wind_speed_kt: nonNegativeScaled(map, 'wind_speed_msc', MPS_TO_KNOTS),
    wind_gust_kt: null,
    temp_c: readXPlaneNumber(map, 'temperature_ambient_c'),
    // `sim/weather/region/sealevel_pressure_pas`: Паскали → гПа.
    qnh_hpa: qnhPa === null ? null : qnhPa * PASCALS_TO_HPA,
    precip: rain === null ? null : rain > 0 ? 4 : 2,
    // `sim/weather/region/visibility_reported_sm`: статутные мили → метры.
    visibility_m: nonNegativeScaled(map, 'visibility_reported_sm', STATUTE_MILES_TO_METERS),
    in_cloud: null,
    flaps_index: flapsIndex,
    flaps_percent: scaled(map, 'flap_ratio', 100),
    spoilers_percent: speedbrake === null ? null : Math.min(100, Math.max(0, speedbrake * 100)),
    spoilers_armed: speedbrake === null ? null : speedbrake < 0,
    gear_position: scaleArray(map, 'gear_deploy_ratio', 3, 100),
    n1_percent: scaleArray(map, 'N1_percent', 4, 1),
    egt_c: ittCelsius(map),
    fuel_flow_pph: scaleArray(map, 'fuel_flow_kg_sec', 4, KG_PER_SEC_TO_PPH),
    throttle_percent: throttlePercent,
    reverse_percent: reversePercent,
    reverse_engaged: reverseEngaged,
    engine_mode: deriveEngineMode({
      engineRunning,
      onGround: readXPlaneBool(map, 'onground_any') ?? false,
      n1Percent: scaleArray(map, 'N1_percent', 4, 1),
      throttlePercent,
      reverseEngaged,
    }),
    elevator_position: scaled(map, 'pitch_ratio', 100),
    aileron_position: scaled(map, 'roll_ratio', 100),
    rudder_position: scaled(map, 'heading_ratio', 100),
    brake_left_position: scaled(map, 'left_brake_ratio', 100),
    brake_right_position: scaled(map, 'right_brake_ratio', 100),
    autopilot_master: readXPlaneBool(map, 'autopilot_on'),
    autothrottle_active: readXPlaneBool(map, 'autothrottle_on'),
    autopilot_approach_hold: readXPlaneNumber(map, 'approach_status') === 2 ? true : null,
    autopilot_glideslope_hold: readXPlaneNumber(map, 'glideslope_status') === 2 ? true : null,
    incidence_alpha_rad: scaled(map, 'alpha', DEG_TO_RAD),
    incidence_beta_rad: scaled(map, 'beta', DEG_TO_RAD),
    hsi_cdi_needle: readXPlaneNumber(map, 'nav1_hdef_dots_pilot'),
    hsi_cdi_needle_valid: null,
    hsi_gsi_needle: readXPlaneNumber(map, 'nav1_vdef_dots_pilot'),
    hsi_gsi_needle_valid: null,
    hsi_has_localizer: null,
    nav_glide_slope_error_deg: null,
    nav_radial_error_deg: null,
    surface_condition: null,
    surface_type: null,
    on_any_runway: null,
    radio_height_ft: nonNegative(map, 'radio_altimeter_height_ft_pilot'),
    cg_percent: null,
    atc_runway_relative_x_m: null,
    atc_runway_relative_z_m: null,
    atc_runway_tdpoint_relative_x_m: null,
    atc_runway_tdpoint_relative_z_m: null,
    atc_runway_start_distance_m: null,
    atc_runway_end_distance_m: null,
    atc_runway_heading_deg: null,
    atc_runway_length_m: null,
    atc_runway_width_m: null,
    // `slew` — только time-warp; replay идёт отдельным флагом и кадры повтора
    // отбрасываются рекордером.
    slew: timeWarpActive(map),
    replay: replayActive(map),
  };
}
