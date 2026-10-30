import { describe, expect, it, vi } from 'vitest';

import type { TelemetrySample } from '../types.js';
import { XPLANE_DATAREFS } from './datarefs.js';
import { XPlaneRestClient } from './http.js';
import { METERS_TO_FEET } from './values.js';
import { XPlaneWebApiSimSource, type XPlaneSocket } from './web-api-source.js';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

class FakeSocket implements XPlaneSocket {
  readonly sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.({});
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  emitClose(): void {
    this.onclose?.({});
  }
}

interface FetchFixture {
  fetchImpl: typeof fetch;
  ids: Map<string, number>;
}

function makeFetch(options: { missing?: readonly string[]; forbidden?: boolean } = {}): FetchFixture {
  const ids = new Map<string, number>();
  const missing = new Set(options.missing ?? []);
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    if (options.forbidden) return { status: 403, ok: false, text: async () => '' } as unknown as Response;
    if (url.endsWith('/api/capabilities')) {
      return jsonResponse({ api: { versions: ['v1', 'v3'] }, 'x-plane': { version: '12.1.4' } });
    }
    const match = /filter\[name\]=([^&]+)/.exec(url);
    if (match) {
      const name = decodeURIComponent(match[1] ?? '');
      if (missing.has(name)) return jsonResponse({ data: [] });
      if (!ids.has(name)) ids.set(name, ids.size + 1);
      return jsonResponse({ data: [{ id: ids.get(name), name, value_type: 'float' }] });
    }
    return jsonResponse({}, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, ids };
}

function makeRest(fixture: FetchFixture): XPlaneRestClient {
  return new XPlaneRestClient({ baseUrl: 'http://127.0.0.1:8086', fetchImpl: fixture.fetchImpl });
}

function makeSource(fixture: FetchFixture) {
  let socket: FakeSocket | null = null;
  let clock = 0;
  const source = new XPlaneWebApiSimSource({
    rest: makeRest(fixture),
    connectTimeoutMs: 50,
    now: () => (clock += 1000),
    socketFactory: (url) => {
      socket = new FakeSocket(url);
      return socket;
    },
  });
  return {
    source,
    get socket(): FakeSocket {
      if (!socket) throw new Error('socket not created yet');
      return socket;
    },
    hasSocket: () => socket !== null,
  };
}

