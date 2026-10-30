import { describe, expect, it, vi } from 'vitest';

import type {
  LandingMetrics,
  LandingScore,
  TouchdownPreviewRequest,
  TouchdownPreviewResponse,
} from '@flightlog/contracts';

import { MemoryOutboxBuffer } from '../buffer/memory-buffer.js';
import type {
  FlightEndedInfo,
  FlightRecorderEvents,
  FlightStartedInfo,
  RecorderState,
} from '../flight/recorder.js';
import type { LandingPreview, TouchdownEvent } from '../flight/touchdown.js';
import type { SimConnectOpenInfo } from '../sim/types.js';
import type { OutboxSyncResult } from '../sync/outbox-syncer.js';
import { MemoryTokenStore, type StoredTokens } from '../sync/token-store.js';
import { MachineMismatchError, NotAuthorizedError, type FlushSummary, type UploadedLandingScore } from '../sync/uploader.js';
import { seedCompletedFlight } from '../testing/seed-flight.js';
import { seededUuidGenerator } from '../util/id.js';
import type { AgentConfig } from './config.js';
import type { Logger } from './logger.js';
import {
  AgentRuntime,
  type AgentRuntimeDeps,
  type CloseableOutboxBuffer,
  type RuntimeHeartbeat,
  type RuntimePreviewClient,
  type RuntimeRecorder,
  type RuntimeSyncer,
} from './runtime.js';

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
  flights_processed: 0,
  flights_completed: 0,
  flights_abandoned: 0,
  points_uploaded: 0,
  events_uploaded: 0,
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
const ENDED_INFO: FlightEndedInfo = {
  client_flight_id: STARTED_INFO.client_flight_id,
  started_at: STARTED_INFO.started_at,
  ended_at: '2026-09-23T12:30:00.000Z',
  reason: 'engine_stop',
  point_count: 120,
  event_count: 4,
  bounce_count: 0,
  landings_count: 1,
  touch_and_go_count: 0,
  landings: [],
  score_preview: null,
  metrics: null,
  is_partial: false,
  leaderboard_eligible: true,
  quality_flags: 0,
  paused_total_s: 0,
  confidence: 0.98,
  discarded: false,
  discard_reason: null,
};

const LANDING_METRICS: LandingMetrics = {
  vs_fpm: -118,
  g_force: 1.21,
  bounce_count: 0,
  bounced: false,
  aircraft_icao: 'B738',
};
const LANDING_SCORE: LandingScore = {
  score: 91,
  grade: 'butter',
  components: {},
  score_version: '1.0.0',
};
const TOUCHDOWN_EVENT: TouchdownEvent = {
  kind: 'touchdown',
  ts: '2026-09-23T12:29:50.000Z',
  metrics: LANDING_METRICS,
  latitude: 59.800936,
  longitude: 30.259455,
  headingDeg: 280,
  vsPeakFpm: -142,
  score: LANDING_SCORE,
  bounceCount: 0,
  landingSeq: 1,
  touchAndGo: false,
};
const LANDING_PREVIEW: LandingPreview = {
  seq: 1,
  touchdown_at: TOUCHDOWN_EVENT.ts,
  liftoff_at: null,
  groundContactS: null,
  stoppedOnGround: true,
  touchAndGo: false,
  bounceCount: 0,
  metrics: LANDING_METRICS,
  score: LANDING_SCORE,
};
const ENDED_WITH_LANDING: FlightEndedInfo = {
  ...ENDED_INFO,
  landings: [LANDING_PREVIEW],
  score_preview: LANDING_SCORE,
  metrics: LANDING_METRICS,
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

function makeLogger(): Logger & {
  entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }>;
} {
  const entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  const push = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    entries.push({ level, message, meta });
  };
  return {
    entries,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}

function makeSleep(): {
  sleep: (ms: number) => Promise<void>;
  release: () => void;
  pending: number;
} {
  const resolvers: Array<() => void> = [];
  return {
    sleep: () =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
      }),
    release: () => {
      resolvers.shift()?.();
    },
    get pending() {
      return resolvers.length;
    },
  };
}

function makeBuffer(): CloseableOutboxBuffer & { close: ReturnType<typeof vi.fn> } {
  return Object.assign(new MemoryOutboxBuffer(), { close: vi.fn() });
}

function syncResult(reason: string): OutboxSyncResult {
  const counts = {
    flights: 0,
    points: 0,
    events: 0,
    pendingFlights: 0,
    pendingPoints: 0,
    pendingEvents: 0,
  };
  return { reason, summary: FLUSH_SUMMARY, pending_before: counts, pending_after: counts };
}

