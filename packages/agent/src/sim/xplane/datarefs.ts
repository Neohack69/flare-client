/**
 * X-Plane 12 — канонические dataref-кандидаты (ADR-0023, `xplane-12-canonical-fields.md`).
 *
 * ⚠️ ВНИМАНИЕ: это ЕДИНСТВЕННАЯ таблица dataref-имён модуля. Кандидаты
 * собраны из стороннего снимка `DataRefs.txt` эпохи **XP 10.41**; на **Stage 0**
 * (`xplane-12-probe-plan.md`, 2026-10-16) имена/типы/единицы/длины массивов
 * сверены с `X-Plane 12/Resources/plugins/DataRefs.txt` **живого сима 12.4.3**
 * (и подтверждены ответами `GET /api/v3/datarefs`). Подтверждённое — без метки
 * `VERIFY-LIVE`; что осталось неподтверждённым или требует замены — в `note`
 * соответствующей строки.
 *
 * Live-факты 12.4.3: движковые массивы — не `[8]`, а **`[16]`**;
 * `sim/weather/*` (ветер/темп/pressure/rain/visibility) в XP12 помечены
 * **`REPLACED`** (значения ещё отдаются, но это deprecated-скаляры) — **A-04**:
 * вместо них используются подтверждённые скалярные замены
 * `sim/weather/aircraft/*` (ветер/темп) и `sim/weather/region/*` (QNH/rain/visibility);
 * `sim/cockpit2/controls/flap_ratio` — **`REPLACED`**, замена
 * `sim/cockpit2/controls/flap_handle_request_ratio`; `data`-dataref'ы
 * (`acf_ICAO`/`acf_descrip`) Web API отдаёт **base64**; replay-признак —
 * `sim/time/is_in_replay` (подтверждён live).
 *
 * Числовые id dataref здесь не хранятся и не хардкодятся — id резолвятся по
 * имени на сессию (ADR-0023 §2.4).
 *
 * Read-only инвариант: имена берутся ТОЛЬКО из этой таблицы. Они никогда не
 * приходят из пользовательского ввода, NL-запроса, LLM или тела телеметрии;
 * интерполяции имён нет (кроме детерминированного `dataref[i]` для RREF-массивов,
 * где `i` — индекс из этой же таблицы).
 */

export type XPlaneValueType = 'float' | 'double' | 'int' | 'float_array' | 'int_array' | 'data';

export interface XPlaneDatarefSpec {
  /** Точное имя dataref X-Plane (кандидат; `VERIFY-LIVE-TOMORROW`). */
  readonly dataref: string;
  /** Ожидаемый `value_type` Web API (`float|double|int|float_array|int_array|data`). */
  readonly valueType: XPlaneValueType;
  /** Единица (Web API её НЕ отдаёт; сверять по `DataRefs.txt` сима). */
  readonly unit: string | null;
  /** Тег из `xplane-12-canonical-fields.md`: `R` — обязательный, `O`/`A` — опция, `S` — служебный. */
  readonly requirement: 'R' | 'O' | 'A' | 'S';
  /** Длина массива (для RREF — поэлементная подписка `dataref[i]`). */
  readonly arrayLength?: number;
  /** Заметка: альтернативный кандидат, знак/ось, честная деградация, VERIFY-метка. */
  readonly note?: string;
}

/**
 * Таблица dataref-кандидатов (единственное место правки имён).
 * Порядок ключей фиксирует порядок подписки (диагностика стабильна).
 */
