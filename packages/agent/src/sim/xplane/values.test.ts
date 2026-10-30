import { describe, expect, it } from 'vitest';

import { XPLANE_DATAREFS } from './datarefs.js';
import {
  DEG_TO_RAD,
  KG_PER_SEC_TO_PPH,
  LB_PER_KG,
  METERS_TO_FEET,
  MPS_TO_KNOTS,
  PASCALS_TO_HPA,
  STATUTE_MILES_TO_METERS,
  buildXPlaneSample,
  decodeXPlaneString,
  readXPlaneBool,
  readXPlaneNumber,
  replayActive,
  setXPlaneValue,
  timeWarpActive,
  type XPlaneRawValue,
} from './values.js';

const NAME = XPLANE_DATAREFS;

function map(entries: Record<string, XPlaneRawValue>): Map<string, XPlaneRawValue> {
  return new Map(Object.entries(entries));
}

describe('X-Plane value accessors', () => {
  it('readXPlaneNumber: конечное число, иначе null', () => {
    const values = map({ [NAME.latitude.dataref]: 47.5, [NAME.longitude.dataref]: Number.NaN });
    expect(readXPlaneNumber(values, 'latitude')).toBe(47.5);
    expect(readXPlaneNumber(values, 'longitude')).toBeNull();
    expect(readXPlaneNumber(values, 'elevation')).toBeNull();
  });

  it('readXPlaneBool: 1/0 → true/false; отсутствие → null', () => {
    expect(readXPlaneBool(map({ [NAME.onground_any.dataref]: 1 }), 'onground_any')).toBe(true);
    expect(readXPlaneBool(map({ [NAME.onground_any.dataref]: 0 }), 'onground_any')).toBe(false);
    expect(readXPlaneBool(map({}), 'onground_any')).toBeNull();
  });

  it('timeWarpActive: командный sim_speed 2/4/8 → time-warp', () => {
    expect(timeWarpActive(map({ [NAME.sim_speed.dataref]: 1 }))).toBe(false);
    expect(timeWarpActive(map({ [NAME.sim_speed.dataref]: 2 }))).toBe(true);
    expect(timeWarpActive(map({ [NAME.sim_speed.dataref]: 4 }))).toBe(true);
    expect(timeWarpActive(map({ [NAME.sim_speed.dataref]: 8 }))).toBe(true);
    // Пауза — НЕ time-warp (детектится `sim/time/paused`).
    expect(timeWarpActive(map({ [NAME.sim_speed.dataref]: 0 }))).toBe(false);
    expect(timeWarpActive(map({}))).toBe(false);
  });

  it('timeWarpActive: sim_speed_actual — шум кадра, а не time-warp', () => {
    // Регрессия: live-рейс XP получал десятки ложных SLEW от `actual` ≠ 1.
    expect(timeWarpActive(map({ [NAME.sim_speed_actual.dataref]: 1.5 }))).toBe(false);
    expect(timeWarpActive(map({ [NAME.sim_speed_actual.dataref]: 0.5 }))).toBe(false);
    expect(timeWarpActive(map({ [NAME.sim_speed_actual.dataref]: 1.0 }))).toBe(false);
    expect(
      timeWarpActive(
        map({ [NAME.sim_speed.dataref]: 1, [NAME.sim_speed_actual.dataref]: 1.5 }),
      ),
    ).toBe(false);
  });

  it('timeWarpActive: допуск вокруг 1.0 (1.005 — нет, 1.02 — да)', () => {
    expect(timeWarpActive(map({ [NAME.sim_speed.dataref]: 1.005 }))).toBe(false);
    expect(timeWarpActive(map({ [NAME.sim_speed.dataref]: 1.02 }))).toBe(true);
  });
});

