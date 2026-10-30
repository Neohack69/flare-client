import type { TelemetrySample } from '../sim/types.js';

/** Базовая «холодная стоянка»: на земле, двигатель работает, скорость 0. */
export function makeSample(ts: string, overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  const sample: TelemetrySample = {
    ts,
    lat: 55.972,
    lon: 37.414,
    alt_ft: 600,
    agl_ft: 0,
    gs_kt: 0,
    ias_kt: 0,
    vs_fpm: 0,
    heading_deg: 0,
    pitch_deg: 0,
    bank_deg: 0,
    g: 1,
    on_ground: true,
    gear_down: true,
    fuel_qty_gal: 200,
    engine_running: true,
    engines_running: 1,
    atc_model: 'Boeing 737-800',
    atc_type: 'B738',
    slew: false,
    ...overrides,
  };
  // Согласованность агрегата двигателей и флага «хотя бы один работает».
  if (overrides.engines_running !== undefined && overrides.engine_running === undefined) {
    sample.engine_running = overrides.engines_running > 0;
  } else if (overrides.engine_running !== undefined && overrides.engines_running === undefined) {
    sample.engines_running = overrides.engine_running ? 1 : 0;
  }
  return sample;
}

export function isoAt(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

export const BASE_MS = Date.parse('2026-09-23T12:00:00.000Z');

/** Последовательность сэмплов с шагом `stepMs` и ts, сдвигающимся от BASE_MS. */
export function series(
  count: number,
  stepMs: number,
  overrides: (index: number) => Partial<TelemetrySample>,
): TelemetrySample[] {
  return Array.from({ length: count }, (_, index) =>
    makeSample(isoAt(BASE_MS + index * stepMs, 0), overrides(index)),
  );
}
