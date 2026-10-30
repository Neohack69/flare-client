import { hasFlightEvidence, type LiftoffEvidenceOptions } from '@flightlog/scoring';

import type { TelemetrySample } from '../sim/types.js';

/**
 * Общий с сервером критерий реального отрыва для агентского сэмпла: поля
 * `TelemetrySample` (`gs_kt`/`vs_fpm`/`agl_ft`) маппятся на нейтральный вход
 * `hasFlightEvidence` (`packages/scoring`), чтобы агент и сервер использовали
 * одну детерминированную логику (bogus-airborne на стоянке не подтверждается).
 */
export function hasSampleFlightEvidence(
  sample: TelemetrySample,
  options?: LiftoffEvidenceOptions,
): boolean {
  return hasFlightEvidence(
    {
      on_ground: sample.on_ground,
      groundspeed_kt: sample.gs_kt,
      vertical_speed_fpm: sample.vs_fpm,
      agl_ft: sample.agl_ft,
    },
    options,
  );
}
