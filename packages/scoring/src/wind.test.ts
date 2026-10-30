import { describe, expect, it } from 'vitest';

import { circularMeanDeg, computeWindComponents } from './wind.js';

describe('computeWindComponents', () => {
  it('ветер в лоб ВПП — встречный, без боковой', () => {
    expect(computeWindComponents(0, 20, 0)).toEqual({ headwind_kt: 20, crosswind_kt: 0 });
  });

  it('ветер с хвоста — отрицательный встречный', () => {
    expect(computeWindComponents(180, 20, 0)).toEqual({ headwind_kt: -20, crosswind_kt: 0 });
  });

  it('ветер справа положителен по crosswind', () => {
    expect(computeWindComponents(90, 20, 0)).toEqual({ headwind_kt: 0, crosswind_kt: 20 });
  });

  it('ветер слева отрицателен по crosswind', () => {
    expect(computeWindComponents(270, 20, 0)).toEqual({ headwind_kt: 0, crosswind_kt: -20 });
  });

  it('под 45° даёт равные составляющие', () => {
    const result = computeWindComponents(45, 10, 0);
    expect(result?.headwind_kt).toBeCloseTo(7.1, 1);
    expect(result?.crosswind_kt).toBeCloseTo(7.1, 1);
  });

  it('нормализует углы вокруг 0/360', () => {
    const result = computeWindComponents(350, 10, 10);
    expect(result?.headwind_kt).toBeCloseTo(9.4, 1);
    expect(result?.crosswind_kt).toBeCloseTo(-3.4, 1);
  });

  it('относительное направление не зависит от общей нормализации', () => {
    expect(computeWindComponents(35, 12, 35)).toEqual({ headwind_kt: 12, crosswind_kt: 0 });
  });

  it.each([
    [null, 10, 0],
    [0, null, 0],
    [0, 10, null],
    [Number.NaN, 10, 0],
    [0, Number.NaN, 0],
    [0, 10, Number.NaN],
    [0, -5, 0],
  ])('возвращает null при отсутствующих/некорректных входах (%s, %s, %s)', (dir, speed, rwy) => {
    expect(computeWindComponents(dir, speed, rwy)).toBeNull();
  });
});

describe('circularMeanDeg', () => {
  it('усредняет направления через переход 0/360', () => {
    expect(circularMeanDeg([350, 10])).toBeCloseTo(0, 1);
  });

  it('обычные направления усредняет как арифметика', () => {
    expect(circularMeanDeg([80, 100])).toBeCloseTo(90, 1);
  });

  it('игнорирует не-числа и пустой список даёт null', () => {
    expect(circularMeanDeg([Number.NaN, 90])).toBeCloseTo(90, 1);
    expect(circularMeanDeg([])).toBeNull();
  });
});
