import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryOutboxBuffer } from '../buffer/memory-buffer.js';
import type {
  FlightRecorderEvents,
  RecorderState,
} from '../flight/recorder.js';
import type { RuntimeRecorder } from '../cli/runtime.js';
import { AgentRuntime } from '../cli/runtime.js';
import type { AgentConfig } from '../cli/config.js';
import type { Logger } from '../cli/logger.js';
import { MemoryTokenStore, type StoredTokens } from '../sync/token-store.js';
import type { FlushSummary } from '../sync/uploader.js';
import {
  buildSimVarDefinition,
  describeRejectedSimVar,
  FOQA_GROUP_ORDER,
  FOQA_SIMVARS_ENV,
  NodeSimConnectAdapter,
  type SimVarDefinition,
} from './node-simconnect-adapter.js';
import type { SimSourceOpenInfo } from './source.js';

/**
 * Pin-тесты лог-строк, которые парсит tooling
 * (`scripts/check-foqa-log.ps1`, `packages/agent/scripts/simvar-probe.mjs`).
 *
 * Если будущий рефакторинг молча изменит эти строки, тест упадёт — MSFS-путь
 * остаётся «байт-в-байт» совместимым (ADR-0023, acceptance criterion T2).
 */

const OPEN_INFO: SimSourceOpenInfo = {
  applicationName: 'Microsoft Flight Simulator 2024',
  applicationVersion: '1.39.9.0',
  simConnectVersion: '0.0.0.0',
  sim: 'msfs2024',
  simVersion: '1.39.9',
  adapter: 'simconnect-sunrise',
  protocol: 'sunrise',
};

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

afterEach(() => {
  vi.doUnmock('node-simconnect');
  vi.resetModules();
});

describe('definition diagnostics log string', () => {
  it('base-набор (env не задан) → байт-в-байт строка про 29 полей / 940 байт', () => {
    const adapter = new NodeSimConnectAdapter({
      definition: buildSimVarDefinition([]),
      foqaGroups: [],
      unknownFoqaGroups: [],
    });
    expect(adapter.diagnostics()?.message).toBe(
      'SimConnect data definition: 29 fields, expected payload 940 bytes; FOQA groups: none',
    );
    expect(adapter.diagnostics()?.meta).toMatchObject({
      fields: 29,
      expected_bytes: 940,
      foqa_groups: [],
      foqa_env: FOQA_SIMVARS_ENV,
    });
  });
});

describe('rejected SimVar log string', () => {
  it("строка отклонённого SimVar с FOQA-группой байт-в-байт совпадает с tooling-парсером", () => {
    const definition = buildSimVarDefinition(['engines']);
    const egt = definition.find((def) => def.field === 'egt_1');
    expect(egt).toBeDefined();
    const message = describeRejectedSimVar({
      sendId: 1,
      index: 0,
      simVar: egt?.name ?? '',
      unit: egt?.unit ?? null,
      field: 'egt_1',
      group: 'engines',
      exceptionName: 'NAME_UNRECOGNIZED',
    });
    expect(message).toBe(
      "SimConnect rejected SimVar 'TURB ENG ITT:1' (egt_1, FOQA group 'engines') — NAME_UNRECOGNIZED",
    );
  });
});

/** Одноразовый mock `node-simconnect` для прогонки connect-диагностики адаптера. */
async function connectWith(
  definition: readonly SimVarDefinition[],
  foqaGroups: readonly (typeof FOQA_GROUP_ORDER)[number][],
  unknownFoqaGroups: readonly string[],
) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let sendCounter = 0;
  const handle = {
    addToDataDefinition: vi.fn(() => {
      sendCounter += 1;
      return sendCounter;
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      handlers.set(event, listener);
    }),
    requestDataOnSimObject: vi.fn(),
    close: vi.fn(),
  };
  vi.doMock('node-simconnect', () => ({
    Protocol: { SunRise: 'SunRise', KittyHawk: 'KittyHawk', FSX_SP2: 'FSX_SP2' },
    SimConnectDataType: { FLOAT64: 1, INT32: 2, STRING256: 3 },
    SimConnectConstants: { OBJECT_ID_USER: 0 },
    SimConnectPeriod: { SIM_FRAME: 1 },
    open: vi.fn(async () => ({
      recvOpen: {
        applicationName: 'MSFS 2024',
        applicationVersionMajor: 1,
        applicationVersionMinor: 2,
        simConnectVersionMajor: 0,
        simConnectVersionMinor: 0,
      },
      handle,
    })),
  }));
  vi.resetModules();
  const mod = await import('./node-simconnect-adapter.js');
  const logger = { info: vi.fn(), warn: vi.fn() };
  const adapter = new mod.NodeSimConnectAdapter({
    definition,
    foqaGroups,
    unknownFoqaGroups,
    logger,
  });
  const onError = vi.fn();
  adapter.on('error', onError);
  await adapter.connect();
  return { adapter, logger, handlers, onError };
}

