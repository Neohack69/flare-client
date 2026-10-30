import { describe, expect, it, vi } from 'vitest';

import type { RuntimeRecorder } from '../cli/runtime.js';
import type { FlightRecorderEvents, RecorderState } from '../flight/recorder.js';
import { TypedEmitter } from '../util/emitter.js';
import { DEFAULT_REDISCOVERY_COOLDOWN_MS, SimSession } from './session.js';
import type {
  SimSource,
  SimSourceCapabilities,
  SimSourceDiagnostics,
  SimSourceEvents,
  SimSourceId,
  SimSourceOpenInfo,
} from './source.js';

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

function openInfo(id: SimSourceId): SimSourceOpenInfo {
  return {
    applicationName: id === 'xplane12' ? 'X-Plane 12' : 'Microsoft Flight Simulator 2024',
    applicationVersion: id === 'xplane12' ? '12.1.4' : '1.39.9.0',
    simConnectVersion: '0.0.0.0',
    sim: id,
    simVersion: id === 'xplane12' ? '12.1.4' : '1.39.9',
    adapter: id === 'xplane12' ? 'xp-web-api-v1' : 'simconnect-sunrise',
    protocol: id === 'xplane12' ? 'websocket' : 'sunrise',
  };
}

class FakeSource extends TypedEmitter<SimSourceEvents> implements SimSource {
  readonly readOnly = true;
  connected = false;

  constructor(readonly id: SimSourceId) {
    super();
  }

  get capabilities(): SimSourceCapabilities {
    return {
      sim: this.id,
      maxSampleHz: 10,
      pauseDetection: this.id === 'xplane12' ? 'direct' : 'gap',
      adapter: this.id === 'xplane12' ? 'xp-web-api-v1' : 'simconnect-sunrise',
    };
  }

  readonly connect = vi.fn(async (): Promise<SimSourceOpenInfo> => {
    this.connected = true;
    return openInfo(this.id);
  });

  readonly disconnect = vi.fn(async (): Promise<void> => {
    this.connected = false;
  });

  diagnostics(): SimSourceDiagnostics | null {
    return null;
  }

  emitSample(ts: string): void {
    this.emit('sample', { ts });
  }
}

class FakeRecorder extends TypedEmitter<FlightRecorderEvents> implements RuntimeRecorder {
  state = { ...STATE };

  readonly start = vi.fn(async (): Promise<SimSourceOpenInfo> => openInfo('msfs2024'));
  readonly stop = vi.fn(async (): Promise<void> => undefined);

  emitFlightStarted(): void {
    this.emit('flight_started', {
      client_flight_id: '11111111-1111-4111-8111-111111111111',
      started_at: '2026-10-18T08:00:00.000Z',
      aircraft_icao: 'B738',
      aircraft_icao_source: 'atc_type',
    });
  }
}