function makeRuntime(
  options: {
    config?: Partial<AgentConfig>;
    adapter?: { connected: boolean };
    recorder?: FakeRecorder;
    tokens?: StoredTokens | null;
    uploaderFlush?: ReturnType<typeof vi.fn>;
    authAuthorize?: ReturnType<typeof vi.fn>;
    syncer?: RuntimeSyncer;
    agentVersion?: string;
    source?: string;
    preview?: RuntimePreviewClient;
    heartbeat?: RuntimeHeartbeat;
    serverFlightId?: string | null;
    finalLandings?: readonly UploadedLandingScore[] | null;
  } = {},
): {
  runtime: AgentRuntime;
  adapter: { connected: boolean };
  recorder: FakeRecorder;
  buffer: ReturnType<typeof makeBuffer>;
  uploader: {
    flush: ReturnType<typeof vi.fn>;
    resolveServerFlightId: (id: string) => string | null;
    resolveFinalLandings: (id: string) => readonly UploadedLandingScore[] | null;
  };
  auth: { authorize: ReturnType<typeof vi.fn> };
  logger: ReturnType<typeof makeLogger>;
  sleep: ReturnType<typeof makeSleep>;
  statusEvents: Array<{
    state: string;
    deviceId?: string;
    uploadedFlights?: number;
    uploadedPoints?: number;
    uploadedEvents?: number;
    syncReason?: string;
    lastSyncAt?: string;
    clientFlightId?: string;
    score?: number;
    grade?: string;
    vsFpm?: number;
    bounceCount?: number;
    touchAndGo?: boolean;
    landingSeq?: number;
    lastLandingAt?: string;
    message?: string;
    agentVersion?: string;
    source?: string;
    quality?: string;
    needsRepair?: boolean;
    flightDiscarded?: boolean;
    scorePreliminary?: boolean;
    scoreSource?: string;
  }>;
} {
  const adapter = options.adapter ?? { connected: false };
  const recorder = options.recorder ?? new FakeRecorder();
  const buffer = makeBuffer();
  const tokenStore = new MemoryTokenStore(options.tokens === undefined ? TOKENS : options.tokens);
  const uploader = {
    flush: options.uploaderFlush ?? vi.fn(async () => FLUSH_SUMMARY),
    resolveServerFlightId: (_id: string): string | null => options.serverFlightId ?? null,
    resolveFinalLandings: (_id: string): readonly UploadedLandingScore[] | null =>
      options.finalLandings ?? null,
  };
  const auth = {
    authorize: options.authAuthorize ?? vi.fn(async () => TOKENS),
  };
  const logger = makeLogger();
  const sleep = makeSleep();
  const statusEvents: Array<{
    state: string;
    deviceId?: string;
    uploadedFlights?: number;
    uploadedPoints?: number;
    uploadedEvents?: number;
    syncReason?: string;
    lastSyncAt?: string;
    scorePreliminary?: boolean;
    scoreSource?: string;
  }> = [];
  const deps: AgentRuntimeDeps = {
    adapter,
    recorder,
    buffer,
    tokenStore,
    auth,
    uploader,
    logger,
    syncer: options.syncer,
    sleep: sleep.sleep,
    random: () => 1,
    onStatus: (event) => statusEvents.push(event),
    agentVersion: options.agentVersion,
    source: options.source,
    preview: options.preview,
    heartbeat: options.heartbeat,
  };
  const runtime = new AgentRuntime(makeConfig(options.config), deps);
  return { runtime, adapter, recorder, buffer, uploader, auth, logger, sleep, statusEvents };
}

