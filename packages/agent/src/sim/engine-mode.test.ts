import { describe, expect, it } from 'vitest';

import { deriveEngineMode, maxThrottlePercent, runningEngineIndexes } from './engine-mode.js';

describe('deriveEngineMode (честные сигналы: reverse/idle/max)', () => {
  const base = {
    engineRunning: true,
    onGround: false,
    n1Percent: [80, 80, null, null],
    throttlePercent: [70, 70, null, null],
    reverseEngaged: false,
  };

  it('reverse — по однозначному признаку реверса', () => {
    expect(deriveEngineMode({ ...base, reverseEngaged: true, onGround: true })).toBe('reverse');
  });

  it('idle — тяга ≤ 10 % (live XP idle ≈ 8.2 %)', () => {
    expect(deriveEngineMode({ ...base, throttlePercent: [8.2, 8.2, null, null] })).toBe('idle');
  });

  it('takeoff_thrust — тяга ≥ 95 % и ВС на земле', () => {
    expect(
      deriveEngineMode({ ...base, onGround: true, throttlePercent: [98, 98, null, null] }),
    ).toBe('takeoff_thrust');
  });

  it('на земле и тяга высокая, но ВС в воздухе → unknown (не выдумываем фазу)', () => {
    expect(deriveEngineMode({ ...base, throttlePercent: [98, 98, null, null] })).toBe('unknown');
  });

  it('нет двигателя/тяги → unknown', () => {
    expect(deriveEngineMode({ ...base, engineRunning: false })).toBe('unknown');
    expect(deriveEngineMode({ ...base, throttlePercent: [null, null, null, null] })).toBe('unknown');
  });

  it('N1 фильтрует неработающие двигатели при выборе максимальной тяги', () => {
    expect(runningEngineIndexes([0, 60, null, 0])).toEqual([1]);
    expect(
      maxThrottlePercent([0, 80, 99, null], runningEngineIndexes([0, 60, null, 0])),
    ).toBe(80);
  });
});
