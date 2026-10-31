import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import { MemoryOutboxBuffer } from '../../buffer/memory-buffer.js';
import { FlightRecorder } from '../../flight/recorder.js';
import { seededUuidGenerator } from '../../util/id.js';
import type { SimConnectAdapterLogger } from '../node-simconnect-adapter.js';
import {
  planRrefSubscriptions,
  type XPlaneDatarefRole,
} from './datarefs.js';
import {
  RREF_HEADER_BYTES,
  RREF_MAGIC,
  RREF_PAIR_BYTES,
} from './rref.js';
import {
  XPlaneRrefSimSource,
  type DgramSocketLike,
  type XPlaneRrefSimSourceOptions,
} from './rref-source.js';
import type { TelemetrySample } from '../types.js';
import type { XPlaneAircraftIdentity } from './aircraft-identity.js';

const TARGETS = planRrefSubscriptions();

function slot(role: XPlaneDatarefRole, element: number | null = null): number {
  const index = TARGETS.findIndex(
    (target) => target.role === role && target.element === element,
  );
  if (index < 0) throw new Error(`no RREF slot for ${role}[${String(element)}]`);
  return index;
}

function rrefResponse(pairs: ReadonlyArray<readonly [number, number]>): Buffer {
  const buffer = Buffer.alloc(RREF_HEADER_BYTES + pairs.length * RREF_PAIR_BYTES);
  buffer.write(RREF_MAGIC, 0, 'ascii');
  pairs.forEach(([index, value], position) => {
    const offset = RREF_HEADER_BYTES + position * RREF_PAIR_BYTES;
    buffer.writeInt32LE(index, offset);
    buffer.writeFloatLE(value, offset + 4);
  });
  return buffer;
}

function sampleDatagram(options: { onGround: boolean }): Buffer {
  return rrefResponse([
    [slot('latitude'), 47.5],
    [slot('longitude'), 8.5],
    [slot('elevation'), 426],
    [slot('y_agl'), 0],
    [slot('groundspeed'), 0],
    [slot('true_psi'), 0],
    [slot('true_theta'), 0],
    [slot('true_phi'), 0],
    [slot('g_nrml'), 1],
    [slot('onground_any'), options.onGround ? 1 : 0],
    [slot('engine_is_burning_fuel', 0), 1],
    [slot('paused'), 0],
  ]);
}