describe('XPlaneWebApiSimSource', () => {
  it('capabilities → резолв id → subscribe → update → sample', async () => {
    const fixture = makeFetch();
    const harness = makeSource(fixture);
    const samples: TelemetrySample[] = [];
    harness.source.on('sample', (sample) => samples.push(sample));

    const connect = harness.source.connect();
    await vi.waitFor(() => {
      if (!harness.hasSocket()) throw new Error('socket pending');
    });
    harness.socket.emitOpen();
    const info = await connect;

    expect(info.sim).toBe('xplane12');
    expect(info.simVersion).toBe('12.1.4');
    expect(info.adapter).toBe('xp-web-api-v1');
    expect(info.protocol).toBe('websocket');
    expect(harness.socket.url).toBe('ws://127.0.0.1:8086/api/v3');
    expect(harness.source.capabilities).toMatchObject({
      sim: 'xplane12',
      pauseDetection: 'direct',
      adapter: 'xp-web-api-v1',
    });

    expect(harness.socket.sent[0]).toContain('dataref_subscribe_values');
    const idOf = (name: string): number => {
      const id = fixture.ids.get(name);
      if (id === undefined) throw new Error(`no resolved id for ${name}`);
      return id;
    };
    harness.socket.emitMessage(
      JSON.stringify({
        type: 'dataref_update_values',
        params: {
          datarefs: [
            { id: idOf(XPLANE_DATAREFS.latitude.dataref), value: 50.5 },
            { id: idOf(XPLANE_DATAREFS.elevation.dataref), value: 1000 },
          ],
        },
      }),
    );

    expect(samples).toHaveLength(1);
    expect(samples[0]?.lat).toBe(50.5);
    expect(samples[0]?.alt_ft).toBeCloseTo(1000 * METERS_TO_FEET, 6);
  });

  it('реальный кадр data:{} (XP 12.4.3) → sample + base64-декод identity', async () => {
    const fixture = makeFetch();
    const harness = makeSource(fixture);
    const samples: TelemetrySample[] = [];
    harness.source.on('sample', (sample) => samples.push(sample));

    const connect = harness.source.connect();
    await vi.waitFor(() => {
      if (!harness.hasSocket()) throw new Error('socket pending');
    });
    harness.socket.emitOpen();
    await connect;

    const idOf = (name: string): number => {
      const id = fixture.ids.get(name);
      if (id === undefined) throw new Error(`no resolved id for ${name}`);
      return id;
    };
    harness.socket.emitMessage(
      JSON.stringify({
        data: {
          [String(idOf(XPLANE_DATAREFS.latitude.dataref))]: 41.270451728279141,
          [String(idOf(XPLANE_DATAREFS.acf_ICAO.dataref))]:
            'QTIwTgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
          [String(idOf(XPLANE_DATAREFS.acf_descrip.dataref))]:
            'QTMyMCB3aXRoIGhpZ2ggZmlkZWxpdHkgc3lzdGVtIG1vZGVsbGluZwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        },
        type: 'dataref_update_values',
      }),
    );

    expect(samples).toHaveLength(1);
    expect(samples[0]?.lat).toBe(41.270451728279141);
    expect(samples[0]?.atc_model).toBe('A20N');
    expect(samples[0]?.title).toBe('A320 with high fidelity system modelling');
  });

  it('неизвестный dataref → попадает в диагностику как unavailable', async () => {
    const fixture = makeFetch({ missing: [XPLANE_DATAREFS.y_agl.dataref] });
    const harness = makeSource(fixture);
    const connect = harness.source.connect();
    await vi.waitFor(() => {
      if (!harness.hasSocket()) throw new Error('socket pending');
    });
    harness.socket.emitOpen();
    await connect;

    const diagnostics = harness.source.diagnostics();
    expect(diagnostics?.meta.unavailable).toBe(1);
    expect(diagnostics?.message).toContain('unavailable');
  });

  it('403 на capabilities → XPlaneWebApiError (forbidden)', async () => {
    const fixture = makeFetch({ forbidden: true });
    const harness = makeSource(fixture);
    await expect(harness.source.connect()).rejects.toMatchObject({ reason: 'forbidden' });
    expect(harness.source.connected).toBe(false);
  });

  it('пауза сима глушит поток; после снятия — кадр из last-known', async () => {
    const fixture = makeFetch();
    const harness = makeSource(fixture);
    const samples: TelemetrySample[] = [];
    harness.source.on('sample', (sample) => samples.push(sample));

    const connect = harness.source.connect();
    await vi.waitFor(() => {
      if (!harness.hasSocket()) throw new Error('socket pending');
    });
    harness.socket.emitOpen();
    await connect;

    const id = (name: string): number => fixture.ids.get(name) ?? 0;
    const update = (name: string, value: number): void => {
      harness.socket.emitMessage(
        JSON.stringify({
          type: 'dataref_update_values',
          params: { datarefs: [{ id: id(name), value }] },
        }),
      );
    };

    update(XPLANE_DATAREFS.paused.dataref, 1);
    update(XPLANE_DATAREFS.latitude.dataref, 50);
    expect(samples).toHaveLength(0);

    update(XPLANE_DATAREFS.paused.dataref, 0);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.lat).toBe(50);

    update(XPLANE_DATAREFS.latitude.dataref, 51);
    expect(samples).toHaveLength(2);
    expect(samples[1]?.lat).toBe(51);
  });

  it('закрытие WebSocket → disconnect и connected=false', async () => {
    const fixture = makeFetch();
    const harness = makeSource(fixture);
    const reasons: Array<string | undefined> = [];
    harness.source.on('disconnect', (reason) => reasons.push(reason));

    const connect = harness.source.connect();
    await vi.waitFor(() => {
      if (!harness.hasSocket()) throw new Error('socket pending');
    });
    harness.socket.emitOpen();
    await connect;
    expect(harness.source.connected).toBe(true);

    harness.socket.emitClose();
    expect(harness.source.connected).toBe(false);
    expect(reasons).toEqual(['websocket closed']);
  });
});