describe('unknown FOQA group log string', () => {
  it('`FLIGHTLOG_FOQA_SIMVARS: unknown FOQA group(s) ignored: ...` байт-в-байт', async () => {
    const { adapter, logger } = await connectWith(buildSimVarDefinition([]), [], ['bogus']);
    const warnMessage = logger.warn.mock.calls[0]?.[0] as string;
    expect(warnMessage).toBe(
      `${FOQA_SIMVARS_ENV}: unknown FOQA group(s) ignored: bogus ` +
        `(known: ${FOQA_GROUP_ORDER.join(', ')})`,
    );
    await adapter.disconnect();
  });
});

describe('layout mismatch log string', () => {
  it('строка содержит tooling-части: buffer is shorter/longer, Rejected SimVar(s), Secondary: fields from #N', async () => {
    const definition = buildSimVarDefinition(['engines']);
    const { adapter, handlers, onError } = await connectWith(definition, ['engines'], []);

    const egtIndex = definition.findIndex((def) => def.field === 'egt_1');
    const emitException = handlers.get('exception');
    expect(emitException).toBeTypeOf('function');
    emitException?.({ exception: 7, sendId: egtIndex + 1, index: 2, exceptionName: 'NAME_UNRECOGNIZED' });

    const shortBuffer = {
      remaining: () => 0,
      readFloat64: () => {
        throw new RangeError('short buffer');
      },
      readInt32: () => {
        throw new RangeError('short buffer');
      },
      readString256: () => {
        throw new RangeError('short buffer');
      },
    };
    handlers.get('simObjectData')?.({ requestID: 1, data: shortBuffer });

    const mismatchCall = onError.mock.calls.find((call) =>
      String((call[0] as Error).message).includes('layout mismatch'),
    );
    expect(mismatchCall).toBeDefined();
    const message = String((mismatchCall?.[0] as Error).message);

    expect(message).toContain(
      'SimConnect data layout mismatch: buffer is shorter than expected (expected',
    );
    expect(message).toContain('Rejected SimVar(s):');
    expect(message).toContain("'TURB ENG ITT:1' (egt_1)");
    expect(message).toContain('Secondary: fields from #');
    expect(message).toContain('onward are unusable (first field that does not fit the received buffer).');
    expect(message.trimEnd().endsWith('Validate SIMVAR_DEFINITION against a live MSFS before release.')).toBe(true);

    await adapter.disconnect();
  });
});

class FakeRecorder implements RuntimeRecorder {
  readonly start = vi.fn(async (): Promise<SimSourceOpenInfo> => {
    this.adapter.connected = true;
    return OPEN_INFO;
  });
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

  private readonly handlers = new Map<keyof FlightRecorderEvents, Set<(payload: unknown) => void>>();

  constructor(private readonly adapter: { connected: boolean }) {}

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
}

function makeLogger(): Logger & {
  entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }>;
} {
  const entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  const push = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    entries.push({ level, message, meta });
  };
  return { entries, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
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
  connectPollMs: 3_600_000,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 1000,
  shutdownFlushMs: 0,
  logLevel: 'silent',
};

describe('agent lifecycle log strings', () => {
  it('`agent starting (SimConnect read-only)` и `connected to simulator (read-only)` байт-в-байт', async () => {
    const adapter = { connected: false };
    const logger = makeLogger();
    const runtime = new AgentRuntime(CONFIG, {
      adapter,
      recorder: new FakeRecorder(adapter),
      buffer: new MemoryOutboxBuffer(),
      tokenStore: new MemoryTokenStore(TOKENS),
      auth: { authorize: async () => TOKENS },
      uploader: { flush: async () => FLUSH_SUMMARY },
      logger,
    });

    await runtime.start();
    for (let index = 0; index < 4; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    const messages = logger.entries.map((entry) => entry.message);
    expect(messages).toContain('agent starting (SimConnect read-only)');
    expect(messages).toContain('connected to simulator (read-only)');

    await runtime.stop('test');
  });
});
