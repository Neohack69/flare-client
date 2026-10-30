import { describe, expect, it } from 'vitest';

import {
  detectImplausibleJump,
  detectImplausibleJumpBeforeTouch,
  IMPLAUSIBLE_JUMP_LIMITS,
  isImplausibleShortFlight,
} from './index';

const BASE = Date.parse('2026-10-21T12:00:00.000Z');

function at(offsetS: number, overrides: Record<string, unknown> = {}) {
  return {
    ts: new Date(BASE + offsetS * 1000).toISOString(),
    lat: 40.886,
    lon: 14.291,
    alt_ft: 850,
    ...overrides,
  };
}

describe('P2: детект неправдоподобного скачка трека', () => {
  it('31 274 ft → 294 ft за один кадр — прыжок высоты', () => {
    const jump = detectImplausibleJump([
      at(0, { alt_ft: 31_274 }),
      at(1, { alt_ft: 294 }),
    ]);
    expect(jump.detected).toBe(true);
    expect(jump.kind).toBe('altitude');
    expect(jump.deltaFt).toBe(30_980);
    expect(jump.dtS).toBe(1);
  });

  it('31 274 ft → 294 ft в окне 30 с до касания — прыжок', () => {
    const points = [at(0, { alt_ft: 31_274 }), at(1, { alt_ft: 294 })];
    const jump = detectImplausibleJumpBeforeTouch(points, at(1).ts);
    expect(jump.detected).toBe(true);
  });

  it('горизонтальный скачок >5 км за <2 с — прыжок', () => {
    const jump = detectImplausibleJump([
      at(0, { lat: 55.972, lon: 37.414 }),
      at(1, { lat: 40, lon: -74 }),
    ]);
    expect(jump.detected).toBe(true);
    expect(jump.kind).toBe('horizontal');
    expect(jump.distanceM).toBeGreaterThan(IMPLAUSIBLE_JUMP_LIMITS.maxHorizontalJumpM);
  });

  it('нормальное снижение на заходе не является прыжком', () => {
    const jump = detectImplausibleJump([
      at(0, { alt_ft: 1_500 }),
      at(1, { alt_ft: 1_400 }),
      at(2, { alt_ft: 1_300 }),
      at(3, { alt_ft: 1_200, lat: 40.8865, lon: 14.291 }),
    ]);
    expect(jump.detected).toBe(false);
  });

  it('длинная пауза не считается прыжком (это gap, а не телепорт)', () => {
    const jump = detectImplausibleJump([
      at(0, { alt_ft: 31_274 }),
      at(IMPLAUSIBLE_JUMP_LIMITS.maxGapS + 1, { alt_ft: 294 }),
    ]);
    expect(jump.detected).toBe(false);
  });

  it('sentinel-старт (null island) не «телепортирует» реальный рейс', () => {
    const jump = detectImplausibleJump([
      at(0, { lat: 0, lon: 90, alt_ft: 36 }),
      at(1, { lat: 55.972, lon: 37.414, alt_ft: 2_000 }),
    ]);
    expect(jump.detected).toBe(false);
  });

  it('короткий рейс выше 5 000 ft — неправдоподобен; нормальный — нет', () => {
    expect(isImplausibleShortFlight(31_274, 69)).toBe(true);
    expect(isImplausibleShortFlight(31_274, 121)).toBe(false);
    expect(isImplausibleShortFlight(4_000, 69)).toBe(false);
    expect(isImplausibleShortFlight(null, 69)).toBe(false);
  });
});
