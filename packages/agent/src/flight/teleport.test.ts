import { describe, expect, it } from 'vitest';

import {
  detectTeleport,
  isImplausiblePositionJump,
  TELEPORT_JUMP_LIMITS,
} from './teleport.js';
import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';

function at(offsetS: number, overrides: Parameters<typeof makeSample>[1] = {}) {
  return makeSample(isoAt(BASE_MS, offsetS * 1000), overrides);
}

describe('isImplausiblePositionJump', () => {
  it('без предыдущего сэмпла прыжка нет', () => {
    expect(isImplausiblePositionJump(null, at(0))).toBe(false);
  });

  it('нормальное движение на крейсере не считается телепортом', () => {
    // ~440 kt за 1 с ≈ 226 м; ниже порога имплицитной скорости.
    const previous = at(0, { lat: 55.972, lon: 37.414 });
    const current = at(1, { lat: 55.974, lon: 37.414 });
    expect(isImplausiblePositionJump(previous, current)).toBe(false);
  });

  it('то же место — не телепорт', () => {
    expect(isImplausiblePositionJump(at(0), at(1))).toBe(false);
  });

  it('огромный скачок позиции за секунду — телепорт', () => {
    const previous = at(0, { lat: 55.972, lon: 37.414 });
    const current = at(1, { lat: 40, lon: -74 });
    expect(isImplausiblePositionJump(previous, current)).toBe(true);
  });

  it('микродрожание GPS ниже minDistanceM игнорируется', () => {
    const previous = at(0, { lat: 55.972, lon: 37.414 });
    // ~50 м за 1 с — ниже minDistanceM.
    const current = at(1, { lat: 55.97245, lon: 37.414 });
    expect(isImplausiblePositionJump(previous, current)).toBe(false);
  });

  it('разрыв записи больше maxGapS — пауза, а не телепорт', () => {
    const previous = at(0, { lat: 55.972, lon: 37.414 });
    const current = at(TELEPORT_JUMP_LIMITS.maxGapS + 1, { lat: 40, lon: -74 });
    expect(isImplausiblePositionJump(previous, current)).toBe(false);
  });

  it('загрузка 31 274 ft → 294 ft за один кадр — телепорт по высоте', () => {
    const previous = at(0, { alt_ft: 31_274 });
    const current = at(1, { alt_ft: 294 });
    const detected = detectTeleport(previous, current);
    expect(detected.detected).toBe(true);
    expect(detected.kind).toBe('altitude');
    expect(detected.altitudeDeltaFt).toBe(30_980);
  });

  it('горизонтальный скачок >5 км за <2 с — телепорт', () => {
    const previous = at(0, { lat: 55.972, lon: 37.414 });
    const current = at(1.5, { lat: 40, lon: -74 });
    const detected = detectTeleport(previous, current);
    expect(detected.detected).toBe(true);
    expect(detected.kind).toBe('horizontal');
    expect(detected.horizontalM).toBeGreaterThan(TELEPORT_JUMP_LIMITS.maxHorizontalJumpM);
  });
});