export const XPLANE_DATAREFS = {
  // --- 1. Позиция / высота --------------------------------------------------
  latitude: {
    dataref: 'sim/flightmodel/position/latitude',
    valueType: 'double',
    unit: 'degrees',
    requirement: 'R',
    note: 'RREF теряет точность (float32, ~1 м) — предпочитать Web API',
  },
  longitude: {
    dataref: 'sim/flightmodel/position/longitude',
    valueType: 'double',
    unit: 'degrees',
    requirement: 'R',
    note: 'RREF теряет точность (float32, ~1 м) — предпочитать Web API',
  },
  elevation: {
    dataref: 'sim/flightmodel/position/elevation',
    valueType: 'double',
    unit: 'meters',
    requirement: 'R',
    note: 'MSL, метры → ft (×3.28084)',
  },
  y_agl: {
    dataref: 'sim/flightmodel/position/y_agl',
    valueType: 'float',
    unit: 'meters',
    requirement: 'R',
    note: 'метры → ft (×3.28084)',
  },

  // --- 2. Ориентация / курс -------------------------------------------------
  true_psi: {
    dataref: 'sim/flightmodel/position/true_psi',
    valueType: 'float',
    unit: 'degrees',
    requirement: 'R',
  },
  true_theta: {
    dataref: 'sim/flightmodel/position/true_theta',
    valueType: 'float',
    unit: 'degrees',
    requirement: 'R',
    note: 'знак подтверждён live (12.4.3): + = нос вверх (в наборе ≈ +10..+16°)',
  },
  true_phi: {
    dataref: 'sim/flightmodel/position/true_phi',
    valueType: 'float',
    unit: 'degrees',
    requirement: 'R',
    note: 'знак подтверждён live: + = крен вправо (согласие с ростом true_psi 1364/1375)',
  },
  alpha: {
    dataref: 'sim/flightmodel/position/alpha',
    valueType: 'float',
    unit: 'degrees',
    requirement: 'A',
    note: 'градусы → рад (×π/180)',
  },
  beta: {
    dataref: 'sim/flightmodel/position/beta',
    valueType: 'float',
    unit: 'degrees',
    requirement: 'A',
    note: 'градусы → рад (×π/180)',
  },

  // --- 3. Скорости / перегрузка / вес --------------------------------------
  groundspeed: {
    dataref: 'sim/flightmodel/position/groundspeed',
    valueType: 'float',
    unit: 'm/s',
    requirement: 'R',
    note: 'm/s → kt (×1.943844)',
  },
  indicated_airspeed: {
    dataref: 'sim/flightmodel/position/indicated_airspeed',
    valueType: 'float',
    unit: 'kias',
    requirement: 'R',
    note: 'альтернатива: sim/cockpit2/gauges/indicators/airspeed_kts_pilot',
  },
  vh_ind_fpm: {
    dataref: 'sim/flightmodel/position/vh_ind_fpm',
    valueType: 'float',
    unit: 'fpm',
    requirement: 'R',
    note: 'альтернатива: …/vvi_fpm_pilot',
  },
  g_nrml: {
    dataref: 'sim/flightmodel/forces/g_nrml',
    valueType: 'float',
    unit: 'g',
    requirement: 'R',
    note: 'знак подтверждён live: + ≈ 1.0 в горизонтальном полёте (0.88..1.14), «downward»',
  },
  m_total: {
    dataref: 'sim/flightmodel/weight/m_total',
    valueType: 'float',
    unit: 'kg',
    requirement: 'O',
    note: 'кг → lb (÷0.45359237)',
  },

  // --- 4. Земля / шасси / конфигурация -------------------------------------
  onground_any: {
    dataref: 'sim/flightmodel/failures/onground_any',
    valueType: 'int',
    unit: null,
    requirement: 'R',
    note: '0/1 → bool',
  },
  gear_handle_down: {
    dataref: 'sim/cockpit2/controls/gear_handle_down',
    valueType: 'int',
    unit: null,
    requirement: 'O',
    note: '1 = шасси выпущено',
  },
  gear_deploy_ratio: {
    dataref: 'sim/flightmodel2/gear/deploy_ratio',
    valueType: 'float_array',
    unit: 'ratio',
    requirement: 'A',
    arrayLength: 10,
    note: '0..1 → % (×100), срез 3',
  },
  flap_ratio: {
    dataref: 'sim/cockpit2/controls/flap_handle_request_ratio',
    valueType: 'float',
    unit: 'ratio',
    requirement: 'A',
    note: '0..1 → % (×100); ЗАМЕНА: старый sim/cockpit2/controls/flap_ratio помечен REPLACED в XP12.4.3',
  },
  flap_detents: {
    dataref: 'sim/aircraft/controls/acf_flap_detents',
    valueType: 'int',
    unit: 'count',
    requirement: 'S',
    note: 'только для flaps_index (round(ratio×detents)); значение per-aircraft (int, present в 12.4.3)',
  },
  speedbrake_ratio: {
    dataref: 'sim/cockpit2/controls/speedbrake_ratio',
    valueType: 'float',
    unit: 'ratio',
    requirement: 'A',
    note: '<0 — armed; clamp(×100, 0..100)',
  },
  pitch_ratio: {
    dataref: 'sim/flightmodel2/controls/pitch_ratio',
    valueType: 'float',
    unit: 'ratio',
    requirement: 'A',
    note: '−1..1 → % (×100)',
  },
  roll_ratio: {
    dataref: 'sim/flightmodel2/controls/roll_ratio',
    valueType: 'float',
    unit: 'ratio',
    requirement: 'A',
    note: '−1..1 → % (×100)',
  },
  heading_ratio: {
    dataref: 'sim/flightmodel2/controls/heading_ratio',
    valueType: 'float',
    unit: 'ratio',
    requirement: 'A',
    note: 'руль/heading: -1..1 full left..full right (подтверждено DataRefs.txt 12.4.3)',
  },
  left_brake_ratio: {
    dataref: 'sim/cockpit2/controls/left_brake_ratio',
    valueType: 'float',
    unit: 'ratio',
    requirement: 'A',
    note: '0..1 → % (×100)',
  },
  right_brake_ratio: {
    dataref: 'sim/cockpit2/controls/right_brake_ratio',
    valueType: 'float',
    unit: 'ratio',
    requirement: 'A',
    note: '0..1 → % (×100)',
  },

  // --- 5. Автоматика / ILS --------------------------------------------------
  autopilot_on: {
    dataref: 'sim/cockpit2/autopilot/autopilot_on',
    valueType: 'int',
    unit: null,
    requirement: 'A',
    note: 'реально включён; альтернатива servos_on',
  },
  autothrottle_on: {
    dataref: 'sim/cockpit2/autopilot/autothrottle_on',
    valueType: 'int',
    unit: null,
    requirement: 'A',
  },
  approach_status: {
    dataref: 'sim/cockpit2/autopilot/approach_status',
    valueType: 'int',
    unit: null,
    requirement: 'A',
    note: '2 = captured',
  },
  glideslope_status: {
    dataref: 'sim/cockpit2/autopilot/glideslope_status',
    valueType: 'int',
    unit: null,
    requirement: 'A',
    note: '2 = captured',
  },
  nav1_hdef_dots_pilot: {
    dataref: 'sim/cockpit2/radios/indicators/nav1_hdef_dots_pilot',
    valueType: 'float',
    unit: 'dots',
    requirement: 'A',
    note: 'единица — dots (отличается от MSFS)',
  },
  nav1_vdef_dots_pilot: {
    dataref: 'sim/cockpit2/radios/indicators/nav1_vdef_dots_pilot',
    valueType: 'float',
    unit: 'dots',
    requirement: 'A',
    note: 'единица — dots',
  },

  // --- 6. Двигатели ---------------------------------------------------------
  engine_is_burning_fuel: {
    dataref: 'sim/flightmodel2/engines/engine_is_burning_fuel',
    valueType: 'int_array',
    unit: null,
    requirement: 'R',
    arrayLength: 16,
    note: 'int[16] в 12.4.3 (было ошибочно [8]) → engines_running (срез 4)',
  },
  N1_percent: {
    dataref: 'sim/cockpit2/engine/indicators/N1_percent',
    valueType: 'float_array',
    unit: 'percent',
    requirement: 'A',
    arrayLength: 16,
    note: 'float[16] в 12.4.3 (было ошибочно [8]); срез 4',
  },
  ITT_deg_C: {
    dataref: 'sim/cockpit2/engine/indicators/ITT_deg_C',
    valueType: 'float_array',
    unit: 'celsius',
    requirement: 'A',
    arrayLength: 16,
    note: 'float[16] в 12.4.3 (было ошибочно [8]); срез 4. ⚠️ REPLACED + "units vary by plane". ' +
      'На Laminar A320 ITT не смоделирован: 12.4.3 с работающими двигателями отдаёт ~ambient ' +
      '(10.6 °C при OAT 12.5 °C) — альтернативы (cockpit2 ITT_deg_cel, flightmodel2 engines ITT_deg_cel) ' +
      'дают то же значение. values.ts отдаёт null, если двигатель горит, а ITT физически нереалистична',
  },
  fuel_flow_kg_sec: {
    dataref: 'sim/cockpit2/engine/indicators/fuel_flow_kg_sec',
    valueType: 'float_array',
    unit: 'kg/s',
    requirement: 'A',
    arrayLength: 16,
    note: 'float[16] в 12.4.3 (было ошибочно [8]); kg/s → pph (×7936.64), срез 4',
  },
  // ENGINE-MODE (live 12.4.3: имена/типы/значения read-only подтверждены через
  // `GET /api/v3/datarefs` + `/value`; idle throttle_ratio = 0.0819).
  throttle_ratio: {
    dataref: 'sim/cockpit2/engine/actuators/throttle_ratio',
    valueType: 'float_array',
    unit: 'ratio',
    requirement: 'A',
    arrayLength: 16,
    note: '0..1 (idle..max normal) → % (×100), срез 4; live 12.4.3 idle ≈ 8.2 %',
  },
  throttle_beta_rev_ratio: {
    dataref: 'sim/cockpit2/engine/actuators/throttle_beta_rev_ratio',
    valueType: 'float_array',
    unit: 'ratio',
    requirement: 'A',
    arrayLength: 16,
    note: '−2..−1 = reverse, −1..0 = beta, 0..1 = alpha; срез 4. Реверс: value < −1',
  },
  thrust_reverser_deploy_ratio: {
    dataref: 'sim/flightmodel2/engines/thrust_reverser_deploy_ratio',
    valueType: 'float_array',
    unit: 'ratio',
    requirement: 'A',
    arrayLength: 16,
    note: '0..1 — ход створок реверса; срез 4 → %. Реверс: > 0.05',
  },

  // --- Идентичность ВС / погода --------------------------------------------
  acf_ICAO: {
    dataref: 'sim/aircraft/view/acf_ICAO',
    valueType: 'data',
    unit: null,
    requirement: 'O',
    note: 'byte[40], ICAO напрямую; Web API отдаёт base64 (live 12.4.3: "QTIwTg==" → A20N); ' +
      'values.ts декодирует base64; RREF не поддерживает строки',
  },
  acf_descrip: {
    dataref: 'sim/aircraft/view/acf_descrip',
    valueType: 'data',
    unit: null,
    requirement: 'O',
    note: 'byte[260] в 12.4.3 (подтверждено); Web API отдаёт base64; values.ts декодирует base64; ' +
      'RREF не поддерживает строки',
  },
  wind_direction_degt: {
    dataref: 'sim/weather/aircraft/wind_now_direction_degt',
    valueType: 'float',
    unit: 'degrees',
    requirement: 'O',
    note: 'A-04: старый sim/weather/wind_direction_degt помечен REPLACED в DataRefs.txt 12.4.3. Замена — ' +
      'эффективный ветер в точке ВС; взят скаляр sim/weather/aircraft/wind_now_direction_degt (та же семантика ' +
      '"at the plane’s location"), а не массив region/wind_direction_degt[13] — без неоднозначного выбора слоя',
  },
  wind_speed_msc: {
    dataref: 'sim/weather/aircraft/wind_now_speed_msc',
    valueType: 'float',
    unit: 'm/s',
    requirement: 'O',
    note: 'A-04: старый sim/weather/wind_speed_kt — REPLACED (12.4.3); ЕДИНИЦА = m/s (имя `_kt` содержит баг — так помечено ' +
      'в DataRefs.txt). Замена sim/weather/aircraft/wind_now_speed_msc: скаляр, честно назван `_msc`, единица m/s; ' +
      'values.ts конвертирует m/s → kt (×1.943844)',
  },
  temperature_ambient_c: {
    dataref: 'sim/weather/aircraft/temperature_ambient_deg_c',
    valueType: 'float',
    unit: 'celsius',
    requirement: 'O',
    note: 'A-04: старый sim/weather/temperature_ambient_c — REPLACED (12.4.3). Замена — скаляр ' +
      'sim/weather/aircraft/temperature_ambient_deg_c (°C, без конверсии)',
  },
  sealevel_pressure_pas: {
    dataref: 'sim/weather/region/sealevel_pressure_pas',
    valueType: 'float',
    unit: 'pascals',
    requirement: 'O',
    note: 'A-04: старый sim/weather/barometer_sealevel_inhg — REPLACED (12.4.3). Замена — скаляр ' +
      'sim/weather/region/sealevel_pressure_pas (Па); values.ts конвертирует Па → hPa (×0.01)',
  },
  rain_percent: {
    dataref: 'sim/weather/region/rain_percent',
    valueType: 'float',
    unit: 'ratio',
    requirement: 'O',
    note: 'A-04: старый sim/weather/rain_percent — REPLACED (12.4.3); замена — скаляр sim/weather/region/rain_percent ' +
      '(ratio 0..1). 0..1 → enum (rain>0 → 4, else 2); snow — VERIFY-LIVE',
  },
  visibility_reported_sm: {
    dataref: 'sim/weather/region/visibility_reported_sm',
    valueType: 'float',
    unit: 'statute_miles',
    requirement: 'O',
    note: 'A-04: старый sim/weather/visibility_reported_m — REPLACED (12.4.3). Замена — скаляр ' +
      'sim/weather/region/visibility_reported_sm (статутные мили); values.ts конвертирует SM → m (×1609.344)',
  },

  // --- Радиовысота / служебные сигналы (пауза, time-warp) ------------------
  radio_altimeter_height_ft_pilot: {
    dataref: 'sim/cockpit2/gauges/indicators/radio_altimeter_height_ft_pilot',
    valueType: 'float',
    unit: 'feet',
    requirement: 'A',
  },
  paused: {
    dataref: 'sim/time/paused',
    valueType: 'int',
    unit: null,
    requirement: 'S',
    note: 'прямой датчик паузы (XP точнее MSFS)',
  },
  sim_speed: {
    dataref: 'sim/time/sim_speed',
    valueType: 'int',
    unit: null,
    requirement: 'S',
    note: '>1 (2/4/8) → ускорение → value-бит slew; 0 (пауза) — не warp; только чтение',
  },
  sim_speed_actual: {
    dataref: 'sim/time/sim_speed_actual',
    valueType: 'float',
    unit: 'ratio',
    requirement: 'S',
    note: 'фактический ratio (производная от времени кадра, шумит вокруг 1.0). ' +
      'В slew-детекте НЕ участвует — только диагностика; в 12.4.3 на паузе может отдавать null',
  },
  is_in_replay: {
    dataref: 'sim/time/is_in_replay',
    valueType: 'int',
    unit: null,
    requirement: 'S',
    note: 'подтверждено live 12.4.3: int 0/1, "true if we are in replay mode"; только чтение. ' +
      'Входит в slew (replay не должен давать leaderboard-eligible рейс)',
  },
} as const satisfies Record<string, XPlaneDatarefSpec>;