function makeLogger() {
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

function makeSession(
  options: {
    preference?: 'auto' | SimSourceId;
    probe?: (id: SimSourceId) => Promise<boolean>;
    now?: () => number;
  } = {},
) {
  const msfs = new FakeSource('msfs2024');
  const xp = new FakeSource('xplane12');
  const msfsRecorder = new FakeRecorder();
  const xpRecorder = new FakeRecorder();
  xpRecorder.start.mockImplementation(async () => openInfo('xplane12'));
  const logger = makeLogger();
  const probe = vi.fn(options.probe ?? (async () => false));
  const session = new SimSession({
    preference: options.preference ?? 'auto',
    initialSource: msfs,
    initialRecorder: msfsRecorder,
    createSource: (id) => (id === 'xplane12' ? xp : msfs),
    createRecorder: (source) => (source.id === 'xplane12' ? xpRecorder : msfsRecorder),
    available: ['msfs2024', 'xplane12'],
    logger,
    probe,
    now: options.now ?? (() => 0),
  });
  return { session, msfs, xp, msfsRecorder, xpRecorder, logger, probe };
}

describe('SimSession re-discovery (SIM-REDISCOVER-1)', () => {
  it('переключается на сим, который стал доступен, и логирует решение', async () => {
    const { session, msfs, xp, msfsRecorder, xpRecorder, logger } = makeSession({
      probe: async (id) => id === 'xplane12',
    });

    const outcome = await session.rediscover('connect_failures');

    expect(outcome).toMatchObject({
      status: 'switched',
      from: 'msfs2024',
      to: 'xplane12',
      reason: 'connect_failures',
    });
    expect(session.snapshot()).toMatchObject({
      sourceId: 'xplane12',
      connected: false,
      pinned: false,
    });
    expect(msfsRecorder.stop).toHaveBeenCalledTimes(1);
    expect(msfs.disconnect).not.toHaveBeenCalled();
    expect(xp.connect).not.toHaveBeenCalled();

    const messages = logger.entries.map((entry) => entry.message);
    expect(messages).toContain('simulator discovery: switching source');
    expect(messages).toContain('simulator discovery: switched source');
    const switched = logger.entries.find(
      (entry) => entry.message === 'simulator discovery: switched source',
    );
    expect(switched?.meta).toMatchObject({
      from: 'msfs2024',
      to: 'xplane12',
      reason: 'connect_failures',
      attempted: ['xplane12', 'msfs2024'],
    });

    // Новый источник используется последующим connect.
    await session.start();
    expect(xpRecorder.start).toHaveBeenCalledTimes(1);
    expect(msfsRecorder.start).not.toHaveBeenCalled();
  });

  it('подписки на события рекордера переживают switch', async () => {
    const { session, msfsRecorder, xpRecorder } = makeSession({
      probe: async (id) => id === 'xplane12',
    });
    const handler = vi.fn();
    session.on('flight_started', handler);

    msfsRecorder.emitFlightStarted();
    expect(handler).toHaveBeenCalledTimes(1);

    await session.rediscover('disconnect');
    msfsRecorder.emitFlightStarted();
    expect(handler).toHaveBeenCalledTimes(1);

    xpRecorder.emitFlightStarted();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('пин AGENT_SIM_SOURCE: не переключается и не пробует источники', async () => {
    const { session, probe, logger } = makeSession({
      preference: 'msfs2024',
      probe: async () => true,
    });

    const outcome = await session.rediscover('connect_failures');

    expect(outcome.status).toBe('pinned');
    expect(probe).not.toHaveBeenCalled();
    expect(session.snapshot().sourceId).toBe('msfs2024');
    const pinned = logger.entries.find((entry) =>
      entry.message.startsWith('simulator discovery: not switching'),
    );
    expect(pinned).toBeDefined();
  });

  it('cooldown: не чаще одной пробы за окно (без busy loop)', async () => {
    let now = 1_000;
    const { session, probe } = makeSession({
      probe: async () => false,
      now: () => now,
    });

    const first = await session.rediscover('connect_failures');
    expect(first.status).toBe('unchanged');
    expect(probe).toHaveBeenCalledTimes(1);

    const second = await session.rediscover('connect_failures');
    expect(second.status).toBe('cooldown');
    expect(second.nextProbeInMs).toBe(DEFAULT_REDISCOVERY_COOLDOWN_MS);
    expect(probe).toHaveBeenCalledTimes(1);

    now += DEFAULT_REDISCOVERY_COOLDOWN_MS;
    const third = await session.rediscover('connect_failures');
    expect(third.status).toBe('unchanged');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('не переключается на «выбранный, но недоступный» источник', async () => {
    // Discovery по умолчанию отдаёт MSFS без пробы, поэтому проверяем явно:
    // текущий XP unavailable → chosen MSFS, проба MSFS = false → остаёмся на XP.
    const xp = new FakeSource('xplane12');
    const msfs = new FakeSource('msfs2024');
    const xpRecorder = new FakeRecorder();
    const msfsRecorder = new FakeRecorder();
    const session = new SimSession({
      preference: 'auto',
      initialSource: xp,
      initialRecorder: xpRecorder,
      createSource: (id) => (id === 'xplane12' ? xp : msfs),
      createRecorder: (source) => (source.id === 'xplane12' ? xpRecorder : msfsRecorder),
      available: ['msfs2024', 'xplane12'],
      logger: makeLogger(),
      probe: vi.fn(async () => false),
      now: () => 0,
    });

    const outcome = await session.rediscover('connect_failures');

    expect(outcome.status).toBe('unavailable');
    expect(session.snapshot().sourceId).toBe('xplane12');
    expect(msfsRecorder.stop).not.toHaveBeenCalled();
  });

  it('снимок отдаёт свежесть данных по sample-событиям', () => {
    const { session, msfs } = makeSession();
    msfs.emitSample('2026-10-18T08:40:00.000Z');
    expect(session.snapshot().lastSampleAt).toBe('2026-10-18T08:40:00.000Z');
  });
});