async function settle(times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe('AgentRuntime (T83, runnable CLI-логика на моках)', () => {
  it('не падает и ретраит подключение, если сим недоступен; корректно останавливается', async () => {
    const { runtime, recorder, buffer, logger, sleep } = makeRuntime();
    recorder.start.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:2048'));

    await runtime.start();
    await settle();

    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(
      logger.entries.some(
        (entry) => entry.level === 'warn' && entry.message.includes('simulator not available'),
      ),
    ).toBe(true);
    expect(sleep.pending).toBe(1);

    sleep.release();
    await settle();
    expect(recorder.start).toHaveBeenCalledTimes(2);

    await runtime.stop('test');
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(buffer.close).toHaveBeenCalledTimes(1);
  });

  it('W1a: heartbeat стартует после авторизации и останавливается вместе с рантаймом', async () => {
    const heartbeat = { start: vi.fn(), stop: vi.fn() };
    const { runtime, sleep } = makeRuntime({ heartbeat });

    await runtime.start();
    expect(heartbeat.start).toHaveBeenCalledTimes(1);

    sleep.release();
    await runtime.stop('test');
    expect(heartbeat.stop).toHaveBeenCalledTimes(1);
  });

  it('XC-SIM-AGNOSTIC: sim_waiting — обобщённый текст, без MSFS в статусах и логах', async () => {
    const { runtime, recorder, logger, statusEvents, sleep } = makeRuntime();
    recorder.start.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:2048'));

    await runtime.start();
    await settle();

    const waiting = statusEvents.filter((event) => event.state === 'sim_waiting');
    expect(waiting.length).toBeGreaterThan(0);
    // Начальное ожидание — ровно обобщённая формулировка владельца.
    expect(waiting[0]?.message).toBe('Ожидание данных симулятора');

    // Регрессия: ни один статус/лог sim_waiting-пути не хардкодит MSFS.
    const msfs = /MSFS|Microsoft Flight Simulator|FlightSimulator/;
    for (const event of waiting) {
      expect(event.message ?? '').not.toMatch(msfs);
    }
    for (const entry of logger.entries) {
      expect(entry.message).not.toMatch(msfs);
    }

    sleep.release();
    await settle();
    await runtime.stop('test');
  });

  it('подключается к симулятору (read-only) и запускает синк', async () => {
    const adapter = { connected: false };
    const { runtime, recorder, uploader, logger } = makeRuntime({ adapter });
    recorder.start.mockImplementation(async () => {
      adapter.connected = true;
      return OPEN_INFO;
    });

    await runtime.start();
    await settle(2);

    expect(adapter.connected).toBe(true);
    expect(
      logger.entries.some(
        (entry) => entry.level === 'info' && entry.message.includes('connected to simulator'),
      ),
    ).toBe(true);
    expect(uploader.flush).toHaveBeenCalled();

    await runtime.stop();
    expect(recorder.stop).toHaveBeenCalledTimes(1);
  });

  it('синкает после завершения рейса', async () => {
    const adapter = { connected: false };
    const { runtime, recorder, uploader } = makeRuntime({ adapter });
    recorder.start.mockImplementation(async () => {
      adapter.connected = true;
      return OPEN_INFO;
    });

    await runtime.start();
    await settle(2);
    uploader.flush.mockClear();

    recorder.emit('flight_ended', ENDED_INFO);
    await settle(2);

    expect(uploader.flush).toHaveBeenCalled();
    await runtime.stop();
  });

  it('touchdown-событие несёт score/grade/vsFpm/landingSeq (T115)', async () => {
    const { runtime, recorder, statusEvents } = makeRuntime();
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await runtime.start();
    await settle();

    recorder.emit('score', TOUCHDOWN_EVENT);
    await settle();

    const touchdown = statusEvents.find((event) => event.state === 'touchdown');
    expect(touchdown?.score).toBe(91);
    expect(touchdown?.grade).toBe('butter');
    expect(touchdown?.vsFpm).toBe(-118);
    expect(touchdown?.bounceCount).toBe(0);
    expect(touchdown?.touchAndGo).toBe(false);
    expect(touchdown?.landingSeq).toBe(1);
    expect(touchdown?.lastLandingAt).toBe(TOUCHDOWN_EVENT.ts);

    await runtime.stop();
  });

  it('последняя посадка сохраняется в connected_idle после завершения рейса (T115)', async () => {
    const { runtime, recorder, statusEvents } = makeRuntime();
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await runtime.start();
    await settle();

    recorder.emit('flight_ended', ENDED_WITH_LANDING);
    await settle(2);

    const ended = statusEvents.find(
      (event) => event.state === 'connected_idle' && event.clientFlightId === ENDED_WITH_LANDING.client_flight_id,
    );
    expect(ended?.message).toBeUndefined();
    expect(ended?.score).toBe(91);
    expect(ended?.grade).toBe('butter');
    expect(ended?.vsFpm).toBe(-118);
    expect(ended?.landingSeq).toBe(1);
    expect(ended?.lastLandingAt).toBe(LANDING_PREVIEW.touchdown_at);

    await runtime.stop();
  });

  it('startup и interval flush работают без сима и без активного рейса', async () => {
    const flush = vi.fn(async (reason: string) => syncResult(reason));
    const syncer: RuntimeSyncer = { flush };
    const { runtime, recorder } = makeRuntime({
      config: { syncIntervalMs: 20 },
      syncer,
    });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await runtime.start();
    await settle();

    expect(flush).toHaveBeenCalledWith('startup');

    await new Promise((resolve) => setTimeout(resolve, 60));
    const reasons = flush.mock.calls.map((call) => call[0]);
    expect(reasons).toContain('interval');

    await runtime.stop();
  });

  it('sync_ok несёт фактические счётчики выгрузки, пустой — нули (T125)', async () => {
    const summary: FlushSummary = {
      flights_processed: 1,
      flights_completed: 1,
      flights_abandoned: 0,
      points_uploaded: 5,
      events_uploaded: 2,
      pending_flights: 0,
      pending_points: 0,
      pending_events: 0,
    };
    const empty = {
      flights: 0,
      points: 0,
      events: 0,
      pendingFlights: 0,
      pendingPoints: 0,
      pendingEvents: 0,
    };
    const full = vi.fn(async (reason: string): Promise<OutboxSyncResult> => ({
      reason,
      summary,
      pending_before: empty,
      pending_after: empty,
    }));
    const first = makeRuntime({ syncer: { flush: full } });
    first.recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await first.runtime.start();
    await settle(2);

    const ok = first.statusEvents.find((event) => event.state === 'sync_ok');
    expect(ok?.uploadedFlights).toBe(1);
    expect(ok?.uploadedPoints).toBe(5);
    expect(ok?.uploadedEvents).toBe(2);
    expect(ok?.syncReason).toBe('startup');
    expect(ok?.lastSyncAt).toBeTruthy();
    await first.runtime.stop();

    const zeros = makeRuntime();
    zeros.recorder.start.mockRejectedValue(new Error('SimConnect not available'));
    await zeros.runtime.start();
    await settle(2);
    const emptyOk = zeros.statusEvents.find((event) => event.state === 'sync_ok');
    expect(emptyOk?.uploadedFlights).toBe(0);
    expect(emptyOk?.uploadedPoints).toBe(0);
    expect(emptyOk?.uploadedEvents).toBe(0);
    await zeros.runtime.stop();
  });

  it('sync_ok несёт причину и last_sync_at для startup/manual/interval (T126)', async () => {
    const flush = vi.fn(async (reason: string) => syncResult(reason));
    const { runtime, recorder, statusEvents } = makeRuntime({
      config: { syncIntervalMs: 20 },
      syncer: { flush },
    });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await runtime.start();
    await settle(2);

    const startup = statusEvents.find(
      (event) => event.state === 'sync_ok' && event.syncReason === 'startup',
    );
    expect(startup?.lastSyncAt).toBeTruthy();

    runtime.syncNow('manual');
    await settle(2);
    const manual = statusEvents.find(
      (event) => event.state === 'sync_ok' && event.syncReason === 'manual',
    );
    expect(manual?.lastSyncAt).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 60));
    const interval = statusEvents.find(
      (event) => event.state === 'sync_ok' && event.syncReason === 'interval',
    );
    expect(interval?.lastSyncAt).toBeTruthy();

    await runtime.stop();
  });

  it('CLIENT-FLIGHT-END-FIX: discarded-сессия синкается как discarded, без flight_ended', async () => {
    const flush = vi.fn(async (reason: string) => syncResult(reason));
    const { runtime, recorder, statusEvents } = makeRuntime({ syncer: { flush } });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await runtime.start();
    await settle(2);
    flush.mockClear();
    statusEvents.length = 0;

    recorder.emit('flight_ended', {
      ...ENDED_INFO,
      discarded: true,
      landings_count: 0,
      landings: [],
      score_preview: null,
      metrics: null,
    });
    await settle(2);

    // Flush сохранён (uploader отзовёт сессию через `/abandon`), но причина — не
    // `flight_ended`.
    expect(flush).toHaveBeenCalledWith('discarded');
    const ok = statusEvents.find((event) => event.state === 'sync_ok');
    expect(ok?.syncReason).toBe('other');
    expect(ok?.flightDiscarded).toBe(true);
    expect(statusEvents.some((event) => event.syncReason === 'flight_ended')).toBe(false);
    expect(statusEvents.find((event) => event.state === 'connected_idle')?.flightDiscarded).toBe(
      true,
    );

    await runtime.stop();
  });

  it('CLIENT-FLIGHT-END-FIX: реальный рейс синкается как flight_ended', async () => {
    const flush = vi.fn(async (reason: string) => syncResult(reason));
    const { runtime, recorder, statusEvents } = makeRuntime({ syncer: { flush } });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await runtime.start();
    await settle(2);
    flush.mockClear();
    statusEvents.length = 0;

    recorder.emit('flight_ended', ENDED_WITH_LANDING);
    await settle(2);

    expect(flush).toHaveBeenCalledWith('flight_ended');
    const ok = statusEvents.find((event) => event.state === 'sync_ok');
    expect(ok?.syncReason).toBe('flight_ended');
    expect(ok?.flightDiscarded).toBeUndefined();

    await runtime.stop();
  });

  it('flush после flight_ended не теряется, если синк пришёл во время другого flush', async () => {
    const pending: Array<(value: OutboxSyncResult) => void> = [];
    const flush = vi.fn(
      (reason: string) =>
        new Promise<OutboxSyncResult>((resolve) => {
          pending.push((value) => resolve(value ?? syncResult(reason)));
        }),
    );
    const { runtime, recorder } = makeRuntime({ syncer: { flush } });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await runtime.start();
    await settle();

    // Пока startup-flush «висит», приходит flight_ended.
    recorder.emit('flight_ended', ENDED_INFO);
    expect(flush).toHaveBeenCalledTimes(1);

    pending.shift()?.(syncResult('startup'));
    await settle(3);

    const reasons = flush.mock.calls.map((call) => call[0]);
    expect(reasons).toContain('flight_ended');
    pending.shift()?.(syncResult('flight_ended'));
    await runtime.stop();
  });

  it('повторно запускает device flow при потере авторизации на синке', async () => {
    const flush = vi.fn(async () => FLUSH_SUMMARY).mockRejectedValueOnce(new NotAuthorizedError());
    const authAuthorize = vi.fn(async () => TOKENS);
    const { runtime } = makeRuntime({ uploaderFlush: flush, authAuthorize });

    await runtime.start();
    await settle(3);

    expect(authAuthorize).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it('ретраит авторизацию, если API недоступен, и не падает', async () => {
    const authAuthorize = vi
      .fn(async () => TOKENS)
      .mockRejectedValueOnce(new Error('fetch failed'));
    const { runtime, logger, sleep } = makeRuntime({ tokens: null, authAuthorize });

    const startPromise = runtime.start();
    await settle();

    expect(
      logger.entries.some(
        (entry) => entry.level === 'warn' && entry.message.includes('authorization unavailable'),
      ),
    ).toBe(true);
    expect(sleep.pending).toBe(1);

    sleep.release();
    await startPromise;
    expect(authAuthorize).toHaveBeenCalledTimes(2);

    await runtime.stop();
  });

  it('эмитит явное authorized после загрузки токена, уже после sim_waiting (F-102)', async () => {
    const { runtime, statusEvents } = makeRuntime();

    await runtime.start();
    await settle();

    const states = statusEvents.map((event) => event.state);
    const simWaiting = states.indexOf('sim_waiting');
    const authorized = states.indexOf('authorized');
    expect(simWaiting).toBeGreaterThanOrEqual(0);
    expect(authorized).toBeGreaterThan(simWaiting);
    expect(statusEvents.find((event) => event.state === 'authorized')?.deviceId).toBe(DEVICE_ID);

    await runtime.stop();
  });

  it('повторная авторизация при NotAuthorizedError снова эмитит authorized (F-102)', async () => {
    const flush = vi.fn(async () => FLUSH_SUMMARY).mockRejectedValueOnce(new NotAuthorizedError());
    const authAuthorize = vi.fn(async () => TOKENS);
    const { runtime, statusEvents } = makeRuntime({
      uploaderFlush: flush,
      authAuthorize,
      tokens: null,
    });

    await runtime.start();
    await settle(3);

    expect(authAuthorize).toHaveBeenCalledTimes(2);
    expect(statusEvents.filter((event) => event.state === 'authorized')).toHaveLength(2);

    await runtime.stop();
  });

  it('stop идемпотентен', async () => {
    const adapter = { connected: false };
    const { runtime, recorder, buffer } = makeRuntime({ adapter });
    recorder.start.mockImplementation(async () => {
      adapter.connected = true;
      return OPEN_INFO;
    });

    await runtime.start();
    await settle(2);

    await runtime.stop();
    await runtime.stop();

    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(buffer.close).toHaveBeenCalledTimes(1);
  });

  it('CD-4.2/CD-6.1: статусы несут agentVersion и source', async () => {
    const { runtime, statusEvents, recorder } = makeRuntime({
      agentVersion: '0.2.0',
      source: 'electron',
    });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));
    await runtime.start();
    await settle(2);

    const authorized = statusEvents.find((event) => event.state === 'authorized');
    expect(authorized?.agentVersion).toBe('0.2.0');
    expect(authorized?.source).toBe('electron');
    expect(statusEvents.every((event) => event.agentVersion === '0.2.0')).toBe(true);

    await runtime.stop();
  });

  it('CD-6.2: MACHINE_MISMATCH → NeedsRepair, заливка остановлена, без повторной авторизации', async () => {
    const flush = vi.fn(async () => {
      throw new MachineMismatchError();
    });
    const { runtime, logger, statusEvents, auth, recorder } = makeRuntime({
      uploaderFlush: flush,
    });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));
    await runtime.start();
    await settle(3);

    const callsAfterStart = flush.mock.calls.length;
    runtime.syncNow('manual');
    await settle(2);

    // Заливка остановлена (в т.ч. interval/manual), буфер остаётся у владельца.
    expect(flush.mock.calls.length).toBe(callsAfterStart);
    // Авто-churn device/code не запускается.
    expect(auth.authorize).not.toHaveBeenCalled();
    // Ровно одна строка лога без токенов/машины.
    const warnings = logger.entries.filter(
      (entry) => entry.level === 'warn' && entry.message.includes('machine mismatch'),
    );
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0]?.meta ?? {})).not.toContain('token');
    // Состояние NeedsRepair видно окну/трею.
    expect(statusEvents.some((event) => event.needsRepair && event.quality === 'fatal')).toBe(true);

    await runtime.stop();
  });

  it('CD-3.4: превышение pending-лимита предупреждает без спама', async () => {
    const flush = vi.fn(async (reason: string) => syncResult(reason));
    const { runtime, buffer, logger, recorder } = makeRuntime({
      config: { bufferMaxPending: 1 },
      syncer: { flush },
    });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));
    seedCompletedFlight(buffer, { idGenerator: seededUuidGenerator(), points: 2, events: 0 });

    await runtime.start();
    await settle(3);

    const warnings = logger.entries.filter(
      (entry) => entry.message === 'outbox pending exceeds limit',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.meta?.pending).toBe(3);

    await runtime.stop();
  });
});

