import { describe, expect, it, vi } from 'vitest';

import type { AgentStatusEvent } from '@flightlog/contracts';

import { MemoryOutboxBuffer } from '../buffer/memory-buffer.js';
import type { AgentConfig } from '../cli/config.js';
import type { FlightRecorderEvents, FlightStartedInfo, RecorderState } from '../flight/recorder.js';
import type { TouchdownEvent } from '../flight/touchdown.js';
import { MockSimConnectAdapter } from '../sim/mock-adapter.js';
import type { SimConnectOpenInfo } from '../sim/types.js';
import { MemoryTokenStore, type StoredTokens } from '../sync/token-store.js';
import { NotAuthorizedError, SyncError, type FlushSummary } from '../sync/uploader.js';
import {
  type CloseableOutboxBuffer,
  type RuntimeRecorder,
  type RuntimeUploader,
} from '../cli/runtime.js';
import { bootstrapAgent, type BootstrapAuth } from './bootstrap.js';

// Тест-изоляция: `bootstrapAgent` в фоне прогревает глобальный индекс
// `aircraft.cfg` (`getDefaultAircraftCfgIndex().ensureBuilt()`), который ходит по
// реальным Community-каталогам (`D:\MSFS2024_Addons`, `%APPDATA%\...\Community`).
// Синхронный walk по ФС блокирует event loop на секунды; под параллельной
// нагрузкой он перебивал дефолтный таймаут (fail 6226 ms / 5000 ms). Прогрев к
// сценарию bootstrap не относится — подменяем индекс no-op, чтобы тест был
// детерминированным и не зависел от машины/диска.
vi.mock('../flight/aircraft-config.js', () => ({
  getDefaultAircraftCfgIndex: () => ({ ensureBuilt: () => undefined }),
  defaultIcaoTypeDesignatorLookup: () => null,
}));

const DEVICE_ID = '99999999-9999-4999-8999-999999999999';
const TOKENS: StoredTokens = {
  access_token: 'access-1',
  device_token: 'device-1',
  device_id: DEVICE_ID,
};
const OPEN_INFO: SimConnectOpenInfo = {
  applicationName: 'Microsoft Flight Simulator 2024',
  applicationVersion: '1.39.9.0',
  simConnectVersion: '0.0.0.0',
};
const FLUSH_SUMMARY: FlushSummary = {
  flights_processed: 1,
  flights_completed: 1,
  flights_abandoned: 0,
  points_uploaded: 10,
  events_uploaded: 1,
  pending_flights: 0,
  pending_points: 0,
  pending_events: 0,
};
const STARTED_INFO: FlightStartedInfo = {
  client_flight_id: '11111111-1111-4111-8111-111111111111',
  started_at: '2026-09-23T12:00:00.000Z',
  aircraft_icao: 'B738',
  aircraft_icao_source: 'atc_type',
};

class FakeRecorder implements RuntimeRecorder {
  readonly start = vi.fn(async (): Promise<SimConnectOpenInfo> => OPEN_INFO);
  readonly stop = vi.fn(async (): Promise<void> => undefined);

  state: RecorderState = {
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

  private readonly handlers = new Map<
    keyof FlightRecorderEvents,
    Set<(payload: unknown) => void>
  >();

  on<K extends keyof FlightRecorderEvents>(event: K, handler: FlightRecorderEvents[K]): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as unknown as (payload: unknown) => void);
  }

  off<K extends keyof FlightRecorderEvents>(event: K, handler: FlightRecorderEvents[K]): void {
    this.handlers.get(event)?.delete(handler as unknown as (payload: unknown) => void);
  }

  emit<K extends keyof FlightRecorderEvents>(
    event: K,
    ...args: Parameters<FlightRecorderEvents[K]>
  ): void {
    for (const handler of this.handlers.get(event) ?? []) handler(args[0]);
  }
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    apiUrl: 'https://api.test',
    tokenStorePath: 'token.json',
    outboxPath: 'outbox.sqlite',
    clientName: 'Test Agent',
    platform: 'win32',
    aircraftIcao: null,
    protocol: 'sunrise',
    maxSampleHz: 10,
    syncIntervalMs: 3_600_000,
    connectPollMs: 3_600_000,
    reconnectBaseMs: 1000,
    reconnectMaxMs: 1000,
    shutdownFlushMs: 1000,
    logLevel: 'silent',
    ...overrides,
  };
}

function silentLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function makeBuffer(): CloseableOutboxBuffer & { close: ReturnType<typeof vi.fn> } {
  return Object.assign(new MemoryOutboxBuffer(), { close: vi.fn() });
}