describe('unit / sign conversions', () => {
  it('переводит единицы X-Plane в канонический вид', () => {
    const values = map({
      [NAME.latitude.dataref]: 50.1,
      [NAME.longitude.dataref]: 8.6,
      [NAME.elevation.dataref]: 1000,
      [NAME.y_agl.dataref]: 500,
      [NAME.groundspeed.dataref]: 100,
      [NAME.indicated_airspeed.dataref]: 250,
      [NAME.vh_ind_fpm.dataref]: -180,
      [NAME.true_psi.dataref]: 370,
      [NAME.true_theta.dataref]: 3.5,
      [NAME.true_phi.dataref]: -2.5,
      [NAME.g_nrml.dataref]: 1.2,
      [NAME.onground_any.dataref]: 0,
      [NAME.m_total.dataref]: 1000,
      [NAME.alpha.dataref]: 5,
      [NAME.beta.dataref]: -2,
      [NAME.fuel_flow_kg_sec.dataref]: [1, 0.5, 0, 0, 0, 0, 0, 0],
      [NAME.sealevel_pressure_pas.dataref]: 101_325,
      [NAME.wind_direction_degt.dataref]: 370,
      [NAME.wind_speed_msc.dataref]: 12,
      [NAME.temperature_ambient_c.dataref]: 15,
      [NAME.rain_percent.dataref]: 0.5,
      [NAME.visibility_reported_sm.dataref]: 5,
    });
    const sample = buildXPlaneSample(values, '2026-10-16T00:00:00.000Z');

    expect(sample.lat).toBe(50.1);
    expect(sample.lon).toBe(8.6);
    expect(sample.alt_ft).toBeCloseTo(1000 * METERS_TO_FEET, 6);
    expect(sample.agl_ft).toBeCloseTo(500 * METERS_TO_FEET, 6);
    expect(sample.gs_kt).toBeCloseTo(100 * MPS_TO_KNOTS, 6);
    expect(sample.ias_kt).toBe(250);
    expect(sample.vs_fpm).toBe(-180);
    expect(sample.heading_deg).toBe(10);
    expect(sample.pitch_deg).toBe(3.5);
    expect(sample.bank_deg).toBe(-2.5);
    expect(sample.g).toBe(1.2);
    expect(sample.on_ground).toBe(false);
    expect(sample.total_weight_lb).toBeCloseTo(1000 * LB_PER_KG, 6);
    expect(sample.incidence_alpha_rad).toBeCloseTo(5 * DEG_TO_RAD, 9);
    expect(sample.incidence_beta_rad).toBeCloseTo(-2 * DEG_TO_RAD, 9);
    expect(sample.fuel_flow_pph?.[0]).toBeCloseTo(1 * KG_PER_SEC_TO_PPH, 6);
    expect(sample.qnh_hpa).toBeCloseTo(101_325 * PASCALS_TO_HPA, 6);
    expect(sample.wind_dir_deg).toBe(10);
    // wind_now_speed_msc приходит в m/s (имя `_msc`, не kt) → конверсия в узлы.
    expect(sample.wind_speed_kt).toBeCloseTo(12 * MPS_TO_KNOTS, 6);
    expect(sample.temp_c).toBe(15);
    expect(sample.precip).toBe(4);
    expect(sample.visibility_m).toBeCloseTo(5 * STATUTE_MILES_TO_METERS, 6);
  });

  it('precip: rain>0 → 4 (дождь), rain=0 → 2 (нет осадков), отсутствие → null', () => {
    expect(buildXPlaneSample(map({ [NAME.rain_percent.dataref]: 0 }), 't').precip).toBe(2);
    expect(buildXPlaneSample(map({ [NAME.rain_percent.dataref]: 0.2 }), 't').precip).toBe(4);
    expect(buildXPlaneSample(map({}), 't').precip).toBeNull();
  });

  it('spoilers: минус — armed, percent clamp 0..100', () => {
    const armed = buildXPlaneSample(map({ [NAME.speedbrake_ratio.dataref]: -0.5 }), 't');
    expect(armed.spoilers_armed).toBe(true);
    expect(armed.spoilers_percent).toBe(0);
    const deployed = buildXPlaneSample(map({ [NAME.speedbrake_ratio.dataref]: 0.8 }), 't');
    expect(deployed.spoilers_armed).toBe(false);
    expect(deployed.spoilers_percent).toBeCloseTo(80, 6);
  });

  it('flaps_index: round(ratio × detents)', () => {
    const sample = buildXPlaneSample(
      map({ [NAME.flap_ratio.dataref]: 0.5, [NAME.flap_detents.dataref]: 4 }),
      't',
    );
    expect(sample.flaps_percent).toBe(50);
    expect(sample.flaps_index).toBe(2);
    expect(buildXPlaneSample(map({ [NAME.flap_ratio.dataref]: 0.5 }), 't').flaps_index).toBeNull();
  });

  it('двигатели: engines_running считает true в срезе 4, массивы срезаются до 4', () => {
    const values = map({
      [NAME.engine_is_burning_fuel.dataref]: [1, 1, 0, 0, 1, 1, 1, 1],
      [NAME.N1_percent.dataref]: [90, 91, 0, 0, 0, 0, 0, 0],
      [NAME.ITT_deg_C.dataref]: [600, 610, 0, 0, 0, 0, 0, 0],
    });
    const sample = buildXPlaneSample(values, 't');
    expect(sample.engines_running).toBe(2);
    expect(sample.engine_running).toBe(true);
    expect(sample.n1_percent).toEqual([90, 91, 0, 0]);
    expect(sample.egt_c).toEqual([600, 610, 0, 0]);
  });

  it('ENGINE-MODE: throttle_ratio → %, reverse по beta_rev/deploy_ratio, mode idle/reverse', () => {
    const idle = buildXPlaneSample(
      map({
        [NAME.engine_is_burning_fuel.dataref]: [1, 1, 0, 0],
        [NAME.N1_percent.dataref]: [30, 30, 0, 0],
        [NAME.throttle_ratio.dataref]: [0.0819, 0.0819, 0, 0],
        [NAME.throttle_beta_rev_ratio.dataref]: [0.0819, 0.0819, -0.001, -0.001],
        [NAME.thrust_reverser_deploy_ratio.dataref]: [0, 0, 0, 0],
        [NAME.onground_any.dataref]: 1,
      }),
      't',
    );
    expect(idle.throttle_percent?.[0]).toBeCloseTo(8.19, 6);
    expect(idle.throttle_percent?.[1]).toBeCloseTo(8.19, 6);
    expect(idle.reverse_engaged).toBe(false);
    expect(idle.engine_mode).toBe('idle');

    const reverse = buildXPlaneSample(
      map({
        [NAME.engine_is_burning_fuel.dataref]: [1, 1, 0, 0],
        [NAME.N1_percent.dataref]: [55, 55, 0, 0],
        [NAME.throttle_ratio.dataref]: [0, 0, 0, 0],
        [NAME.throttle_beta_rev_ratio.dataref]: [-1.5, -1.5, -0.001, -0.001],
        [NAME.thrust_reverser_deploy_ratio.dataref]: [1, 1, 0, 0],
        [NAME.onground_any.dataref]: 1,
      }),
      't',
    );
    expect(reverse.reverse_percent).toEqual([100, 100, 0, 0]);
    expect(reverse.reverse_engaged).toBe(true);
    expect(reverse.engine_mode).toBe('reverse');
  });

  it('gear_position: deploy_ratio 0..1 → % срез 3', () => {
    const sample = buildXPlaneSample(
      map({ [NAME.gear_deploy_ratio.dataref]: [1, 0.5, 0, 0.9] }),
      't',
    );
    expect(sample.gear_position).toEqual([100, 50, 0]);
  });

  it('данные с отсутствующим эквивалентом — честный null', () => {
    const sample = buildXPlaneSample(map({}), 't');
    expect(sample.fuel_qty_gal).toBeNull();
    expect(sample.atc_type).toBeNull();
    expect(sample.wind_gust_kt).toBeNull();
    expect(sample.in_cloud).toBeNull();
    expect(sample.surface_type).toBeNull();
    expect(sample.surface_condition).toBeNull();
    expect(sample.on_any_runway).toBeNull();
    expect(sample.cg_percent).toBeNull();
    expect(sample.hsi_cdi_needle_valid).toBeNull();
    expect(sample.hsi_gsi_needle_valid).toBeNull();
    expect(sample.hsi_has_localizer).toBeNull();
    expect(sample.nav_glide_slope_error_deg).toBeNull();
    expect(sample.nav_radial_error_deg).toBeNull();
    expect(sample.atc_runway_relative_x_m).toBeNull();
    expect(sample.atc_runway_length_m).toBeNull();
    // Non-nullable числовые поля без данных — NaN (рекордер отсекает sanity), не 0.
    expect(sample.lat).toBeNaN();
    expect(sample.lon).toBeNaN();
    expect(sample.alt_ft).toBeNaN();
    expect(sample.gs_kt).toBeNaN();
    expect(sample.heading_deg).toBeNaN();
    expect(sample.g).toBeNaN();
    expect(sample.agl_ft).toBeNull();
    expect(sample.ias_kt).toBeNull();
    expect(sample.vs_fpm).toBeNull();
    expect(sample.on_ground).toBe(false);
    expect(sample.slew).toBe(false);
    expect(sample.engine_running).toBe(false);
  });

  it('slew = time-warp (sim_speed ≠ 1)', () => {
    expect(buildXPlaneSample(map({ [NAME.sim_speed.dataref]: 2 }), 't').slew).toBe(true);
    expect(buildXPlaneSample(map({ [NAME.sim_speed.dataref]: 1 }), 't').slew).toBe(false);
    // `sim_speed_actual` (шум кадра) не поднимает slew.
    expect(buildXPlaneSample(map({ [NAME.sim_speed_actual.dataref]: 1.5 }), 't').slew).toBe(false);
  });

  it('replay: is_in_replay → replay=true, slew=false', () => {
    expect(replayActive(map({ [NAME.is_in_replay.dataref]: 1 }))).toBe(true);
    expect(replayActive(map({ [NAME.is_in_replay.dataref]: 0 }))).toBe(false);
    expect(replayActive(map({}))).toBe(false);
    const replay = buildXPlaneSample(map({ [NAME.is_in_replay.dataref]: 1 }), 't');
    expect(replay.replay).toBe(true);
    expect(replay.slew).toBe(false);
  });

  it('slew: time-warp не поднимает replay', () => {
    const warp = buildXPlaneSample(map({ [NAME.sim_speed.dataref]: 2 }), 't');
    expect(warp.slew).toBe(true);
    expect(warp.replay).toBe(false);
    expect(
      buildXPlaneSample(
        map({ [NAME.sim_speed.dataref]: 1, [NAME.is_in_replay.dataref]: 0 }),
        't',
      ).slew,
    ).toBe(false);
  });

  it('ITT: нереалистично низкая при горящем двигателе → null (Laminar A320)', () => {
    const sample = buildXPlaneSample(
      map({
        [NAME.ITT_deg_C.dataref]: [10.57, 10.57, 0, 0, 0, 0, 0, 0],
        [NAME.engine_is_burning_fuel.dataref]: [1, 1, 0, 0, 0, 0, 0, 0],
      }),
      't',
    );
    expect(sample.egt_c).toEqual([null, null, 0, 0]);
  });

  it('ITT: реалистичная при горящем двигателе сохраняется', () => {
    const sample = buildXPlaneSample(
      map({
        [NAME.ITT_deg_C.dataref]: [420, 430, 0, 0],
        [NAME.engine_is_burning_fuel.dataref]: [1, 1, 0, 0],
      }),
      't',
    );
    expect(sample.egt_c).toEqual([420, 430, 0, 0]);
  });

  it('autopilot: approach/glideslope status === 2 → captured', () => {
    const sample = buildXPlaneSample(
      map({
        [NAME.autopilot_on.dataref]: 1,
        [NAME.autothrottle_on.dataref]: 0,
        [NAME.approach_status.dataref]: 2,
        [NAME.glideslope_status.dataref]: 1,
      }),
      't',
    );
    expect(sample.autopilot_master).toBe(true);
    expect(sample.autothrottle_active).toBe(false);
    expect(sample.autopilot_approach_hold).toBe(true);
    expect(sample.autopilot_glideslope_hold).toBeNull();
  });
});

