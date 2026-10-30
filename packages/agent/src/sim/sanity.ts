import { checkTelemetrySample, type TelemetrySanityResult } from '@flightlog/scoring';

import type { SimSourceId } from './source.js';
import type { TelemetrySample } from './types.js';

/**
 * Минимальная физически осмысленная индикаторная скорость (kt) для X-Plane 12.
 *
 * Аэродинамическая модель X-Plane честно отдаёт **малую отрицательную IAS**,
 * когда потока нет (стоянка / очень малая скорость): на живом 12.4.3 (Laminar
 * A320, на стоянке) измерено `sim/flightmodel/position/indicated_airspeed ≈
 * −8.16 kt` (`airspeed_kts_pilot −8.1644`, `airspeed_kts_copilot −8.1656`).
 * Это следствие модели «полное − статическое давление», а НЕ порча кадра.
 * MSFS, наоборот, клампит IAS к `≥ 0`.
 *
 * Поэтому общий детерминированный guard (`checkTelemetrySample`) отвергал
 * **каждый** кадр X-Plane на стоянке (`ias_out_of_range`), и запись рейса не
 * начиналась — даже разбег не писался, пока IAS не становилась положительной.
 *
 * Допуск −50 kt: запас ≈6× к измеренному значению (покрывает более скоростные
 * ВС и высокогорные аэродромы), но заведомо ниже любого реального сбоя —
 * например, −1000 kt или 2500 kt по-прежнему отвергаются.
 */
export const XPLANE_MIN_PLAUSIBLE_IAS_KT = -50;

/** Опции проверки кадра. */
export interface SampleSanityOptions {
  /**
   * Источник телеметрии кадра. Только `xplane12` получает допуск отрицательной
   * IAS «без потока»; для `msfs2024`/`null` поведение guard'а не меняется
   * (MSFS клампит IAS к `≥ 0`, реальные кадры отрицательных значений не дают).
   */
  sim?: SimSourceId | null;
}

/**
 * IAS в легитимной «отрицательной без потока» полосе X-Plane (не порча кадра):
 * [−50, 0) kt. Значения за пределами полосы (в т.ч. выше максимума guard'а)
 * под допуск не попадают.
 */
export function isXPlaneNoAirflowIas(ias_kt: number | null | undefined): boolean {
  return (
    typeof ias_kt === 'number' &&
    Number.isFinite(ias_kt) &&
    ias_kt < 0 &&
    ias_kt >= XPLANE_MIN_PLAUSIBLE_IAS_KT
  );
}

/**
 * Проверка правдоподобия кадра SimConnect (P0, data integrity). Тонкая обёртка
 * над детерминированным `checkTelemetrySample` из `@flightlog/scoring`, чтобы
 * агент и сервер использовали одни пороги (см. `TELEMETRY_SANITY_LIMITS`).
 *
 * Мусорные кадры меню/загрузки (null island, произвольные `alt`/`agl`) не
 * должны ни стартовать рейс, ни попадать в полёт.
 *
 * X-Plane 12 (см. `XPLANE_MIN_PLAUSIBLE_IAS_KT`): допускаем легитимную
 * отрицательную IAS «без потока». Чтобы не ослабить остальные проверки, при
 * срабатывании только по IAS кадр прогоняется той же функцией повторно с
 * нейтрализованной IAS: нечисловой `vs`, `gs < 0`, абсурдная `alt`/`agl` и IAS
 * выше потолка по-прежнему отвергаются.
 */
export function checkSampleSanity(
  sample: TelemetrySample,
  options: SampleSanityOptions = {},
): TelemetrySanityResult {
  const input = {
    lat: sample.lat,
    lon: sample.lon,
    alt_ft: sample.alt_ft,
    agl_ft: sample.agl_ft,
    gs_kt: sample.gs_kt,
    ias_kt: sample.ias_kt,
    vs_fpm: sample.vs_fpm,
  };
  const result = checkTelemetrySample(input);
  if (result.ok) return result;

  if (
    options.sim === 'xplane12' &&
    result.reason === 'ias_out_of_range' &&
    isXPlaneNoAirflowIas(sample.ias_kt)
  ) {
    return checkTelemetrySample({ ...input, ias_kt: null });
  }
  return result;
}

export type { TelemetrySanityReason, TelemetrySanityResult } from '@flightlog/scoring';
