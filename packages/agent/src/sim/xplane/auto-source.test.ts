import { describe, expect, it, vi } from 'vitest';

import type {
  SimSource,
  SimSourceCapabilities,
  SimSourceDiagnostics,
  SimSourceEvents,
  SimSourceId,
  SimSourceOpenInfo,
} from '../source.js';
import type { TelemetrySample } from '../types.js';
import { TypedEmitter } from '../../util/emitter.js';
import { XPlaneAutoSimSource } from './auto-source.js';
import { buildXPlaneSample } from './values.js';

const OPEN_INFO: SimSourceOpenInfo = {
  applicationName: 'X-Plane 12',
  applicationVersion: '12.1.4',
  simConnectVersion: 'n/a',
  sim: 'xplane12',
  simVersion: '12.1.4',
  adapter: 'stub',
  protocol: 'websocket',
};

class StubSource extends TypedEmitter<SimSourceEvents> implements SimSource {
  readonly id: SimSourceId = 'xplane12';
  readonly readOnly = true;
  isConnected = false;
  connectCalls = 0;
  connectError: Error | null = null;

  constructor(readonly adapterLabel: string) {
    super();
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get capabilities(): SimSourceCapabilities {
    return {
      sim: 'xplane12',
      maxSampleHz: 10,
      pauseDetection: 'direct',
      adapter: this.adapterLabel,
    };
  }

  async connect(): Promise<SimSourceOpenInfo> {
    this.connectCalls += 1;
    if (this.connectError) throw this.connectError;
    this.isConnected = true;
    const info: SimSourceOpenInfo = { ...OPEN_INFO, adapter: this.adapterLabel };
    this.emit('open', info);
    return info;
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;
    this.isConnected = false;
    this.emit('disconnect', 'stub disconnect');
  }

  diagnostics(): SimSourceDiagnostics | null {
    return null;
  }

  pushSample(sample: TelemetrySample): void {
    this.emit('sample', sample);
  }
}

const SAMPLE = buildXPlaneSample(new Map(), '2026-10-16T00:00:00.000Z');

function logger() {
  const entries: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  return {
    entries,
    info: (message: string, meta?: Record<string, unknown>) => entries.push({ message, meta }),
    warn: (message: string, meta?: Record<string, unknown>) => entries.push({ message, meta }),
  };
}

describe('XPlaneAutoSimSource', () => {
  it('auto: Web API первым, при успехе RREF не трогаем', async () => {
    const web = new StubSource('xp-web-api-v1');
    const rref = new StubSource('xp-udp-rref');
    const source = new XPlaneAutoSimSource({ web, rref });

    const info = await source.connect();
    expect(info.adapter).toBe('xp-web-api-v1');
    expect(info.transportDegraded).toBeUndefined();
    expect(web.connectCalls).toBe(1);
    expect(rref.connectCalls).toBe(0);
    expect(source.connected).toBe(true);
    expect(source.capabilities.adapter).toBe('xp-web-api-v1');
  });

  it('auto: Web API недоступен → фолбэк на RREF + лог', async () => {
    const web = new StubSource('xp-web-api-v1');
    web.connectError = new Error('web down');
    const rref = new StubSource('xp-udp-rref');
    const log = logger();
    const source = new XPlaneAutoSimSource({ web, rref, logger: log });

    const info = await source.connect();
    expect(info.adapter).toBe('xp-udp-rref');
    // Деградация Web API → RREF видна в open-info (UI показывает предупреждение).
    expect(info.transportDegraded).toBe(true);
    expect(web.connectCalls).toBe(1);
    expect(rref.connectCalls).toBe(1);
    expect(log.entries.some((entry) => entry.message.includes('falling back to RREF'))).toBe(true);
  });

  it('auto: оба недоступны → connect error', async () => {
    const web = new StubSource('xp-web-api-v1');
    web.connectError = new Error('web down');
    const rref = new StubSource('xp-udp-rref');
    rref.connectError = new Error('rref down');
    const source = new XPlaneAutoSimSource({ web, rref });

    await expect(source.connect()).rejects.toThrow(/X-Plane 12 unavailable/);
    expect(source.connected).toBe(false);
  });

  it("preference 'rref' → Web API не вызывается", async () => {
    const web = new StubSource('xp-web-api-v1');
    const rref = new StubSource('xp-udp-rref');
    const source = new XPlaneAutoSimSource({ web, rref, preference: 'rref' });

    const info = await source.connect();
    expect(info.adapter).toBe('xp-udp-rref');
    // Явный выбор оператора — не деградация.
    expect(info.transportDegraded).toBeUndefined();
    expect(web.connectCalls).toBe(0);
  });

  it('форвардит sample/disconnect активного транспорта', async () => {
    const web = new StubSource('xp-web-api-v1');
    const rref = new StubSource('xp-udp-rref');
    const source = new XPlaneAutoSimSource({ web, rref });
    const samples: TelemetrySample[] = [];
    const disconnects: Array<string | undefined> = [];
    source.on('sample', (sample) => samples.push(sample));
    source.on('disconnect', (reason) => disconnects.push(reason));

    await source.connect();
    web.pushSample(SAMPLE);
    expect(samples).toEqual([SAMPLE]);

    await source.disconnect();
    expect(source.connected).toBe(false);
    expect(disconnects).toEqual(['stub disconnect']);
  });

  it('diagnostics прокидывается от активного транспорта', async () => {
    const web = new StubSource('xp-web-api-v1');
    const diagnostics = vi.fn(() => ({ message: 'stub', meta: {} }));
    web.diagnostics = diagnostics;
    const source = new XPlaneAutoSimSource({ web, rref: new StubSource('xp-udp-rref') });
    expect(source.diagnostics()).toBeNull();
    await source.connect();
    expect(source.diagnostics()).toEqual({ message: 'stub', meta: {} });
  });
});
