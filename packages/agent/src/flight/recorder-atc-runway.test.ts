import { describe, expect, it, vi } from 'vitest';

import { MemoryOutboxBuffer } from '../buffer/memory-buffer.js';
import { MockSimConnectAdapter } from '../sim/mock-adapter.js';
import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';
import type { TelemetrySample } from '../sim/types.js';
import { seededUuidGenerator } from '../util/id.js';
import { FlightRecorder } from './recorder.js';

const ATC_FULL: Partial<TelemetrySample> = {
  atc_runway_relative_x_m: 5,
  atc_runway_relative_z_m: -150,
  atc_runway_tdpoint_relative_x_m: 0,
  atc_runway_tdpoint_relative_z_m: 300,
  atc_runway_start_distance_m: 150,
  atc_runway_end_distance_m: 2850,
  atc_runway_heading_deg: 245,
  atc_runway_length_m: 3000,
  atc_runway_width_m: 45,
};

const ATC_ZERO: Partial<TelemetrySample> = {
  atc_runway_relative_x_m: 0,
  atc_runway_relative_z_m: 0,
  atc_runway_tdpoint_relative_x_m: 0,
  atc_runway_tdpoint_relative_z_m: 0,
  atc_runway_start_distance_m: 0,
  atc_runway_end_distance_m: 0,
  atc_runway_heading_deg: 0,
  atc_runway_length_m: 0,
  atc_runway_width_m: 0,
};

function landingSamples(atc: Partial<TelemetrySample>): TelemetrySample[] {
  const samples: TelemetrySample[] = [];
  const at = (offsetS: number, overrides: Partial<TelemetrySample> = {}) => {
    samples.push(makeSample(isoAt(BASE_MS, offsetS * 1000), { ...atc, ...overrides }));
  };
  at(0, { gs_kt: 0, on_ground: true, engine_running: true });
  for (let t = 1; t <= 8; t += 1) at(t, { gs_kt: 25, on_ground: true, engine_running: true });
  for (let t = 9; t <= 38; t = Number((t + 0.1).toFixed(1))) {
    at(t, { on_ground: false, agl_ft: 300, vs_fpm: -500, gs_kt: 150, ias_kt: 140, g: 1.05 });
  }
  at(39, { on_ground: true, agl_ft: 0, vs_fpm: -180, g: 1.3, gs_kt: 120 });
  at(40, { on_ground: true, gs_kt: 60, vs_fpm: 0 });
  at(41, { on_ground: true, gs_kt: 20, vs_fpm: 0 });
  return samples;
}

async function record(
  samples: TelemetrySample[],
): Promise<{ warn: ReturnType<typeof vi.fn>; stats: Record<string, unknown> }> {
  const adapter = new MockSimConnectAdapter();
  const buffer = new MemoryOutboxBuffer();
  const warn = vi.fn();
  const recorder = new FlightRecorder({
    loadQuarantineS: 0,
    source: adapter,
    buffer,
    idGenerator: seededUuidGenerator(),
    warn,
    endEngineOffS: 3,
    endStationaryS: 600,
    aircraftIcao: 'B738',
  });
  await recorder.start();
  for (const sample of samples) adapter.pushSample(sample);
  await recorder.stop();
  await recorder.stop();
  return { warn, stats: buffer.loadFlights()[0]?.stats ?? {} };
}

function atcWarnings(warn: ReturnType<typeof vi.fn>): unknown[][] {
  return warn.mock.calls.filter(([message]) => message === 'ATC runway data missing at touchdown');
}

describe('FlightRecorder MSFS ATC runway diagnostics', () => {
  it('warns once and sets the flag when ATC values are missing', async () => {
    const { warn, stats } = await record(landingSamples({}));

    expect(atcWarnings(warn)).toEqual([
      ['ATC runway data missing at touchdown', { reason: 'missing', aglFt: 0, gsKt: 120 }],
    ]);
    expect(stats.atc_runway_missing).toBe(true);
    expect(stats.sim_runway).toBeUndefined();
  });

  it('warns once and sets the flag when ATC values are zeroed', async () => {
    const { warn, stats } = await record(landingSamples(ATC_ZERO));

    expect(atcWarnings(warn)).toHaveLength(1);
    expect(atcWarnings(warn)[0]?.[1]).toMatchObject({ reason: 'zero' });
    expect(stats.atc_runway_missing).toBe(true);
  });

  it('warns once and sets the flag when the ATC heading is absent', async () => {
    const { warn, stats } = await record(
      landingSamples({ ...ATC_FULL, atc_runway_heading_deg: null }),
    );

    expect(atcWarnings(warn)).toHaveLength(1);
    expect(atcWarnings(warn)[0]?.[1]).toMatchObject({ reason: 'no_heading' });
    expect(stats.atc_runway_missing).toBe(true);
  });

  it('does not warn or set the flag when full ATC values are present', async () => {
    const { warn, stats } = await record(landingSamples(ATC_FULL));

    expect(atcWarnings(warn)).toHaveLength(0);
    expect(stats.atc_runway_missing).toBeUndefined();
    expect(stats.sim_runway).toBeDefined();
  });
});
