import { describe, expect, it, vi } from 'vitest';

import { MemoryOutboxBuffer } from '../buffer/memory-buffer.js';
import { FlightRecorder } from '../flight/recorder.js';
import { MockSimConnectAdapter } from '../sim/mock-adapter.js';
import { FakeApiServer } from '../testing/fake-api-server.js';
import { seedCompletedFlight } from '../testing/seed-flight.js';
import { BASE_MS } from '../testing/telemetry-fixture.js';
import { MemoryTokenStore, type StoredTokens } from '../sync/token-store.js';
import { FlightUploader } from '../sync/uploader.js';
import { seededUuidGenerator } from '../util/id.js';
import type { AgentConfig } from './config.js';
import type { Logger } from './logger.js';
import { AgentRuntime, type CloseableOutboxBuffer } from './runtime.js';

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
  aircraftIcao: 'DA62',
  protocol: 'sunrise',
  maxSampleHz: 10,
  syncIntervalMs: 3_600_000,
  connectPollMs: 3_600_000,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 1000,
  shutdownFlushMs: 1000,
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

async function eventually(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeBuffer(): CloseableOutboxBuffer & { close: ReturnType<typeof vi.fn> } {
  return Object.assign(new MemoryOutboxBuffer(), { close: vi.fn() });
}

describe('AgentRuntime: восстановление outbox при рестарте (без сима)', () => {
  it('startup-flush выгружает завершённый pending-рейс, даже если сим недоступен', async () => {
    const adapter = new MockSimConnectAdapter();
    const connectSpy = vi.spyOn(adapter, 'connect').mockRejectedValue(
      new Error('SimConnect not available'),
    );
    const buffer = makeBuffer();
    const server = new FakeApiServer();
    const tokenStore = new MemoryTokenStore(TOKENS);
    const auth = { authorize: vi.fn(async () => TOKENS), refresh: vi.fn(async () => TOKENS) };
    seedCompletedFlight(buffer, { idGenerator: seededUuidGenerator(), points: 7, events: 2 });
    expect(buffer.pendingCounts().pendingPoints).toBe(7);

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
      aircraftIcao: 'DA62',
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
    await eventually(() => server.completed.size === 1);

    expect(adapter.connected).toBe(false);
    expect(connectSpy).toHaveBeenCalled();
    expect(server.flights.size).toBe(1);
    expect(server.points.size).toBe(7);
    expect(server.events.size).toBe(2);
    const pending = buffer.pendingCounts();
    expect(pending.pendingFlights).toBe(0);
    expect(pending.pendingPoints).toBe(0);
    expect(pending.pendingEvents).toBe(0);

    await runtime.stop('test');
  });
});
