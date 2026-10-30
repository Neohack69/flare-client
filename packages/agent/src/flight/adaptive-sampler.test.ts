import { describe, expect, it } from 'vitest';

import { AdaptiveSampler, decimateSamples } from './adaptive-sampler.js';
import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';

function at(offsetS: number, overrides: Parameters<typeof makeSample>[1] = {}) {
  return makeSample(isoAt(BASE_MS, offsetS * 1000), overrides);
}

describe('decimateSamples', () => {
  it('прореживает до целевой частоты, сохраняя первый сэмпл', () => {
    const samples = Array.from({ length: 50 }, (_, i) => at(i * 0.1));
    const result = decimateSamples(samples, 10);
    expect(result[0]).toBe(samples[0]);
    expect(result.length).toBeGreaterThanOrEqual(45);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('возвращает пустой массив для пустого входа', () => {
    expect(decimateSamples([], 10)).toEqual([]);
  });
});

describe('AdaptiveSampler', () => {
  it('в круизе пишет ~1 Гц', () => {
    const sampler = new AdaptiveSampler();
    const decisions = Array.from({ length: 10 }, (_, i) => sampler.push(at(i)));
    const recorded = decisions.filter((d) => d.record);
    expect(recorded).toHaveLength(10);
    expect(decisions[0]?.rateHz).toBe(1);
    expect(sampler.currentRateHz).toBe(1);
  });

  it('децимирует высокочастотный поток до 1 Гц в круизе', () => {
    const sampler = new AdaptiveSampler();
    let recorded = 0;
    for (let i = 0; i < 100; i += 1) {
      if (sampler.push(at(i * 0.1)).record) recorded += 1;
    }
    // 10 секунд при 10 Гц → ~10 записей (допуск на джиттер кадров).
    expect(recorded).toBeGreaterThanOrEqual(9);
    expect(recorded).toBeLessThanOrEqual(12);
  });

  it('markTouchdown (20 Гц) отдаёт backfill за 30 с до касания', () => {
    const sampler = new AdaptiveSampler();
    for (let i = 0; i <= 800; i += 1) {
      sampler.push(at(i * 0.05));
    }
    const { backfill } = sampler.markTouchdown(isoAt(BASE_MS, 800 * 50));

    expect(backfill.length).toBeGreaterThan(500);
    expect(backfill.length).toBeLessThanOrEqual(601);
    const first = Date.parse(backfill[0]?.ts ?? '');
    const last = Date.parse(backfill[backfill.length - 1]?.ts ?? '');
    expect(last - first).toBeLessThanOrEqual(30_000);
    expect(last).toBeLessThan(Date.parse(isoAt(BASE_MS, 800 * 50)));
  });

  it('в окне касания переключается на 20 Гц и закрывается через 30 с', () => {
    const sampler = new AdaptiveSampler();
    sampler.push(at(0));
    sampler.markTouchdown(isoAt(BASE_MS, 0));
    expect(sampler.currentRateHz).toBe(20);
    expect(sampler.touchdownHz).toBe(20);

    let recorded = 0;
    for (let i = 1; i <= 20; i += 1) {
      if (sampler.push(at(i * 0.05)).record) recorded += 1;
    }
    expect(recorded).toBeGreaterThanOrEqual(19);

    sampler.push(at(31));
    expect(sampler.currentRateHz).toBe(1);
  });

  it('bounce продлевает окно 20 Гц до стабилизации', () => {
    const sampler = new AdaptiveSampler();
    sampler.push(at(0));
    sampler.markTouchdown(isoAt(BASE_MS, 0));
    sampler.extendWindow(isoAt(BASE_MS, 20_000));

    sampler.push(at(40));
    expect(sampler.currentRateHz).toBe(20);

    sampler.push(at(51));
    expect(sampler.currentRateHz).toBe(1);
  });

  it('rolling-буфер не превышает настроенную глубину', () => {
    const sampler = new AdaptiveSampler({ bufferS: 10 });
    for (let i = 0; i <= 300; i += 1) sampler.push(at(i * 0.1));
    const buffer = sampler.bufferedSamples;
    const first = Date.parse(buffer[0]?.ts ?? '');
    const last = Date.parse(buffer[buffer.length - 1]?.ts ?? '');
    expect(last - first).toBeLessThanOrEqual(10_100);
  });

  it('reset очищает состояние', () => {
    const sampler = new AdaptiveSampler();
    sampler.push(at(0));
    sampler.markTouchdown(isoAt(BASE_MS, 0));
    sampler.reset();
    expect(sampler.windowActive).toBe(false);
    expect(sampler.bufferedSamples).toHaveLength(0);
  });
});