describe('A-04: REPLACED weather datarefs → подтверждённые замены (честный null)', () => {
  it('QNH: sealevel_pressure_pas (Па) → hPa; отсутствие → null', () => {
    expect(
      buildXPlaneSample(map({ [NAME.sealevel_pressure_pas.dataref]: 101_325 }), 't').qnh_hpa,
    ).toBeCloseTo(1013.25, 6);
    expect(buildXPlaneSample(map({}), 't').qnh_hpa).toBeNull();
  });

  it('visibility: visibility_reported_sm (статутные мили) → метры; отсутствие → null', () => {
    expect(
      buildXPlaneSample(map({ [NAME.visibility_reported_sm.dataref]: 10 }), 't').visibility_m,
    ).toBeCloseTo(16_093.44, 6);
    expect(buildXPlaneSample(map({}), 't').visibility_m).toBeNull();
  });

  it('ветер: wind_now_speed_msc (m/s) → узлы, отрицательное → 0; отсутствие → null', () => {
    expect(
      buildXPlaneSample(map({ [NAME.wind_speed_msc.dataref]: 4.18 }), 't').wind_speed_kt,
    ).toBeCloseTo(4.18 * MPS_TO_KNOTS, 6);
    expect(buildXPlaneSample(map({ [NAME.wind_speed_msc.dataref]: -1 }), 't').wind_speed_kt).toBe(0);
    expect(buildXPlaneSample(map({}), 't').wind_speed_kt).toBeNull();
    expect(
      buildXPlaneSample(map({ [NAME.wind_direction_degt.dataref]: 370 }), 't').wind_dir_deg,
    ).toBe(10);
    expect(buildXPlaneSample(map({}), 't').wind_dir_deg).toBeNull();
  });

  it('температура: temperature_ambient_deg_c (°C) как есть; отсутствие → null', () => {
    expect(
      buildXPlaneSample(map({ [NAME.temperature_ambient_c.dataref]: 12.5 }), 't').temp_c,
    ).toBe(12.5);
    expect(buildXPlaneSample(map({}), 't').temp_c).toBeNull();
  });

  it('НЕ читаем сами REPLACED-dataref\'ы: их имена вне allow-list и не дают значений', () => {
    const replaced = [
      'sim/weather/wind_direction_degt',
      'sim/weather/wind_speed_kt',
      'sim/weather/temperature_ambient_c',
      'sim/weather/barometer_sealevel_inhg',
      'sim/weather/rain_percent',
      'sim/weather/visibility_reported_m',
    ];
    for (const name of replaced) {
      expect(
        Object.values(NAME).some((spec) => spec.dataref === name),
        `${name} must not be in the dataref table`,
      ).toBe(false);
    }
    // Старые имена, поданные в карту, не мапятся ни на одно поле.
    const stale = map({
      'sim/weather/barometer_sealevel_inhg': 29.92,
      'sim/weather/visibility_reported_m': 8000,
      'sim/weather/wind_speed_kt': 12,
    });
    const sample = buildXPlaneSample(stale, 't');
    expect(sample.qnh_hpa).toBeNull();
    expect(sample.visibility_m).toBeNull();
    expect(sample.wind_speed_kt).toBeNull();
  });
});

