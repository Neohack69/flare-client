import { describe, expect, it, vi } from 'vitest';

import { MemoryOutboxBuffer } from '../buffer/memory-buffer.js';
import { MockSimConnectAdapter } from '../sim/mock-adapter.js';
import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';
import { seededUuidGenerator } from '../util/id.js';
import { FlightRecorder } from './recorder.js';

function at(offsetS: number, overrides: Parameters<typeof makeSample>[1] = {}) {
  return makeSample(isoAt(BASE_MS, offsetS * 1000), overrides);
}

describe('P2: карантин загрузки и телепорт', () => {
  it('после коннекта не стартует 4 с и ждёт 2 устойчивых кадра', async () => {
    const adapter = new MockSimConnectAdapter();
    const recorder = new FlightRecorder({
      adapter,
      buffer: new MemoryOutboxBuffer(),
      idGenerator: seededUuidGenerator(),
      autoWatchdog: false,
    });
    await recorder.start();

    adapter.pushSample(at(0, { on_ground: true, alt_ft: 600 }));
    adapter.pushSample(at(3, { on_ground: true, alt_ft: 600 }));
    expect(recorder.state.recording).toBe(false);

    adapter.pushSample(at(4.1, { on_ground: true, alt_ft: 600 }));
    expect(recorder.state.recording).toBe(false);

    adapter.pushSample(at(5.1, { on_ground: true, alt_ft: 600 }));
    expect(recorder.state.recording).toBe(true);

    await recorder.stop();
  });

  it('скачок высоты в записи → discarded (teleport), без посадок и баллов', async () => {
    const adapter = new MockSimConnectAdapter();
    const buffer = new MemoryOutboxBuffer();
    const warn = vi.fn();
    const recorder = new FlightRecorder({
      adapter,
      buffer,
      idGenerator: seededUuidGenerator(),
      autoWatchdog: false,
      loadQuarantineS: 0,
      warn,
    });
    const ended = vi.fn();
    const scores = vi.fn();
    recorder.on('flight_ended', ended);
    recorder.on('score', scores);
    await recorder.start();

    adapter.pushSample(at(0, { on_ground: true, alt_ft: 600, gs_kt: 0 }));
    expect(recorder.state.recording).toBe(true);

    // Загрузка/телепорт: 31 274 ft → 294 ft за один кадр.
    adapter.pushSample(
      at(1, { on_ground: false, alt_ft: 31_274, agl_ft: 31_000, gs_kt: 55, vs_fpm: -4 }),
    );
    adapter.pushSample(at(1.5, { on_ground: true, alt_ft: 294, agl_ft: 13.5, gs_kt: 0, g: 0.94 }));

    await recorder.stop();

    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]?.[0]).toMatchObject({
      discarded: true,
      discard_reason: 'no_flight_evidence',
    });
    expect(scores).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.filter(([message]) => message === 'position glitch (frame skipped, flight kept)'),
    ).toHaveLength(1);
  });
});

describe('position glitch (single frame) is not a reason to discard a flight', () => {
  it('glitch at cruise keeps the flight and the landing', async () => {
    const adapter = new MockSimConnectAdapter();
    const buffer = new MemoryOutboxBuffer();
    const warn = vi.fn();
    const recorder = new FlightRecorder({
      adapter,
      buffer,
      idGenerator: seededUuidGenerator(),
      autoWatchdog: false,
      loadQuarantineS: 0,
      endEngineOffS: 3,
      endStationaryS: 600,
      aircraftIcao: 'B738',
      warn,
    });
    const ended = vi.fn();
    const scores = vi.fn();
    recorder.on('flight_ended', ended);
    recorder.on('score', scores);
    await recorder.start();

    adapter.pushSample(at(0, { on_ground: true, gs_kt: 0, engine_running: true }));
    for (let t = 1; t <= 8; t += 1) {
      adapter.pushSample(at(t, { on_ground: true, gs_kt: 25, engine_running: true }));
    }
    // Takeoff and climb (credible liftoff).
    for (let t = 9; t <= 30; t += 1) {
      adapter.pushSample(
        at(t, { on_ground: false, agl_ft: 300, vs_fpm: -500, gs_kt: 150, ias_kt: 140, g: 1.05 }),
      );
    }
    // Single-frame coordinate glitch: ~136 m in 70 ms (~3700 kt).
    adapter.pushSample(
      at(30.07, {
        on_ground: false,
        agl_ft: 300,
        vs_fpm: -500,
        gs_kt: 150,
        ias_kt: 140,
        g: 1.05,
        lat: 55.973,
        lon: 37.415,
      }),
    );
    // Continue the approach from the re-baselined position and land.
    for (let t = 31; t <= 38; t += 1) {
      adapter.pushSample(
        at(t, {
          on_ground: false,
          agl_ft: 300,
          vs_fpm: -500,
          gs_kt: 150,
          ias_kt: 140,
          g: 1.05,
          lat: 55.973,
          lon: 37.415,
        }),
      );
    }
    adapter.pushSample(
      at(39, {
        on_ground: true,
        agl_ft: 0,
        vs_fpm: 0,
        g: 1.0,
        gs_kt: 120,
        lat: 55.973,
        lon: 37.415,
      }),
    );
    adapter.pushSample(
      at(40, {
        on_ground: true,
        agl_ft: 0,
        gs_kt: 0,
        engine_running: false,
        lat: 55.973,
        lon: 37.415,
      }),
    );
    adapter.pushSample(
      at(43, {
        on_ground: true,
        agl_ft: 0,
        gs_kt: 0,
        engine_running: false,
        lat: 55.973,
        lon: 37.415,
      }),
    );

    expect(ended).toHaveBeenCalledTimes(1);
    const info = ended.mock.calls[0]?.[0] as {
      discarded: boolean;
      landings_count: number;
      discard_reason: string | null;
    };
    expect(info).toMatchObject({ discarded: false, landings_count: 1 });
    expect(scores).toHaveBeenCalled();
    expect(
      warn.mock.calls.filter(
        ([message]) => message === 'position glitch (frame skipped, flight kept)',
      ),
    ).toHaveLength(1);
    const flight = buffer.loadFlights()[0];
    expect(flight?.stats.no_flight_evidence).toBe(false);
    expect(flight?.stats.position_glitch).not.toBeNull();
    await recorder.stop();
  });
});