class FakeSocket implements DgramSocketLike {
  readonly sent: Buffer[] = [];
  private messageListener: ((msg: Buffer, rinfo: unknown) => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;

  on(event: 'message', listener: (msg: Buffer, rinfo: unknown) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(
    event: 'message' | 'error',
    listener: ((msg: Buffer, rinfo: unknown) => void) | ((error: Error) => void),
  ): void {
    if (event === 'message') {
      this.messageListener = listener as (msg: Buffer, rinfo: unknown) => void;
    } else {
      this.errorListener = listener as (error: Error) => void;
    }
  }

  send(msg: Buffer): void {
    this.sent.push(msg);
  }

  close(callback?: () => void): void {
    callback?.();
  }

  removeAllListeners(): void {
    this.messageListener = null;
    this.errorListener = null;
  }

  emitMessage(message: Buffer): void {
    this.messageListener?.(message, {});
  }

  emitError(error: Error): void {
    this.errorListener?.(error);
  }
}

const IDENTITY: XPlaneAircraftIdentity = { icao: 'A20N', title: 'Airbus A320neo' };

function createSource(
  socket: FakeSocket,
  overrides: Partial<XPlaneRrefSimSourceOptions> = {},
): XPlaneRrefSimSource {
  return new XPlaneRrefSimSource({
    socketFactory: () => socket,
    aircraftIdentity: () => IDENTITY,
    maxSampleHz: 0,
    ...overrides,
  });
}

async function connectWithFirstDatagram(
  source: XPlaneRrefSimSource,
  socket: FakeSocket,
): Promise<void> {
  const connect = source.connect();
  socket.emitMessage(sampleDatagram({ onGround: true }));
  await connect;
}

function logger(): SimConnectAdapterLogger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('XPlaneRrefSimSource aircraft identity', () => {
  it('обогащает sample валидированным acf ICAO/title и логирует один раз', async () => {
    const socket = new FakeSocket();
    const log = logger();
    const source = createSource(socket, { logger: log });
    const samples: TelemetrySample[] = [];
    source.on('sample', (sample) => samples.push(sample));

    await connectWithFirstDatagram(source, socket);
    socket.emitMessage(sampleDatagram({ onGround: true }));

    expect(samples).toHaveLength(1);
    expect(samples[0]?.atc_model).toBe('A20N');
    expect(samples[0]?.atc_model).not.toBe('ZZZZ');
    expect(samples[0]?.title).toBe('Airbus A320neo');
    expect(samples[0]?.aircraft_icao_source).toBe('xplane_acf');

    const identityLogs = log.info.mock.calls.filter(
      ([, meta]) => (meta as Record<string, unknown> | undefined)?.aircraft_icao_source === 'xplane_acf',
    );
    expect(identityLogs).toHaveLength(1);
    expect(identityLogs[0]?.[1]).toMatchObject({
      transport: 'xp-udp-rref',
      aircraft_icao_source: 'xplane_acf',
      icao: 'A20N',
    });
    expect(identityLogs[0]?.[1]).not.toHaveProperty('path');
    expect(identityLogs[0]?.[1]).not.toHaveProperty('title');

    await source.disconnect();
  });

  it('без identity оставляет null (без ZZZZ и без подмены)', async () => {
    const socket = new FakeSocket();
    const source = createSource(socket, { aircraftIdentity: () => null });
    const samples: TelemetrySample[] = [];
    source.on('sample', (sample) => samples.push(sample));

    await connectWithFirstDatagram(source, socket);
    socket.emitMessage(sampleDatagram({ onGround: true }));

    expect(samples[0]?.atc_model).toBeNull();
    expect(samples[0]?.title).toBeNull();
    expect(samples[0]?.aircraft_icao_source).toBeUndefined();

    await source.disconnect();
  });

  it('на земле перепроверяет не чаще 30 с; в воздухе не опрашивает', async () => {
    const socket = new FakeSocket();
    let now = 0;
    const resolve = vi.fn(() => IDENTITY);
    const source = createSource(socket, {
      now: () => now,
      aircraftIdentity: resolve,
      aircraftIdentityRecheckMs: 30_000,
    });
    source.on('sample', () => {});

    await connectWithFirstDatagram(source, socket);
    expect(resolve).toHaveBeenCalledTimes(1);

    now = 29_999;
    socket.emitMessage(sampleDatagram({ onGround: true }));
    expect(resolve).toHaveBeenCalledTimes(1);

    now = 30_000;
    socket.emitMessage(sampleDatagram({ onGround: true }));
    expect(resolve).toHaveBeenCalledTimes(2);

    now = 60_000;
    socket.emitMessage(sampleDatagram({ onGround: false }));
    expect(resolve).toHaveBeenCalledTimes(2);

    now = 60_001;
    socket.emitMessage(sampleDatagram({ onGround: true }));
    expect(resolve).toHaveBeenCalledTimes(3);

    await source.disconnect();
  });
});

describe('XPlaneRrefSimSource → FlightRecorder', () => {
  it('end-to-end: рейс получает A20N с aircraft_icao_source=xplane_acf', async () => {
    const socket = new FakeSocket();
    const source = createSource(socket);
    const buffer = new MemoryOutboxBuffer();
    const recorder = new FlightRecorder({
      source,
      buffer,
      loadQuarantineS: 0,
      endEngineOffS: 3,
      endStationaryS: 600,
      idGenerator: seededUuidGenerator(),
    });
    const started = vi.fn();
    recorder.on('flight_started', started);

    try {
      const start = recorder.start();
      socket.emitMessage(sampleDatagram({ onGround: true }));
      await start;
      socket.emitMessage(sampleDatagram({ onGround: true }));

      expect(started).toHaveBeenCalledTimes(1);
      expect(started.mock.calls[0]?.[0]).toMatchObject({
        aircraft_icao: 'A20N',
        aircraft_icao_source: 'xplane_acf',
      });

      const flight = buffer.loadFlights()[0];
      expect(flight?.aircraft_icao).toBe('A20N');
      expect(flight?.stats).toMatchObject({
        aircraft_icao_source: 'xplane_acf',
      });
    } finally {
      await recorder.stop();
    }
  });
});
