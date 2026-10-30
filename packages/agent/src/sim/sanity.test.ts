import { describe, expect, it } from 'vitest';

import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';
import { XPLANE_DATAREFS } from './xplane/datarefs.js';
import { buildXPlaneSample, type XPlaneRawValue } from './xplane/values.js';
import { checkSampleSanity, isXPlaneNoAirflowIas, XPLANE_MIN_PLAUSIBLE_IAS_KT } from './sanity.js';

const TS = isoAt(BASE_MS, 0);

describe('checkSampleSanity (кадр SimConnect)', () => {
  it('правдоподобный кадр проходит', () => {
    expect(checkSampleSanity(makeSample(TS)).ok).toBe(true);
  });

  it('null-island кадр меню/загрузки отбрасывается', () => {
    expect(
      checkSampleSanity(
        makeSample(TS, {
          lat: 0,
          lon: 90,
          alt_ft: 16632,
          agl_ft: 16415,
          on_ground: false,
          gs_kt: 250,
          vs_fpm: 1200,
        }),
      ),
    ).toEqual({ ok: false, reason: 'null_island' });
  });

  it('нечисловые координаты и скорости отбрасываются', () => {
    expect(checkSampleSanity(makeSample(TS, { lat: Number.NaN })).reason).toBe(
      'lat_lon_non_finite',
    );
    expect(checkSampleSanity(makeSample(TS, { gs_kt: Number.POSITIVE_INFINITY })).reason).toBe(
      'gs_non_finite',
    );
  });

  it('абсурдные высоты/скорости отбрасываются', () => {
    expect(checkSampleSanity(makeSample(TS, { alt_ft: 70_000 })).reason).toBe('alt_out_of_range');
    expect(checkSampleSanity(makeSample(TS, { gs_kt: 2_000 })).reason).toBe('gs_out_of_range');
    expect(checkSampleSanity(makeSample(TS, { ias_kt: 2_500 })).reason).toBe('ias_out_of_range');
  });
});

/**
 * Живые замеры X-Plane 12.4.3 (Laminar A320). Ключевая особенность: аэродинамика
 * XP отдаёт малую **отрицательную** IAS без потока (`indicated_airspeed ≈ −8.16 kt`
 * на стоянке) и отрицательный AGL (`y_agl ≈ −0.14 m ≈ −0.46 ft`). Кадр физически
 * валиден, но MSFS-ориентированный guard отвергал его целиком — запись на стоянке
 * не начиналась. Фикстуры воспроизводят эти значения из канонических полей.
 */
describe('checkSampleSanity — X-Plane 12 «без потока» (живые замеры 12.4.3)', () => {
  const parkedXp = (overrides: Parameters<typeof makeSample>[1] = {}) =>
    makeSample(TS, {
      lat: 41.2753,
      lon: 28.7519,
      alt_ft: 325,
      agl_ft: -0.46,
      gs_kt: 0,
      ias_kt: -8.16,
      vs_fpm: 0,
      g: 1,
      on_ground: true,
      engine_running: true,
      ...overrides,
    });

  it('на стоянке: отрицательная IAS −8.16 и AGL −0.46 ft принимаются', () => {
    expect(checkSampleSanity(parkedXp(), { sim: 'xplane12' })).toEqual({
      ok: true,
      reason: null,
    });
  });

  it('на разбеге: положительная IAS при отрицательном AGL принимается', () => {
    expect(
      checkSampleSanity(parkedXp({ ias_kt: 45, gs_kt: 45, agl_ft: -0.16 }), { sim: 'xplane12' })
        .ok,
    ).toBe(true);
  });

  it('допуск ограничен полосой [−50, 0): −60 kt отвергается', () => {
    expect(checkSampleSanity(parkedXp({ ias_kt: -60 }), { sim: 'xplane12' }).reason).toBe(
      'ias_out_of_range',
    );
    expect(
      checkSampleSanity(parkedXp({ ias_kt: XPLANE_MIN_PLAUSIBLE_IAS_KT }), { sim: 'xplane12' }).ok,
    ).toBe(true);
  });

  it('потолок IAS не ослаблен: 2 500 kt отвергается', () => {
    expect(checkSampleSanity(parkedXp({ ias_kt: 2_500 }), { sim: 'xplane12' }).reason).toBe(
      'ias_out_of_range',
    );
  });

  it('повторная проверка сохраняет контроль остальных полей', () => {
    expect(
      checkSampleSanity(parkedXp({ vs_fpm: Number.NaN }), { sim: 'xplane12' }).reason,
    ).toBe('vs_non_finite');
    expect(checkSampleSanity(parkedXp({ gs_kt: -5 }), { sim: 'xplane12' }).reason).toBe(
      'gs_out_of_range',
    );
    expect(checkSampleSanity(parkedXp({ lat: 0, lon: 90 }), { sim: 'xplane12' }).reason).toBe(
      'null_island',
    );
  });

  it('MSFS-поведение не меняется: отрицательная IAS без метки XP отвергается', () => {
    expect(checkSampleSanity(parkedXp()).reason).toBe('ias_out_of_range');
    expect(checkSampleSanity(parkedXp(), { sim: 'msfs2024' }).reason).toBe('ias_out_of_range');
  });

  it('isXPlaneNoAirflowIas распознаёт полосу и границы', () => {
    expect(isXPlaneNoAirflowIas(-8.16)).toBe(true);
    expect(isXPlaneNoAirflowIas(XPLANE_MIN_PLAUSIBLE_IAS_KT)).toBe(true);
    expect(isXPlaneNoAirflowIas(-0.001)).toBe(true);
    expect(isXPlaneNoAirflowIas(0)).toBe(false);
    expect(isXPlaneNoAirflowIas(-60)).toBe(false);
    expect(isXPlaneNoAirflowIas(2_500)).toBe(false);
    expect(isXPlaneNoAirflowIas(Number.NaN)).toBe(false);
    expect(isXPlaneNoAirflowIas(null)).toBe(false);
  });

  it('канонический путь dataref → TelemetrySample → guard проходит на стоянке', () => {
    const raw = new Map<string, XPlaneRawValue>([
      [XPLANE_DATAREFS.latitude.dataref, 41.2753],
      [XPLANE_DATAREFS.longitude.dataref, 28.7519],
      [XPLANE_DATAREFS.elevation.dataref, 99.06],
      [XPLANE_DATAREFS.y_agl.dataref, -0.14],
      [XPLANE_DATAREFS.groundspeed.dataref, 0],
      [XPLANE_DATAREFS.indicated_airspeed.dataref, -8.16],
      [XPLANE_DATAREFS.vh_ind_fpm.dataref, -2],
      [XPLANE_DATAREFS.true_psi.dataref, 20],
      [XPLANE_DATAREFS.true_theta.dataref, 0],
      [XPLANE_DATAREFS.true_phi.dataref, 0],
      [XPLANE_DATAREFS.g_nrml.dataref, 1],
      [XPLANE_DATAREFS.onground_any.dataref, 1],
    ]);
    const sample = buildXPlaneSample(raw, TS);

    expect(sample.ias_kt).toBeCloseTo(-8.16, 5);
    expect(sample.agl_ft).toBeCloseTo(-0.46, 1);
    expect(sample.gs_kt).toBe(0);
    expect(sample.on_ground).toBe(true);
    expect(checkSampleSanity(sample, { sim: 'xplane12' })).toEqual({ ok: true, reason: null });
  });
});