const SERVER_FLIGHT_ID = '22222222-2222-4222-8222-222222222222';

function previewResponse(seq: number, score: number, resolved = true): TouchdownPreviewResponse {
  return {
    data: {
      seq,
      score,
      grade: 'good',
      components: {},
      score_version: '1.0.0',
      segmentation_version: '1.1.0',
      preliminary: true,
      resolved,
      runway: resolved
        ? {
            airport_icao: 'ULLI',
            designator: '28R',
            length_m: 3780,
            width_m: 60,
            heading_deg: 280,
            source: 'ourairports',
          }
        : null,
      metrics: {
        vs_fpm: -118,
        g_force: 1.21,
        bounce_count: 0,
        bounced: false,
        ...(resolved ? { centreline_offset_m: 1.2, touchdown_zone: 'TDZ' as const } : {}),
      },
    },
  };
}

async function startAndEmitFlight(runtime: AgentRuntime, recorder: FakeRecorder): Promise<void> {
  await runtime.start();
  await settle();
  recorder.emit('flight_started', STARTED_INFO);
}

describe('AgentRuntime — серверный предпросмотр касания (score-preview.md §4)', () => {
  it('resolved=true: серверный балл заменяет клиентский, помечен как подтверждённый', async () => {
    const preview: RuntimePreviewClient = { request: vi.fn(async () => previewResponse(1, 70)) };
    const { runtime, recorder, statusEvents } = makeRuntime({
      preview,
      serverFlightId: SERVER_FLIGHT_ID,
    });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await startAndEmitFlight(runtime, recorder);
    recorder.emit('score', TOUCHDOWN_EVENT);
    await settle(3);

    expect(preview.request).toHaveBeenCalledTimes(1);
    const body = (preview.request as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as
      | TouchdownPreviewRequest
      | undefined;
    expect(body?.lat).toBe(TOUCHDOWN_EVENT.latitude);
    expect(body?.heading_deg).toBe(280);
    expect((preview.request as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(SERVER_FLIGHT_ID);

    const last = statusEvents.filter((event) => event.state === 'touchdown').at(-1);
    expect(last?.score).toBe(70);
    expect(last?.scorePreliminary).toBe(false);
    expect(last?.scoreSource).toBe('server_preview');

    await runtime.stop();
  });

  it('headingDeg=null (sparse окно, R1) → heading_deg: null, клиентский балл «предварительно»', async () => {
    const preview: RuntimePreviewClient = { request: vi.fn(async () => previewResponse(1, 50, false)) };
    const { runtime, recorder, statusEvents } = makeRuntime({
      preview,
      serverFlightId: SERVER_FLIGHT_ID,
    });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await startAndEmitFlight(runtime, recorder);
    recorder.emit('score', { ...TOUCHDOWN_EVENT, headingDeg: null });
    await settle(3);

    expect(preview.request).toHaveBeenCalledTimes(1);
    const body = (preview.request as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as
      | TouchdownPreviewRequest
      | undefined;
    expect(body?.heading_deg).toBeNull();

    const last = statusEvents.filter((event) => event.state === 'touchdown').at(-1);
    expect(last?.score).toBe(91);
    expect(last?.scorePreliminary).toBe(true);
    expect(last?.scoreSource).toBe('client');

    await runtime.stop();
  });

  it('нет серверного id рейса → предпросмотр не вызывается, клиентский балл «предварительно»', async () => {
    const preview: RuntimePreviewClient = { request: vi.fn(async () => previewResponse(1, 70)) };
    const { runtime, recorder, statusEvents } = makeRuntime({ preview, serverFlightId: null });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await startAndEmitFlight(runtime, recorder);
    recorder.emit('score', TOUCHDOWN_EVENT);
    await settle(3);

    expect(preview.request).not.toHaveBeenCalled();
    const last = statusEvents.filter((event) => event.state === 'touchdown').at(-1);
    expect(last?.score).toBe(91);
    expect(last?.scorePreliminary).toBe(true);
    expect(last?.scoreSource).toBe('client');

    await runtime.stop();
  });

  it('ошибка/офлайн → тихий fallback: клиентский балл остаётся «предварительно»', async () => {
    const preview: RuntimePreviewClient = {
      request: vi.fn(async () => {
        throw new Error('network failure');
      }),
    };
    const { runtime, recorder, statusEvents } = makeRuntime({
      preview,
      serverFlightId: SERVER_FLIGHT_ID,
    });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await startAndEmitFlight(runtime, recorder);
    recorder.emit('score', TOUCHDOWN_EVENT);
    await settle(3);

    const last = statusEvents.filter((event) => event.state === 'touchdown').at(-1);
    expect(last?.score).toBe(91);
    expect(last?.scorePreliminary).toBe(true);
    expect(last?.scoreSource).toBe('client');

    await runtime.stop();
  });

  it('resolved=false → балл остаётся клиентским «предварительно»', async () => {
    const preview: RuntimePreviewClient = { request: vi.fn(async () => previewResponse(1, 50, false)) };
    const { runtime, recorder, statusEvents } = makeRuntime({
      preview,
      serverFlightId: SERVER_FLIGHT_ID,
    });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await startAndEmitFlight(runtime, recorder);
    recorder.emit('score', TOUCHDOWN_EVENT);
    await settle(3);

    const last = statusEvents.filter((event) => event.state === 'touchdown').at(-1);
    expect(last?.score).toBe(91);
    expect(last?.scorePreliminary).toBe(true);
    expect(last?.scoreSource).toBe('client');

    await runtime.stop();
  });

  it('новое касание отменяет предыдущий запрос: устаревший ответ игнорируется', async () => {
    const resolvers: Array<(value: TouchdownPreviewResponse) => void> = [];
    const preview: RuntimePreviewClient = {
      request: vi.fn(
        () =>
          new Promise<TouchdownPreviewResponse>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    };
    const { runtime, recorder, statusEvents } = makeRuntime({
      preview,
      serverFlightId: SERVER_FLIGHT_ID,
    });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await startAndEmitFlight(runtime, recorder);
    recorder.emit('score', TOUCHDOWN_EVENT);
    await settle();

    recorder.emit('score', { ...TOUCHDOWN_EVENT, landingSeq: 2, ts: '2026-09-23T12:31:00.000Z' });
    await settle();
    expect(preview.request).toHaveBeenCalledTimes(2);

    // Поздний ответ первого (отменённого) запроса не должен перетирать состояние.
    resolvers[0]?.(previewResponse(1, 70));
    await settle();
    expect(statusEvents.filter((event) => event.state === 'touchdown').at(-1)?.score).toBe(91);

    resolvers[1]?.(previewResponse(2, 65));
    await settle();
    const last = statusEvents.filter((event) => event.state === 'touchdown').at(-1);
    expect(last?.score).toBe(65);
    expect(last?.scorePreliminary).toBe(false);
    expect(last?.scoreSource).toBe('server_preview');

    await runtime.stop();
  });

  it('/complete → авторитетные посадки перетирают предпросмотр (server_final)', async () => {
    const finalLandings: UploadedLandingScore[] = [
      {
        seq: 1,
        score: 88,
        grade: 'good',
        vs_fpm: -120,
        bounce_count: 0,
        touchdown_at: TOUCHDOWN_EVENT.ts,
        touch_and_go: false,
      },
    ];
    const { runtime, recorder, statusEvents } = makeRuntime({ finalLandings });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await startAndEmitFlight(runtime, recorder);
    recorder.emit('flight_ended', ENDED_WITH_LANDING);
    await settle(2);
    runtime.syncNow('manual');
    await settle(4);

    const finalEvent = statusEvents.filter((event) => event.scoreSource === 'server_final').at(-1);
    expect(finalEvent?.score).toBe(88);
    expect(finalEvent?.scorePreliminary).toBe(false);

    await runtime.stop();
  });
});

describe('AgentRuntime — честная деградация посадки (A-01/A-02)', () => {
  const ENDED_SESSION_SCORE: FlightEndedInfo = {
    ...ENDED_INFO,
    landings: [],
    score_preview: LANDING_SCORE,
    metrics: LANDING_METRICS,
  };

  it('/complete без vs_fpm: посадка не подтверждена, 0 не подставлен', async () => {
    const finalLandings: UploadedLandingScore[] = [
      {
        seq: 1,
        score: 100,
        grade: 'butter',
        vs_fpm: null,
        bounce_count: null,
        touchdown_at: null,
        touch_and_go: null,
      },
    ];
    const { runtime, recorder, statusEvents } = makeRuntime({ finalLandings });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await startAndEmitFlight(runtime, recorder);
    runtime.syncNow('manual');
    await settle(4);

    const finalEvent = statusEvents.filter((event) => event.scoreSource === 'server_final').at(-1);
    expect(finalEvent?.score).toBe(100);
    // Нет реальной телеметрии касания → не «подтверждено».
    expect(finalEvent?.scorePreliminary).toBe(true);
    // Отсутствующее не превращается в правдоподобные 0/false/now.
    expect(finalEvent?.vsFpm).toBeUndefined();
    expect(finalEvent?.vsFpm).not.toBe(0);
    expect(finalEvent?.bounceCount).toBeUndefined();
    expect(finalEvent?.touchAndGo).toBeUndefined();
    expect(finalEvent?.touchAndGo).not.toBe(false);
    expect(finalEvent?.lastLandingAt).toBeUndefined();

    await runtime.stop();
  });

  it('/complete без vs_fpm: клиентский VS сохраняется, но балл остаётся «предварительно»', async () => {
    const finalLandings: UploadedLandingScore[] = [
      {
        seq: 1,
        score: 90,
        grade: 'good',
        vs_fpm: null,
        bounce_count: null,
        touchdown_at: null,
        touch_and_go: null,
      },
    ];
    const { runtime, recorder, statusEvents } = makeRuntime({ finalLandings });
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await startAndEmitFlight(runtime, recorder);
    // Клиентский предпросмотр касания: реальные измеренные значения.
    recorder.emit('score', TOUCHDOWN_EVENT);
    await settle();
    runtime.syncNow('manual');
    await settle(4);

    const finalEvent = statusEvents.filter((event) => event.scoreSource === 'server_final').at(-1);
    expect(finalEvent?.score).toBe(90);
    expect(finalEvent?.scorePreliminary).toBe(true);
    // Честный клиентский VS сохранён, а не затёрт нулём.
    expect(finalEvent?.vsFpm).toBe(TOUCHDOWN_EVENT.metrics.vs_fpm);
    expect(finalEvent?.vsFpm).not.toBe(0);

    await runtime.stop();
  });

  it('rememberFinalLanding без пер-посадочных данных не изобретает seq/at', async () => {
    const { runtime, recorder, statusEvents } = makeRuntime();
    recorder.start.mockRejectedValue(new Error('SimConnect not available'));

    await startAndEmitFlight(runtime, recorder);
    recorder.emit('flight_ended', ENDED_SESSION_SCORE);
    await settle(2);

    const idle = statusEvents
      .filter((event) => event.state === 'connected_idle' && event.clientFlightId != null)
      .at(-1);
    expect(idle?.score).toBe(LANDING_SCORE.score);
    // seq неизвестен → не «посадка #1»; at — не `ended_at`.
    expect(idle?.landingSeq).toBeUndefined();
    expect(idle?.lastLandingAt).toBeUndefined();
    expect(idle?.lastLandingAt).not.toBe(ENDED_SESSION_SCORE.ended_at);
    expect(idle?.touchAndGo).toBeUndefined();

    await runtime.stop();
  });
});
