import { describe, expect, it } from 'vitest';

import { bankWindowStats, type BankWindowSample } from './bank-window.js';

const BASE_MS = Date.parse('2026-01-01T12:00:00.000Z');

function sample(
  second: number,
  agl_ft: number | null,
  bank_deg: number | null,
  on_ground = false,
): BankWindowSample {
  return {
    ts: new Date(BASE_MS + second * 1000).toISOString(),
    agl_ft,
    bank_deg,
    on_ground,
  };
}

/** Ровный заход: 1100 → 400 ft за 70 с (по секунде), крен по умолчанию 0°. */
function descent(banks: Readonly<Record<number, number>> = {}): BankWindowSample[] {
  const samples: BankWindowSample[] = [];
  for (let second = 0; second <= 70; second += 1) {
    const agl = 1100 - second * 10;
    samples.push(sample(second, agl, banks[second] ?? 0));
  }
  return samples;
}

describe('bankWindowStats (A2)', () => {
  it('считает одно отклонение с длительностью ≥ 1 с', () => {
    const stats = bankWindowStats(descent({ 14: 12, 15: 12, 16: 7 }));
    expect(stats).not.toBeNull();
    expect(stats?.episodes).toBe(1);
    expect(stats?.maxAbsDeg).toBe(12);
  });

  it('гистерезис: 9° не закрывает эпизод, два эпизода считаются раздельно', () => {
    const stats = bankWindowStats(
      descent({ 13: 11, 14: 9, 15: 12, 16: 7, 40: -14, 41: -14, 42: 6 }),
    );
    expect(stats?.episodes).toBe(2);
    expect(stats?.maxAbsDeg).toBe(14);
  });

  it('выброс короче 1 с игнорируется', () => {
    const samples = descent({ 20: 15 });
    samples.push(sample(20.4, 896, 4));
    const stats = bankWindowStats(samples);
    expect(stats?.episodes).toBe(0);
    expect(stats?.maxAbsDeg).toBe(15);
  });

  it('граница окна: крен до 1000 ft и ниже 500 ft не учитывается', () => {
    // 1000 ft — 10-я секунда, 500 ft — 60-я.
    const stats = bankWindowStats(
      descent({ 9: 20, 10: 12, 11: 12, 12: 6, 58: -13, 59: -13, 60: 6 }),
    );
    expect(stats?.episodes).toBe(2);
    expect(stats?.maxAbsDeg).toBe(13);
  });

  it('без AGL или без пересечения 500 ft — null', () => {
    expect(bankWindowStats([sample(0, null, 12), sample(1, 900, 12)])).toBeNull();
    expect(bankWindowStats(descent().filter((entry) => (entry.agl_ft ?? 0) > 600))).toBeNull();
  });

  it('без измерений крена в окне — null (не подставляем 0)', () => {
    const stats = bankWindowStats(descent().map((entry) => ({ ...entry, bank_deg: null })));
    expect(stats).toBeNull();
  });
});
