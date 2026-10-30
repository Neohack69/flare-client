import { describe, expect, it } from 'vitest';

import { MockSimConnectAdapter } from '../sim/mock-adapter.js';
import type { SimSourceOpenInfo } from '../sim/source.js';
import type { TelemetrySample } from '../sim/types.js';
import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';
import { runSimConnectSpike } from './run.js';

class RejectingAdapter extends MockSimConnectAdapter {
  override async connect(): Promise<SimSourceOpenInfo> {
    throw new Error('MSFS 2024 не запущен');
  }
}

function sampleAt(index: number): TelemetrySample {
  return makeSample(isoAt(BASE_MS, index * 100));
}

describe('runSimConnectSpike', () => {
  it('GO: собирает сэмплы с mock-адаптера и завершается сам', async () => {
    const adapter = new MockSimConnectAdapter();
    const runPromise = runSimConnectSpike({
      adapter,
      maxSamples: 5,
      minSamples: 5,
      durationMs: 5_000,
      idleTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let index = 0; index < 5; index += 1) adapter.pushSample(sampleAt(index));

    const result = await runPromise;
    expect(result.report.verdict).toBe('GO');
    expect(result.exitCode).toBe(0);
    expect(result.report.samples.count).toBe(5);
    expect(result.report.connection.finishedBy).toBe('max_samples');
    expect(adapter.connected).toBe(false);
  });

  it('NO-GO без данных: срабатывает idle-таймаут, процесс не висит', async () => {
    const adapter = new MockSimConnectAdapter();
    const result = await runSimConnectSpike({
      adapter,
      maxSamples: 5,
      minSamples: 5,
      durationMs: 5_000,
      idleTimeoutMs: 20,
      connectTimeoutMs: 500,
    });

    expect(result.report.verdict).toBe('NO-GO');
    expect(result.exitCode).toBe(2);
    expect(result.report.connection.finishedBy).toBe('idle_timeout');
    expect(result.report.reasons.join(' ')).toContain('данные');
  });

  it('NO-GO при ошибке подключения (сим не запущен)', async () => {
    const adapter = new RejectingAdapter();
    const result = await runSimConnectSpike({
      adapter,
      maxSamples: 5,
      minSamples: 5,
      durationMs: 5_000,
      idleTimeoutMs: 500,
      connectTimeoutMs: 500,
    });

    expect(result.report.verdict).toBe('NO-GO');
    expect(result.report.connection.finishedBy).toBe('connect_error');
    expect(result.report.reasons.join(' ')).toContain('MSFS 2024 не запущен');
  });

  it('завершается по disconnect без зависших таймеров', async () => {
    const adapter = new MockSimConnectAdapter();
    const runPromise = runSimConnectSpike({
      adapter,
      maxSamples: 0,
      minSamples: 2,
      durationMs: 5_000,
      idleTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    adapter.pushSample(sampleAt(0));
    adapter.pushSample(sampleAt(1));
    adapter.simulateDisconnect('sim quit');

    const result = await runPromise;
    expect(result.report.connection.finishedBy).toBe('disconnect');
    expect(result.report.connection.disconnectReason).toBe('sim quit');
    expect(result.report.verdict).toBe('GO');
  });
});
