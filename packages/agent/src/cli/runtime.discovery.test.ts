import { describe, expect, it, vi } from 'vitest';

import { MemoryOutboxBuffer } from '../buffer/memory-buffer.js';
import type { FlightRecorderEvents, RecorderState } from '../flight/recorder.js';
import type {
  SimRediscoveryOutcome,
  SimRediscoveryReason,
  SimSessionDiscovery,
} from '../sim/session.js';
import type { SimSourceOpenInfo } from '../sim/source.js';
import { MemoryTokenStore, type StoredTokens } from '../sync/token-store.js';
import type { FlushSummary } from '../sync/uploader.js';
import { TypedEmitter } from '../util/emitter.js';
import { AgentRuntime, type RuntimeRecorder } from './runtime.js';
import type { AgentConfig } from './config.js';

const TOKENS: StoredTokens = {
  access_token: 'access-1',
  device_token: 'device-1',
  device_id: '99999999-9999-4999-8999-999999999999',
};

const FLUSH_SUMMARY: FlushSummary = {
  flights_processed: 0,
  flights_completed: 0,
  flights_abandoned: 0,
  points_uploaded: 0,
  events_uploaded: 0,
  pending_flights: 0,
  pending_points: 0,
  pending_events: 0,
};

const OPEN_INFO: SimSourceOpenInfo = {
  applicationName: 'Microsoft Flight Simulator 2024',
  applicationVersion: '1.39.9.0',
  simConnectVersion: '0.0.0.0',
  sim: 'msfs2024',
  simVersion: '1.39.9',
  adapter: 'simconnect-sunrise',
  protocol: 'sunrise',
};

const STATE: RecorderState = {
  phase: 'on_ground',
  recording: false,
  client_flight_id: null,
  seq: 0,
  point_count: 0,
  event_count: 0,
  bounce_count: 0,
  landing_count: 0,
  touch_and_go_count: 0,
  on_ground: true,
  rate_hz: 1,
  score_preview: null,
  metrics: null,
};

class FakeRecorder extends TypedEmitter<FlightRecorderEvents> implements RuntimeRecorder {
  state = { ...STATE };
  readonly start = vi.fn(async (): Promise<SimSourceOpenInfo> => OPEN_INFO);
  readonly stop = vi.fn(async (): Promise<void> => undefined);

  emitDisconnect(reason?: string): void {
    this.emit('disconnect', reason);
  }
}

function makeDiscovery() {
  const calls: SimRediscoveryReason[] = [];
  const rediscover = vi.fn(async (reason: SimRediscoveryReason): Promise<SimRediscoveryOutcome> => {
    calls.push(reason);
    return {
      status: 'unchanged',
      from: 'msfs2024',
      to: 'msfs2024',
      reason,
      attempted: [],
      nextProbeInMs: 0,
    };
  });
  const discovery: SimSessionDiscovery = {
    rediscover,
    snapshot: () => ({
      sourceId: 'msfs2024',
      connected: false,
      pinned: false,
      preference: 'auto',
      lastSampleAt: null,
      info: null,
    }),
  };
  return { discovery, rediscover, calls };
}

function manualSleep() {
  const waiting: Array<() => void> = [];
  const sleep = (): Promise<void> =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  const release = async (): Promise<void> => {
    const resolve = waiting.shift();
    resolve?.();
    await settle(4);
  };
  return { sleep, release, pending: () => waiting.length };
}

async function settle(times = 2): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

const CONFIG: AgentConfig = {
  apiUrl: 'https://api.test',
  tokenStorePath: 'token.json',
  outboxPath: 'outbox.sqlite',
  clientName: 'Test Agent',
  platform: 'win32',
  aircraftIcao: null,
  protocol: 'sunrise',
  maxSampleHz: 10,
  syncIntervalMs: 3_600_000,
  connectPollMs: 60_000,
  reconnectBaseMs: 1,
  reconnectMaxMs: 1,
  shutdownFlushMs: 0,
  logLevel: 'silent',
};

function makeRuntime(
  recorder: FakeRecorder,
  discovery: SimSessionDiscovery,
  sleep: () => Promise<void>,
  threshold = 2,
) {
  return new AgentRuntime(CONFIG, {
    adapter: { connected: false },
    recorder,
    buffer: new MemoryOutboxBuffer(),
    tokenStore: new MemoryTokenStore(TOKENS),
    auth: { authorize: async () => TOKENS },
    uploader: { flush: async () => FLUSH_SUMMARY },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    simSourceId: 'msfs2024',
    simDiscovery: discovery,
    discoveryFailureThreshold: threshold,
    sleep,
  });
}

describe('AgentRuntime re-discovery (SIM-REDISCOVER-1)', () => {
  it('после N неудачных connect запускает re-discovery (не на каждой ошибке)', async () => {
    const recorder = new FakeRecorder();
    recorder.start.mockRejectedValue(new Error('ECONNREFUSED'));
    const { discovery, rediscover } = makeDiscovery();
    const { sleep, release } = manualSleep();
    const runtime = makeRuntime(recorder, discovery, sleep, 2);

    await runtime.start();
    await settle(4);
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(rediscover).not.toHaveBeenCalled();

    await release();
    expect(recorder.start).toHaveBeenCalledTimes(2);
    expect(rediscover).toHaveBeenCalledTimes(1);
    expect(rediscover).toHaveBeenCalledWith('connect_failures');

    // После порога каждый провал просит сессию о повторном поиске; частоту
    // реальных проб ограничивает cooldown сессии (см. session.test.ts).
    await release();
    expect(recorder.start).toHaveBeenCalledTimes(3);
    expect(rediscover).toHaveBeenCalledTimes(2);

    await release();
    expect(recorder.start).toHaveBeenCalledTimes(4);
    expect(rediscover).toHaveBeenCalledTimes(3);

    await runtime.stop('test');
  });

  it('разрыв соединения запускает re-discovery источника', async () => {
    const recorder = new FakeRecorder();
    const { discovery, rediscover } = makeDiscovery();
    const { sleep } = manualSleep();
    const runtime = makeRuntime(recorder, discovery, sleep);

    await runtime.start();
    await settle(4);
    expect(recorder.start).toHaveBeenCalledTimes(1);

    recorder.emitDisconnect('sim closed');
    await settle(4);

    expect(rediscover).toHaveBeenCalledTimes(1);
    expect(rediscover).toHaveBeenCalledWith('disconnect');

    await runtime.stop('test');
  });

  it('без сессии (legacy) разрыв не вызывает re-discovery', async () => {
    const recorder = new FakeRecorder();
    const { sleep } = manualSleep();
    const runtime = new AgentRuntime(CONFIG, {
      adapter: { connected: false },
      recorder,
      buffer: new MemoryOutboxBuffer(),
      tokenStore: new MemoryTokenStore(TOKENS),
      auth: { authorize: async () => TOKENS },
      uploader: { flush: async () => FLUSH_SUMMARY },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      sleep,
    });

    await runtime.start();
    await settle(4);
    recorder.emitDisconnect('sim closed');
    await settle(4);
    await runtime.stop('test');
    // поведение прежнее: без сессии источник не переизбирается
    expect(recorder.stop).toHaveBeenCalled();
  });
});
