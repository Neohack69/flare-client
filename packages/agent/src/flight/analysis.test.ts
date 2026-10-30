import { describe, expect, it } from 'vitest';

import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';
import { FlightAnalysis, classifyPhase } from './analysis.js';

/** Приближение к торцу с плавным снижением и выравниванием. */
function approachSamples(): ReturnType<typeof makeSample>[] {
  const steps: Array<{ agl: number; vs: number; ap: boolean }> = [
    { agl: 1500, vs: -800, ap: true },
    { agl: 1200, vs: -800, ap: true },
    { agl: 1000, vs: -780, ap: true },
    { agl: 900, vs: -760, ap: true },
    { agl: 800, vs: -740, ap: false },
    { agl: 700, vs: -720, ap: false },
    { agl: 500, vs: -700, ap: false },
    { agl: 300, vs: -600, ap: false },
    { agl: 100, vs: -450, ap: false },
    { agl: 50, vs: -200, ap: false },
  ];
  return steps.map((step, index) =>
    makeSample(isoAt(BASE_MS, index * 1000), {
      on_ground: false,
      agl_ft: step.agl,
      vs_fpm: step.vs,
      alt_ft: 600 + step.agl,
      gs_kt: 140 - index,
      ias_kt: 140 - index,
      gear_down: true,
      flaps_percent: 30,
      spoilers_armed: true,
      autopilot_master: step.ap,
      autothrottle_active: step.ap,
      incidence_alpha_rad: 0.05 + index * 0.002,
      cg_percent: 31.5,
      surface_condition: 1,
      surface_type: 2,
      on_any_runway: true,
      radio_height_ft: Math.max(0, step.agl - 6),
      hsi_has_localizer: true,
      hsi_cdi_needle: index % 2 === 0 ? 0.4 : -0.6,
      hsi_cdi_needle_valid: true,
      hsi_gsi_needle: -0.2,
      hsi_gsi_needle_valid: true,
      nav_glide_slope_error_deg: -0.35 + index * 0.01,
      wind_speed_kt: 10 + index * 0.5,
      wind_dir_deg: 240 + index,
      atc_runway_relative_x_m: 5,
      atc_runway_relative_z_m: -150,
      atc_runway_tdpoint_relative_x_m: 0,
      atc_runway_tdpoint_relative_z_m: 300,
      atc_runway_start_distance_m: 150,
      atc_runway_end_distance_m: 2850,
      atc_runway_heading_deg: 245,
      atc_runway_length_m: 3000,
      atc_runway_width_m: 45,
    }),
  );
}

function touchdownSample(): ReturnType<typeof makeSample> {
  return makeSample(isoAt(BASE_MS, 10_000), {
    on_ground: true,
    agl_ft: 0,
    vs_fpm: -160,
    gs_kt: 125,
    gear_down: true,
    flaps_percent: 30,
    incidence_alpha_rad: 0.09,
    cg_percent: 31.4,
    surface_condition: 1,
    surface_type: 2,
    on_any_runway: true,
    radio_height_ft: 0,
    atc_runway_relative_x_m: 5,
    atc_runway_relative_z_m: -146,
    atc_runway_tdpoint_relative_x_m: 0,
    atc_runway_tdpoint_relative_z_m: 304,
    atc_runway_start_distance_m: 146,
    atc_runway_end_distance_m: 2854,
    atc_runway_heading_deg: 245,
    atc_runway_length_m: 3000,
    atc_runway_width_m: 45,
  });
}

describe('classifyPhase', () => {
  it('группирует кадры по фазе детерминированно', () => {
    expect(classifyPhase(makeSample('2026-09-23T12:00:00.000Z', { on_ground: true }))).toBeNull();
    expect(
      classifyPhase(
        makeSample('2026-09-23T12:00:00.000Z', { on_ground: false, agl_ft: 500, vs_fpm: 0 }),
      ),
    ).toBe('approach');
    expect(
      classifyPhase(
        makeSample('2026-09-23T12:00:00.000Z', { on_ground: false, agl_ft: 1500, vs_fpm: 500 }),
      ),
    ).toBe('takeoff');
    expect(
      classifyPhase(
        makeSample('2026-09-23T12:00:00.000Z', { on_ground: false, agl_ft: 500, vs_fpm: 500 }),
      ),
    ).toBe('takeoff');
    expect(
      classifyPhase(
        makeSample('2026-09-23T12:00:00.000Z', { on_ground: false, agl_ft: 30_000, vs_fpm: 500 }),
      ),
    ).toBe('climb');
    expect(
      classifyPhase(
        makeSample('2026-09-23T12:00:00.000Z', { on_ground: false, agl_ft: 30_000, vs_fpm: 0 }),
      ),
    ).toBe('cruise');
    expect(
      classifyPhase(
        makeSample('2026-09-23T12:00:00.000Z', { on_ground: false, agl_ft: 15_000, vs_fpm: -1200 }),
      ),
    ).toBe('descent');
  });
});