describe('data-dataref decoding', () => {
  it('строка обрезается по NUL; массив байт декодируется', () => {
    expect(decodeXPlaneString('B738\0trailing')).toBe('B738');
    expect(decodeXPlaneString('')).toBeNull();
    expect(decodeXPlaneString([0x42, 0x37, 0x33, 0x38, 0x00, 0x41])).toBe('B738');
    expect(decodeXPlaneString(null)).toBeNull();
  });

  it('atc_model из acf_ICAO попадает в sample', () => {
    const sample = buildXPlaneSample(map({ [NAME.acf_ICAO.dataref]: 'A320' }), 't');
    expect(sample.atc_model).toBe('A320');
  });

  it('base64 (реальный формат Web API) декодируется', () => {
    // Записано с живого X-Plane 12.4.3 (Laminar A320).
    expect(
      decodeXPlaneString('QTIwTgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='),
    ).toBe('A20N');
    const descrip =
      'QTMyMCB3aXRoIGhpZ2ggZmlkZWxpdHkgc3lzdGVtIG1vZGVsbGluZwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    expect(decodeXPlaneString(descrip)).toBe('A320 with high fidelity system modelling');
    expect(
      buildXPlaneSample(
        map({ [NAME.acf_ICAO.dataref]: 'QTIwTgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' }),
        't',
      ).atc_model,
    ).toBe('A20N');
  });

  it('plain-строки (не base64) не ломаются декодером', () => {
    expect(decodeXPlaneString('A320')).toBe('A320');
    expect(decodeXPlaneString('B738')).toBe('B738');
    expect(decodeXPlaneString('Airbus A320')).toBe('Airbus A320');
  });
});

describe('setXPlaneValue (сборка поэлементных RREF-массивов)', () => {
  it('скаляр пишется по имени, элемент — в массив', () => {
    const values = new Map<string, XPlaneRawValue>();
    setXPlaneValue(
      values,
      { role: 'latitude', dataref: NAME.latitude.dataref, element: null },
      47.5,
    );
    setXPlaneValue(
      values,
      { role: 'gear_deploy_ratio', dataref: NAME.gear_deploy_ratio.dataref, element: 0 },
      1,
    );
    setXPlaneValue(
      values,
      { role: 'gear_deploy_ratio', dataref: NAME.gear_deploy_ratio.dataref, element: 2 },
      0.5,
    );
    expect(values.get(NAME.latitude.dataref)).toBe(47.5);
    const gear = values.get(NAME.gear_deploy_ratio.dataref);
    expect(Array.isArray(gear)).toBe(true);
    expect(gear).toEqual([1, null, 0.5, null, null, null, null, null, null, null]);
  });
});
