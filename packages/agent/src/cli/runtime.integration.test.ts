import { describe, expect, it, vi } from 'vitest';

import { MemoryOutboxBuffer } from '../buffer/memory-buffer.js';
import { FlightRecorder } from '../flight/recorder.js';
import { MockSimConnectAdapter } from '../sim/mock-adapter.js';
import type { TelemetrySample } from '../sim/types.js';
import { FakeApiServer } from '../testing/fake-api-server.js';
import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';
import { seededUuidGenerator } from '../util/id.js';
import { MemoryTokenStore, type StoredTokens } from '../sync/token-store.js';
import { FlightUploader, type FlushSummary } from '../sync/uploader.js';
import type { AgentConfig } from './config.js';
import type { Logger } from './logger.js';
import { AgentRuntime, type CloseableOutboxBuffer, type RuntimeUploader } from './runtime.js';

const TOKENS: StoredTokens = {
  access_token: 'access-1',
  device_token: 'device-1',
  device_id: '99999999-9999-4999-8999-999999999999',
};

const CONFIG: AgentConfig = {
  apiUrl: 'https://api.test',
  tokenStorePath: 'token.json',
  outboxPath: 'outbox.sqlite',
  clientName: 'Test Agent',
  platform: 'win32',
  aircraftIcao: 'B738',
  protocol: 'sunrise',
  maxSampleHz: 10,
  syncIntervalMs: 3_600_000,
  connectPollMs: 3_600_000,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 1000,
  shutdownFlushMs: 5000,
  logLevel: 'silent',
};

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeSleep(): { sleep: (ms: number) => Promise<void>; release: () => void } {
  const resolvers: Array<() => void> = [];
  return {
    sleep: () =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
      }),
    release: () => {
      resolvers.shift()?.();
    },
  };
}

/** Полёт: стоянка → руление → взлёт → круиз → касание → остановка (двигатель off). */
function buildTimeline(): TelemetrySample[] {
  const samples: TelemetrySample[] = [];
  const at = (offsetS: number, overrides: Partial<TelemetrySample> = {}): void => {
    samples.push(makeSample(isoAt(BASE_MS, offsetS * 1000), overrides));
  };

  at(0, { gs_kt: 0, on_ground: true, alt_ft: 600 });
  at(2, { gs_kt: 15, on_ground: true, alt_ft: 600 });
  at(6, { gs_kt: 60, on_ground: true, alt_ft: 600 });
  at(8, { gs_kt: 100, on_ground: false, agl_ft: 30, vs_fpm: 800, alt_ft: 650 });
  // Набор/снижение по кадрам: скачок >5 000 ft за сэмпл считается телепортом.
  for (let s = 9; s <= 15; s += 1) {
    at(s, {
      gs_kt: 250,
      on_ground: false,
      agl_ft: 4_500 * (s - 8) + 30,
      vs_fpm: 2_500,
      alt_ft: 650 + 4_500 * (s - 8),
    });
  }
  for (let s = 16; s <= 40; s += 1) {
    at(s, { gs_kt: 440, on_ground: false, agl_ft: 30_000, vs_fpm: 0, alt_ft: 30_600 });
  }
  for (let s = 41; s <= 44; s += 1) {
    at(s, {
      gs_kt: 300,
      on_ground: false,
      agl_ft: 30_600 - 5_000 * (s - 40) - 600,
      vs_fpm: -3_000,
      alt_ft: 30_600 - 5_000 * (s - 40),
    });
  }
  at(44.5, { gs_kt: 200, on_ground: false, agl_ft: 5_000, vs_fpm: -1_500, alt_ft: 5_600 });
  at(45, { gs_kt: 150, on_ground: false, agl_ft: 400, vs_fpm: -700, alt_ft: 1_000 });
  for (let i = 0; i < 10; i += 1) {
    at(46 + i * 0.1, {
      gs_kt: 140,
      on_ground: false,
      agl_ft: 80 - i * 8,
      vs_fpm: -450,
      g: 1.05,
    });
  }
  at(47, { gs_kt: 120, on_ground: true, agl_ft: 0, vs_fpm: -180, g: 1.35 });
  at(48, { gs_kt: 60, on_ground: true, agl_ft: 0, vs_fpm: 0, g: 1.0 });
  at(60, { gs_kt: 0, on_ground: true, vs_fpm: 0, engine_running: false });
  at(64, { gs_kt: 0, on_ground: true, vs_fpm: 0, engine_running: false });
  return samples;
}

