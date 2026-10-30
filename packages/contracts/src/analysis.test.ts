import { describe, expect, it } from 'vitest';

import {
  LANDING_ANALYSIS_VERSION,
  flightAggregatesSchema,
  flightCompleteSchema,
  landingAnalysisSchema,
} from './index';

const TS = '2026-09-23T12:00:00.000Z';
const UUID = '123e4567-e89b-42d3-a456-426614174000';

function validAnalysis(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: LANDING_ANALYSIS_VERSION,
    config_at_1000ft: {
      flaps_percent: 30,
      spoilers_percent: 0,
      spoilers_armed: true,
      gear_down: true,
      autopilot_master: true,
      autothrottle_active: true,
    },
    config_at_500ft: null,
    ap_disconnect_agl_ft: 800,
    at_disconnect_agl_ft: 800,
    flare_height_ft: 50,
    flare_duration_s: 1.2,
    ils: {
      samples: 12,
      max_abs_cdi: 0.6,
      max_abs_gsi: 0.3,
      min_glide_slope_error_deg: -0.4,
      max_glide_slope_error_deg: 0.1,
      cdi_valid: true,
      gsi_valid: true,
      has_localizer: true,
    },
    aoa_touchdown_deg: 5.2,
    aoa_max_near_touchdown_deg: 5.4,
    cg_percent_touchdown: 31.5,
    surface_condition: 1,
    surface_type: 2,
    on_any_runway: true,
    touchdown_point: {
      relative_x_m: 5,
      relative_z_m: -150,
      aiming_x_m: 0,
      aiming_z_m: 300,
      start_distance_m: 150,
      end_distance_m: 2850,
      heading_deg_true: 245,
      length_m: 3000,
      width_m: 45,
    },
    radio_height_touchdown_ft: 0,
    wind_shear: { samples: 10, max_wind_speed_delta_kt: 2.5, max_wind_dir_delta_deg: 15 },
    series: {
      ils_cdi: [{ t_s: -1, value: 0.4 }],
      ils_gsi: [{ t_s: -1, value: -0.2 }],
      aoa_deg: [{ t_s: -1, value: 5.1 }],
      flaps_percent: [{ t_s: -1, value: 30 }],
    },
    ...overrides,
  };
}

describe('landingAnalysisSchema (WAVE 4 FOQA)', () => {
  it('принимает полный анализ и nullable-поля', () => {
    const parsed = landingAnalysisSchema.safeParse(validAnalysis());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.version).toBe('analysis/1');
  });

  it('пропускает null (absent ≠ 0) во всех измерениях', () => {
    const parsed = landingAnalysisSchema.safeParse(
      validAnalysis({
        config_at_1000ft: null,
        ils: null,
        aoa_touchdown_deg: null,
        cg_percent_touchdown: null,
        surface_condition: null,
        surface_type: null,
        touchdown_point: null,
        radio_height_touchdown_ft: null,
        wind_shear: null,
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('отвергает неизвестную версию формы', () => {
    expect(landingAnalysisSchema.safeParse(validAnalysis({ version: 'analysis/2' })).success).toBe(
      false,
    );
  });

  it('отбрасывает неизвестные поля, не отклоняя анализ', () => {
    const parsed = landingAnalysisSchema.safeParse(validAnalysis({ future_metric: 1 }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).not.toHaveProperty('future_metric');
  });

  it('принимает tri-state valid-флаги ILS: null = неизвестно (X-Plane), не false', () => {
    const parsed = landingAnalysisSchema.safeParse(
      validAnalysis({
        ils: {
          samples: 120,
          max_abs_cdi: 0.4,
          max_abs_gsi: 0.5,
          min_glide_slope_error_deg: null,
          max_glide_slope_error_deg: null,
          // X-Plane не отдаёт эквивалент valid-флагов → честный null.
          cdi_valid: null,
          gsi_valid: null,
          has_localizer: null,
        },
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.ils?.cdi_valid).toBeNull();
      expect(parsed.data.ils?.gsi_valid).toBeNull();
      expect(parsed.data.ils?.has_localizer).toBeNull();
    }
  });
});

describe('flightAggregatesSchema (WAVE 4)', () => {
  it('принимает скалярные агрегаты и карту landings_analysis', () => {
    const parsed = flightAggregatesSchema.safeParse({
      landing_weight_kg: 62000,
      landing_weight_source: 'sim',
      phases: {
        takeoff: { vs_mean_fpm: 1800, pitch_mean_deg: 9.5 },
        climb: { avg_ias_kt: 250, avg_vs_fpm: 2000 },
        cruise: { altitude_ft: 36000, avg_gs_kt: 470 },
        descent: { avg_vs_fpm: -1900, max_ias_kt: 290 },
        approach: {
          avg_gs_kt: 145,
          gs_at_1000ft_kt: 150,
          gs_at_500ft_kt: 140,
          sink_rate_1000_500_fpm: -720,
        },
      },
      stability: {
        stabilized_by_1000ft: true,
        stabilized_by_500ft: true,
        gs_variation_kt_1000_500: 10,
        vertical_speed_variation_fpm: 120,
        bank_excursions_count: 1,
      },
      events: [{ type: 'touchdown', at_sec_from_touchdown: 0 }],
      landings_analysis: { '1': validAnalysis() },
      future_key: 'ignored',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.landing_weight_kg).toBe(62000);
      expect(parsed.data.landings_analysis?.['1']?.version).toBe('analysis/1');
      expect(parsed.data).not.toHaveProperty('future_key');
    }
  });

  it('принимает пустой объект (агрегатов нет)', () => {
    expect(flightAggregatesSchema.safeParse({}).success).toBe(true);
  });
});

describe('flightCompleteSchema.stats (WAVE 4)', () => {
  it('принимает finalized-агрегаты клиента (аддитивно)', () => {
    const parsed = flightCompleteSchema.safeParse({
      ended_at: TS,
      client_flight_id: UUID,
      is_partial: false,
      paused_total_s: 0,
      quality_flags: 0,
      stats: {
        landing_weight_kg: 62000,
        landing_weight_source: 'sim',
        landings_analysis: { '1': validAnalysis() },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.stats?.landing_weight_kg).toBe(62000);
      expect(parsed.data.stats?.landings_analysis?.['1']).toBeDefined();
    }
  });

  it('старый клиент без stats по-прежнему принимается', () => {
    const parsed = flightCompleteSchema.safeParse({ ended_at: TS, client_flight_id: UUID });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.stats).toBeUndefined();
  });

  it('XP /complete с null valid-флагами ILS не отклоняется (no 422)', () => {
    const ils = {
      samples: 120,
      max_abs_cdi: 0.4,
      max_abs_gsi: 0.5,
      min_glide_slope_error_deg: null,
      max_glide_slope_error_deg: null,
      cdi_valid: null,
      gsi_valid: null,
      has_localizer: null,
    };
    const parsed = flightCompleteSchema.safeParse({
      ended_at: TS,
      client_flight_id: UUID,
      is_partial: false,
      paused_total_s: 0,
      quality_flags: 0,
      stats: { ils, landings_analysis: { '1': validAnalysis({ ils }) } },
    });
    expect(parsed.success).toBe(true);
  });
});
