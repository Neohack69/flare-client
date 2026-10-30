import { QUALITY_BITS } from '@flightlog/contracts';
import { analyzeTrackIntegrity } from '@flightlog/scoring';
import { describe, expect, it } from 'vitest';

import { MemoryOutboxBuffer } from '../buffer/memory-buffer.js';
import { MockSimConnectAdapter } from '../sim/mock-adapter.js';
import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';
import { seededUuidGenerator } from '../util/id.js';
import type { TelemetrySample } from '../sim/types.js';
import { FlightRecorder } from './recorder.js';

/** Чистая посадка: 10 Гц заход, касание t=39, пробег (как в recorder.test). */
function cleanLandingSamples(): TelemetrySample[] {
  const samples: TelemetrySample[] = [];
  const at = (offsetS: number, overrides: Parameters<typeof makeSample>[1] = {}) => {
    samples.push(makeSample(isoAt(BASE_MS, offsetS * 1000), overrides));
  };
  at(0, { gs_kt: 0, on_ground: true, engine_running: true });
  for (let t = 1; t <= 8; t += 1) at(t, { gs_kt: 25, on_ground: true, engine_running: true });
  for (let i = 0; i <= 290; i += 1) {
    at(Number((9 + i * 0.1).toFixed(6)), {
      on_ground: false,
      agl_ft: 300,
      vs_fpm: -500,
      gs_kt: 150,
      ias_kt: 140,
      g: 1.05,
    });
  }
  at(39, { on_ground: true, agl_ft: 0, vs_fpm: -180, g: 1.3, gs_kt: 120 });
  at(40, { on_ground: true, gs_kt: 60, vs_fpm: 0 });
  at(41, { on_ground: true, gs_kt: 20, vs_fpm: 0 });
  return samples;
}

interface IntegrityPointLike {
  ts: string;
  seq: number;
  lat?: number | null;
  lon?: number | null;
  gs_kt?: number | null;
  vs_fpm?: number | null;
  g?: number | null;
  alt_ft?: number | null;
}

function integrityOf(points: readonly IntegrityPointLike[]) {
  return analyzeTrackIntegrity(
    points.map((p) => ({
      ts: p.ts,
      seq: p.seq,
      lat: p.lat ?? null,
      lon: p.lon ?? null,
      groundspeed_kt: p.gs_kt ?? null,
      vertical_speed_fpm: p.vs_fpm ?? null,
      g_force: p.g ?? null,
      altitude_ft: p.alt_ft ?? null,
    })),
  );
}

describe('R6.1: integrity реального трека агента', () => {
  it('backfill окна касания не даёт ложного CLOCK_INVALID', async () => {
    const adapter = new MockSimConnectAdapter();
    const buffer = new MemoryOutboxBuffer();
    const recorder = new FlightRecorder({
      loadQuarantineS: 0,
      adapter,
      buffer,
      idGenerator: seededUuidGenerator(),
      endEngineOffS: 3,
      endStationaryS: 600,
      aircraftIcao: 'B738',
    });
    await recorder.start();
    for (const sample of cleanLandingSamples()) adapter.pushSample(sample);
    const flightId = recorder.state.client_flight_id ?? '';
    const points = buffer.loadPoints(flightId);
    // Точки существуют и содержат backfill (поздний seq при более раннем ts).
    expect(points.length).toBeGreaterThan(100);

    const integrity = integrityOf(points);
    expect(integrity.ts_inversions).toBe(0);
    expect(integrity.flags & QUALITY_BITS.CLOCK_INVALID).toBe(0);
    await recorder.stop();
  });

  it('реальная подмена часов (откат ts на 75 с) всё ещё ловится', async () => {
    const adapter = new MockSimConnectAdapter();
    const buffer = new MemoryOutboxBuffer();
    const recorder = new FlightRecorder({
      loadQuarantineS: 0,
      adapter,
      buffer,
      idGenerator: seededUuidGenerator(),
      endEngineOffS: 3,
      endStationaryS: 600,
      aircraftIcao: 'B738',
    });
    await recorder.start();
    for (const sample of cleanLandingSamples()) adapter.pushSample(sample);
    const flightId = recorder.state.client_flight_id ?? '';
    const points = buffer.loadPoints(flightId).map((point) => ({ ...point }));
    const middle = Math.floor(points.length / 2);
    const target = points[middle];
    expect(target).toBeDefined();
    if (target) target.ts = new Date(Date.parse(target.ts) - 75_000).toISOString();

    const integrity = integrityOf(points);
    expect(integrity.flags & QUALITY_BITS.CLOCK_INVALID).toBe(QUALITY_BITS.CLOCK_INVALID);
    await recorder.stop();
  });
});