async function settle(times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function makeBuffer(): CloseableOutboxBuffer & { close: ReturnType<typeof vi.fn> } {
  return Object.assign(new MemoryOutboxBuffer(), { close: vi.fn() });
}

describe('AgentRuntime + FlightRecorder + FlightUploader (интеграция на моках)', () => {
  it('записывает полноценный рейс и заливает его батчами + /complete', async () => {
    const adapter = new MockSimConnectAdapter();
    const buffer = makeBuffer();
    const server = new FakeApiServer();
    const tokenStore = new MemoryTokenStore(TOKENS);
    const refresh = vi.fn(async () => ({ ...TOKENS, access_token: 'access-2' }));
    const auth = { authorize: vi.fn(async () => TOKENS), refresh };
    const uploader = new FlightUploader({
      apiBaseUrl: 'https://api.test',
      http: server.asHttpClient(),
      buffer,
      tokenStore,
      auth,
      now: () => BASE_MS,
      retry: { random: () => 1 },
    });
    const recorder = new FlightRecorder({
      loadQuarantineS: 0,
      adapter,
      buffer,
      idGenerator: seededUuidGenerator(),
      aircraftIcao: 'B738',
      endEngineOffS: 3,
      endStationaryS: 600,
      autoWatchdog: false,
    });
    const sleep = makeSleep();
    const runtime = new AgentRuntime(CONFIG, {
      adapter,
      recorder,
      buffer,
      tokenStore,
      auth,
      uploader,
      logger: silentLogger,
      sleep: sleep.sleep,
      random: () => 1,
    });

    await runtime.start();
    await settle(2);
    expect(adapter.connected).toBe(true);

    for (const sample of buildTimeline()) adapter.pushSample(sample);
    await settle(6);

    expect(server.flights.size).toBe(1);
    const [flight] = [...server.flights.values()];
    expect(flight).toBeDefined();
    if (flight) {
      expect(server.completed.has(flight.id)).toBe(true);
    }
    expect(server.points.size).toBeGreaterThan(0);
    expect(server.events.size).toBeGreaterThan(0);

    await runtime.stop('test');
    expect(buffer.close).toHaveBeenCalledTimes(1);
  });

  it('переподключается после разрыва связи с симом', async () => {
    const adapter = new MockSimConnectAdapter();
    const buffer = makeBuffer();
    const emptySummary: FlushSummary = {
      flights_processed: 0,
      flights_completed: 0,
      flights_abandoned: 0,
      points_uploaded: 0,
      events_uploaded: 0,
      pending_flights: 0,
      pending_points: 0,
      pending_events: 0,
    };
    const uploader: RuntimeUploader = { flush: vi.fn(async () => emptySummary) };
    const recorder = new FlightRecorder({
      loadQuarantineS: 0,
      adapter,
      buffer,
      idGenerator: seededUuidGenerator(),
      aircraftIcao: 'B738',
      autoWatchdog: false,
    });
    const startSpy = vi.spyOn(recorder, 'start');
    const sleep = makeSleep();
    const runtime = new AgentRuntime(CONFIG, {
      adapter,
      recorder,
      buffer,
      tokenStore: new MemoryTokenStore(TOKENS),
      auth: { authorize: vi.fn(async () => TOKENS) },
      uploader,
      logger: silentLogger,
      sleep: sleep.sleep,
      random: () => 1,
    });

    await runtime.start();
    await settle(2);
    expect(startSpy).toHaveBeenCalledTimes(1);

    adapter.simulateDisconnect('sim closed');
    sleep.release();
    await settle(2);

    expect(startSpy).toHaveBeenCalledTimes(2);
    await runtime.stop('test');
  });
});