describe('FlightAnalysis (WAVE 4)', () => {
  it('считает per-landing анализ: конфигурация, disconnect, ILS, AoA, касание', () => {
    const analysis = new FlightAnalysis();
    for (const sample of approachSamples()) analysis.onSample(sample);
    analysis.onTouchdown(1, touchdownSample(), null);

    const result = analysis.getLandingAnalysis(1);
    expect(result).toBeDefined();
    if (!result) return;

    expect(result.version).toBe('analysis/1');
    expect(result.config_at_1000ft?.flaps_percent).toBe(30);
    expect(result.config_at_1000ft?.gear_down).toBe(true);
    expect(result.config_at_1000ft?.autopilot_master).toBe(true);
    expect(result.ap_disconnect_agl_ft).toBe(800);
    expect(result.at_disconnect_agl_ft).toBe(800);
    expect(result.flare_height_ft).toBe(50);
    expect(result.flare_duration_s).toBe(1);
    expect(result.ils?.has_localizer).toBe(true);
    expect(result.ils?.samples).toBeGreaterThan(0);
    expect(result.ils?.max_abs_cdi).toBeCloseTo(0.6, 6);
    expect(result.ils?.gsi_valid).toBe(true);
    expect(result.aoa_touchdown_deg).toBeCloseTo((0.09 * 180) / Math.PI, 1);
    expect(result.aoa_max_near_touchdown_deg).not.toBeNull();
    expect(result.cg_percent_touchdown).toBe(31.4);
    expect(result.surface_condition).toBe(1);
    expect(result.surface_type).toBe(2);
    expect(result.on_any_runway).toBe(true);
    expect(result.touchdown_point?.relative_z_m).toBe(-146);
    expect(result.touchdown_point?.heading_deg_true).toBe(245);
    expect(result.radio_height_touchdown_ft).toBe(0);
    expect(result.wind_shear).not.toBeNull();
    expect(result.series.ils_cdi.length).toBeGreaterThan(0);
    expect(result.series.aoa_deg.length).toBeGreaterThan(0);
  });

  it('возвращает null там, где измерения нет (не поддельный 0)', () => {
    const analysis = new FlightAnalysis();
    // Взлётный профиль без ILS/AT: конфигурация и disconnect отсутствуют.
    for (let i = 0; i < 5; i += 1) {
      analysis.onSample(
        makeSample(isoAt(BASE_MS, i * 1000), {
          on_ground: false,
          agl_ft: 2000,
          vs_fpm: 500,
          gear_down: null,
          flaps_percent: null,
        }),
      );
    }
    analysis.onTouchdown(1, makeSample(isoAt(BASE_MS, 6000), { on_ground: true, agl_ft: 0 }), null);
    const result = analysis.getLandingAnalysis(1);
    expect(result?.ils).toBeNull();
    expect(result?.aoa_touchdown_deg).toBeNull();
    expect(result?.ap_disconnect_agl_ft).toBeNull();
    expect(result?.touchdown_point).toBeNull();
  });

  it('X-Plane: valid-флаги ILS неизвестны → null (не coerced false), отклонения сохранены', () => {
    const analysis = new FlightAnalysis();
    for (let i = 0; i < 6; i += 1) {
      analysis.onSample(
        makeSample(isoAt(BASE_MS, i * 1000), {
          on_ground: false,
          agl_ft: 800 - i * 100,
          alt_ft: 1600 - i * 100,
          vs_fpm: -700,
          gs_kt: 140,
          hsi_cdi_needle: 0.3 + i * 0.1,
          hsi_cdi_needle_valid: null,
          hsi_gsi_needle: -0.2,
          hsi_gsi_needle_valid: null,
          hsi_has_localizer: null,
        }),
      );
    }
    analysis.onTouchdown(
      1,
      makeSample(isoAt(BASE_MS, 6000), { on_ground: true, agl_ft: 0, vs_fpm: -150, gs_kt: 120 }),
      null,
    );
    const result = analysis.getLandingAnalysis(1);
    expect(result?.ils).not.toBeNull();
    expect(result?.ils?.cdi_valid).toBeNull();
    expect(result?.ils?.gsi_valid).toBeNull();
    expect(result?.ils?.has_localizer).toBeNull();
    expect(result?.ils?.max_abs_cdi).toBeGreaterThan(0);
  });

  it('ENGINE-MODE: агрегаты 1000/500 ft, касания и пробега (N1/тяга/реверс)', () => {
    const analysis = new FlightAnalysis();
    const approach = approachSamples().map((sample, index) => ({
      ...sample,
      n1_percent: [60 - index, 60 - index, null, null],
      throttle_percent: [10, 10, null, null],
      fuel_flow_pph: [2400, 2400, null, null],
      reverse_percent: [0, 0, null, null],
      reverse_engaged: false,
      engine_mode: 'idle' as const,
    }));
    for (const sample of approach) analysis.onSample(sample);

    const touchdown = makeSample(isoAt(BASE_MS, 10_000), {
      on_ground: true,
      agl_ft: 0,
      vs_fpm: -160,
      gs_kt: 125,
      n1_percent: [62, 62, null, null],
      throttle_percent: [0, 0, null, null],
      fuel_flow_pph: [2300, 2300, null, null],
      reverse_percent: [100, 100, null, null],
      reverse_engaged: true,
      engine_mode: 'reverse',
    });
    analysis.onTouchdown(1, touchdown, null);
    analysis.onSample(
      makeSample(isoAt(BASE_MS, 11_000), {
        on_ground: true,
        gs_kt: 90,
        n1_percent: [50, 50, null, null],
        throttle_percent: [8, 8, null, null],
        fuel_flow_pph: [2100, 2100, null, null],
        reverse_engaged: true,
        engine_mode: 'reverse',
      }),
    );
    analysis.onSample(
      makeSample(isoAt(BASE_MS, 12_000), {
        on_ground: true,
        gs_kt: 45,
        n1_percent: [45, 45, null, null],
        throttle_percent: [8, 8, null, null],
        fuel_flow_pph: [1900, 1900, null, null],
        reverse_engaged: true,
        engine_mode: 'reverse',
      }),
    );
    analysis.onSample(
      makeSample(isoAt(BASE_MS, 13_000), {
        on_ground: true,
        gs_kt: 20,
        n1_percent: [30, 30, null, null],
        throttle_percent: [8, 8, null, null],
        fuel_flow_pph: [1500, 1500, null, null],
        reverse_engaged: false,
        engine_mode: 'idle',
      }),
    );

    analysis.finalize(touchdown.ts);
    const result = analysis.getLandingAnalysis(1);
    expect(result?.engine_at_1000ft?.n1_mean_percent).not.toBeNull();
    expect(result?.engine_at_1000ft?.mode).toBe('idle');
    expect(result?.engine_at_500ft?.throttle_mean_percent).toBe(10);
    expect(result?.engine_touchdown?.reverse_engaged).toBe(true);
    expect(result?.engine_touchdown?.n1_max_percent).toBe(62);
    expect(result?.engine_rollout?.mode).toBe('reverse');
    expect(result?.engine_rollout?.reverse_engaged).toBe(true);
    expect(result?.engine_rollout?.reverse_duration_s).toBe(2);
    expect(result?.engine_rollout?.duration_s).toBe(3);
  });

  it('финализирует агрегаты рейса (фазы/стабильность/события)', () => {
    const analysis = new FlightAnalysis();
    for (const sample of approachSamples()) analysis.onSample(sample);
    analysis.onEvent('gear_down', isoAt(BASE_MS, 0));
    const touchdown = touchdownSample();
    analysis.onTouchdown(1, touchdown, null);

    const aggregate = analysis.finalize(touchdown.ts);
    expect(aggregate.phases.approach.gs_at_1000ft_kt).toBe(138);
    expect(aggregate.phases.approach.gs_at_500ft_kt).toBe(134);
    expect(aggregate.stability.stabilized_by_1000ft).toBe(true);
    expect(aggregate.stability.stabilized_by_500ft).toBe(true);
    expect(aggregate.stability.bank_excursions_count).toBe(0);
    expect(aggregate.stability.bank_max_deg_1000_500).toBe(0);
    expect(aggregate.stability.stability_version).toBe(2);
    expect(aggregate.events).toEqual([{ type: 'gear_down', at_sec_from_touchdown: -10 }]);
  });

  it('A2: крен 1000→500 ft считается эпизодами, а не кадрами', () => {
    const banks: Readonly<Record<number, number>> = {
      2: 12,
      3: 12,
      4: 7,
      5: -15,
      6: -15,
    };
    const analysis = new FlightAnalysis();
    const samples = approachSamples().map((sample, index) => ({
      ...sample,
      bank_deg: banks[index] ?? 0,
    }));
    for (const sample of samples) analysis.onSample(sample);
    const aggregate = analysis.finalize(isoAt(BASE_MS, 10_000));
    expect(aggregate.stability.bank_excursions_count).toBe(2);
    expect(aggregate.stability.bank_max_deg_1000_500).toBe(15);
    expect(aggregate.stability.stability_version).toBe(2);
  });

  it('reset очищает состояние между рейсами', () => {
    const analysis = new FlightAnalysis();
    for (const sample of approachSamples()) analysis.onSample(sample);
    analysis.onTouchdown(1, touchdownSample(), null);
    expect(analysis.getLandingAnalysis(1)).toBeDefined();
    analysis.reset();
    expect(analysis.getLandingAnalysis(1)).toBeUndefined();
    const aggregate = analysis.finalize(null);
    expect(aggregate.events).toBeNull();
    expect(aggregate.phases.approach.avg_gs_kt).toBeNull();
  });
});