async function settle(times = 2): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function makeAgent(
  options: {
    recorder?: FakeRecorder;
    uploaderFlush?: RuntimeUploader['flush'];
    auth?: BootstrapAuth;
    onStatus?: (event: AgentStatusEvent) => void;
    buffer?: ReturnType<typeof makeBuffer>;
  } = {},
) {
  const recorder = options.recorder ?? new FakeRecorder();
  const buffer = options.buffer ?? makeBuffer();
  const adapter = new MockSimConnectAdapter();
  const tokenStore = new MemoryTokenStore(TOKENS);
  const auth: BootstrapAuth = options.auth ?? {
    authorize: vi.fn(async () => TOKENS),
    refresh: vi.fn(async () => TOKENS),
  };
  const uploader: RuntimeUploader = {
    flush: options.uploaderFlush ?? vi.fn(async () => FLUSH_SUMMARY),
  };
  const agent = await bootstrapAgent({
    config: makeConfig(),
    recorder,
    buffer,
    adapter,
    tokenStore,
    auth,
    uploader,
    logger: silentLogger(),
    onStatus: options.onStatus,
  });
  return { agent, recorder, buffer, adapter, uploader };
}

describe('bootstrapAgent (фабрика agent-host, ADR-0011 §2.1)', () => {
  it('собирает runtime и позволяет остановить/закрыть буфер через dispose', async () => {
    const { agent, recorder, buffer } = await makeAgent();

    expect(agent.runtime).toBeDefined();
    expect(agent.config.protocol).toBe('sunrise');

    await agent.start();
    await settle();
    await agent.dispose('test');

    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(buffer.close).toHaveBeenCalledTimes(1);
  });

  it('переиспользует переданный adapter/recorder/tokenStore без дублирования', async () => {
    const { agent, adapter, recorder } = await makeAgent();
    expect(agent.adapter).toBe(adapter);
    expect(agent.recorder).toBe(recorder);
  });

  it('эмитит статусы жизненного цикла: sim_waiting → connected_idle → recording → touchdown → sync_ok', async () => {
    const statuses: AgentStatusEvent[] = [];
    const { agent, recorder } = await makeAgent({
      onStatus: (event) => statuses.push(event),
    });
    recorder.start.mockImplementation(async () => {
      (agent.adapter as MockSimConnectAdapter).connect();
      return OPEN_INFO;
    });

    await agent.start();
    await settle(3);

    recorder.emit('flight_started', STARTED_INFO);
    const touchdown: TouchdownEvent = {
      kind: 'touchdown',
      ts: '2026-09-23T12:29:00.000Z',
      metrics: {
        vs_fpm: -180,
        g_force: 1.2,
        bounce_count: 0,
        bounced: false,
        aircraft_icao: 'B738',
      },
      score: {
        score: 84,
        grade: 'good',
        components: {},
        policy: 'best',
        score_version: '1.0.0',
      },
      bounceCount: 0,
    } as unknown as TouchdownEvent;
    recorder.emit('score', touchdown);
    await settle(2);

    const states = statuses.map((event) => event.state);
    expect(states).toContain('sim_waiting');
    expect(states).toContain('connected_idle');
    expect(states).toContain('recording');
    expect(states).toContain('touchdown');
    expect(states).toContain('sync_ok');

    const recording = statuses.find((event) => event.state === 'recording');
    expect(recording?.flightId).toBe(STARTED_INFO.client_flight_id);
    expect(recording?.deviceId).toBe(DEVICE_ID);
    expect(recording?.pendingCounts).toBeDefined();

    await agent.dispose('test');
  });

  it('эмитит sync_error при сетевой ошибке, но не падает', async () => {
    const statuses: AgentStatusEvent[] = [];
    const { agent } = await makeAgent({
      onStatus: (event) => statuses.push(event),
      uploaderFlush: vi.fn(async () => {
        throw new SyncError('network down', { retryable: true });
      }),
    });

    await agent.start();
    await settle(3);

    expect(statuses.some((event) => event.state === 'sync_error')).toBe(true);
    await agent.dispose('test');
  });

  it('при потере авторизации на синке повторно запускает device flow', async () => {
    const refresh = vi.fn(async () => TOKENS);
    const authorize = vi.fn(async () => TOKENS);
    const statuses: AgentStatusEvent[] = [];
    const auth: BootstrapAuth = { authorize, refresh };
    const { agent } = await makeAgent({
      auth,
      onStatus: (event) => statuses.push(event),
      uploaderFlush: vi
        .fn<RuntimeUploader['flush']>()
        .mockRejectedValueOnce(new NotAuthorizedError())
        .mockResolvedValue(FLUSH_SUMMARY),
    });

    await agent.start();
    await settle(4);

    expect(authorize).toHaveBeenCalledTimes(1);
    await agent.dispose('test');
  });

  it('не эмитит статусы без onStatus (обратная совместимость CLI)', async () => {
    const { agent } = await makeAgent();
    await agent.start();
    await settle();
    await agent.dispose('test');
    // Без колбэка поведение прежнее: рантайм стартует и останавливается.
    expect(agent.runtime).toBeDefined();
  });
});