export type XPlaneDatarefRole = keyof typeof XPLANE_DATAREFS;

/** Все allow-list dataref'ы (детерминированный порядок = порядок ключей таблицы). */
export const XPLANE_ALLOWED_DATAREFS: readonly string[] = Object.values(XPLANE_DATAREFS).map(
  (spec) => spec.dataref,
);

const ALLOWED_DATAREF_SET = new Set<string>(XPLANE_ALLOWED_DATAREFS);

/** `true` только для имени из allow-list таблицы (никаких произвольных имён). */
export function isAllowedXPlaneDataref(name: string): boolean {
  return ALLOWED_DATAREF_SET.has(name);
}

/** Обязательные (`R`) dataref'ы — для acceptance/диагностики (13 шт.). */
export const XPLANE_REQUIRED_DATAREFS: readonly string[] = Object.values(XPLANE_DATAREFS)
  .filter((spec) => spec.requirement === 'R')
  .map((spec) => spec.dataref);

/**
 * Базовая позиционно-полётная «дюжина» из probe-плана
 * (`xplane-12-probe-plan.md` §2, AC-2) — обязательные `R` без движкового
 * `engine_is_burning_fuel` (он входит в расширенный список `R`).
 */
export const XPLANE_CORE_REQUIRED_DATAREFS: readonly string[] = XPLANE_REQUIRED_DATAREFS.filter(
  (name) => name !== XPLANE_DATAREFS.engine_is_burning_fuel.dataref,
);