/** Заход, начинающий выравнивание на agl 15.29 ft при vs −250 fpm. */
function flareAt1529Samples(): ReturnType<typeof makeSample>[] {
  const steps = [
    { agl: 200, vs: -700 },
    { agl: 100, vs: -450 },
    { agl: 50, vs: -400 },
    { agl: 15.29, vs: -250 },
  ];
  return steps.map((step, index) =>
    makeSample(isoAt(BASE_MS, 400_000 + index * 1000), {
      on_ground: false,
      agl_ft: step.agl,
      vs_fpm: step.vs,
      gs_kt: 130,
    }),
  );
}

describe('FlightAnalysis datum calibration (FOQA-DATUM-1)', () => {
  it('(a) A220-like +10 ft: калибрует датум и отдаёт высоту колёс', () => {
    const analysis = new FlightAnalysis();
    // Стоянка: колёса на полосе, `agl_ft` = 10 ft (высота опорной точки).
    for (let i = 0; i < 8; i += 1) {
      analysis.onSample(
        makeSample(isoAt(BASE_MS, i * 1000), { on_ground: true, agl_ft: 10, gs_kt: 0 }),
      );
    }
    for (const sample of flareAt1529Samples()) analysis.onSample(sample);
    const touchdown = makeSample(isoAt(BASE_MS, 410_000), {
      on_ground: true,
      agl_ft: 12.18,
      vs_fpm: -114,
      gs_kt: 125,
      radio_height_ft: 12.18,
    });
    analysis.onTouchdown(1, touchdown, null);

    const result = analysis.getLandingAnalysis(1);
    expect(result?.agl_datum_offset_ft).toBe(10);
    expect(result?.agl_datum_version).toBe('agl-datum/1');
    expect(result?.height_datum_calibrated).toBe(true);
    // Сырые (высота опорной точки) — без изменений.
    expect(result?.flare_height_ft).toBe(15.29);
    expect(result?.radio_height_touchdown_ft).toBe(12.18);
    // Калиброванные — высота колёс.
    expect(result?.flare_height_wheel_ft).toBe(5.3);
    expect(result?.wheel_height_touchdown_ft).toBe(2.2);
  });

  it('(b) ~0 offset: высота колёс совпадает с опорной точкой', () => {
    const analysis = new FlightAnalysis();
    for (let i = 0; i < 8; i += 1) {
      analysis.onSample(
        makeSample(isoAt(BASE_MS, i * 1000), { on_ground: true, agl_ft: 0, gs_kt: 0 }),
      );
    }
    for (const sample of flareAt1529Samples()) analysis.onSample(sample);
    const touchdown = makeSample(isoAt(BASE_MS, 410_000), {
      on_ground: true,
      agl_ft: 0,
      vs_fpm: -114,
      gs_kt: 125,
      radio_height_ft: 0,
    });
    analysis.onTouchdown(1, touchdown, null);

    const result = analysis.getLandingAnalysis(1);
    expect(result?.agl_datum_offset_ft).toBe(0);
    expect(result?.height_datum_calibrated).toBe(true);
    // При нулевом сдвиге высота колёс равна опорной точке (с округлением 0.1 ft).
    expect(result?.flare_height_wheel_ft).toBeCloseTo(15.29, 1);
    expect(result?.wheel_height_touchdown_ft).toBe(0);
  });

  it('(c) нет измеримой площадки → не калибровано, высоты колёс = null', () => {
    const analysis = new FlightAnalysis();
    // Старт в воздухе: наземной площадки нет (касание тоже вне `onSample`).
    for (const sample of flareAt1529Samples()) analysis.onSample(sample);
    const touchdown = makeSample(isoAt(BASE_MS, 410_000), {
      on_ground: true,
      agl_ft: 12.18,
      vs_fpm: -114,
      gs_kt: 125,
      radio_height_ft: 12.18,
    });
    analysis.onTouchdown(1, touchdown, null);

    const result = analysis.getLandingAnalysis(1);
    expect(result?.agl_datum_offset_ft).toBeNull();
    expect(result?.height_datum_calibrated).toBe(false);
    expect(result?.flare_height_wheel_ft).toBeNull();
    expect(result?.wheel_height_touchdown_ft).toBeNull();
    // Сырые значения остаются (height of reference point), не подделываются.
    expect(result?.flare_height_ft).toBe(15.29);
    expect(result?.radio_height_touchdown_ft).toBe(12.18);
  });
});