/** Имя dataref по роли таблицы (единственный источник имён). */
export function xplaneDatarefName(role: XPlaneDatarefRole): string {
  return XPLANE_DATAREFS[role].dataref;
}

/** Спека dataref по роли (аннотирована базовым типом, чтобы читать опц. `arrayLength`). */
export function xplaneDatarefSpec(role: XPlaneDatarefRole): XPlaneDatarefSpec {
  return XPLANE_DATAREFS[role];
}

/**
 * Канонические поля `TelemetrySample`, для которых у X-Plane НЕТ эквивалента
 * (честный `null`, никогда не поддельный 0; см. `xplane-12-canonical-fields.md` §9).
 */
export const XPLANE_NO_EQUIVALENT_FIELDS: readonly string[] = [
  'fuel_qty_gal',
  'atc_type',
  'wind_gust_kt',
  'in_cloud',
  'surface_type',
  'surface_condition',
  'on_any_runway',
  'cg_percent',
  'hsi_cdi_needle_valid',
  'hsi_gsi_needle_valid',
  'hsi_has_localizer',
  'nav_glide_slope_error_deg',
  'nav_radial_error_deg',
  'atc_runway_relative_x_m',
  'atc_runway_relative_z_m',
  'atc_runway_tdpoint_relative_x_m',
  'atc_runway_tdpoint_relative_z_m',
  'atc_runway_start_distance_m',
  'atc_runway_end_distance_m',
  'atc_runway_heading_deg',
  'atc_runway_length_m',
  'atc_runway_width_m',
];

/** Один элемент подписки: dataref + роль таблицы + (для RREF) индекс массива. */
export interface XPlaneSubscriptionTarget {
  readonly role: XPlaneDatarefRole;
  readonly dataref: string;
  /** `null` — скаляр/массив целиком; число — поэлементная RREF-подписка `dataref[i]`. */
  readonly element: number | null;
}

/** Подписка Web API: по одному целевому dataref на роль (массивы — целиком). */
export function planWebApiSubscriptions(): XPlaneSubscriptionTarget[] {
  return (Object.keys(XPLANE_DATAREFS) as XPlaneDatarefRole[]).map((role) => {
    const spec: XPlaneDatarefSpec = XPLANE_DATAREFS[role];
    return { role, dataref: spec.dataref, element: null };
  });
}

/**
 * Подписка RREF: массивы — поэлементно (`dataref[i]`, ADR-0023 §2.1a); строковые
 * `data`-dataref пропускаются (RREF отдаёт только float32 → строки бессмысленны).
 */
export function planRrefSubscriptions(): XPlaneSubscriptionTarget[] {
  const targets: XPlaneSubscriptionTarget[] = [];
  for (const role of Object.keys(XPLANE_DATAREFS) as XPlaneDatarefRole[]) {
    const spec: XPlaneDatarefSpec = XPLANE_DATAREFS[role];
    if (spec.valueType === 'data') continue;
    const isArray = spec.valueType === 'float_array' || spec.valueType === 'int_array';
    const length = spec.arrayLength;
    if (isArray && length !== undefined) {
      for (let index = 0; index < length; index += 1) {
        targets.push({ role, dataref: spec.dataref, element: index });
      }
    } else {
      targets.push({ role, dataref: spec.dataref, element: null });
    }
  }
  return targets;
}
