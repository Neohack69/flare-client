import { describe, expect, it } from 'vitest';

import {
  AGL_DATUM_DEFAULTS,
  AGL_DATUM_VERSION,
  measureAglDatumOffset,
  toWheelHeightFt,
  type GroundHeightSample,
} from './agl-datum.js';

/** Наземная площадка стоянки: `n` сэмплов `agl` при нулевой скорости. */
function parked(agl: number, n = 10): GroundHeightSample[] {
  return Array.from({ length: n }, () => ({ on_ground: true, groundspeed_kt: 0, agl_ft: agl }));
}

describe('measureAglDatumOffset (FOQA-DATUM-1)', () => {
  it('(a) A220-like: площадка agl≈10 ft → датум 10 ft, колесо ≈2 ft на касании', () => {
    // Наблюдение на a4be181d-…: agl 10.0–10.1 ft на стоянке, 12.18 ft (radio
    // height) и flare 15.29 ft — это высоты опорной точки, не колёс.
    const samples: GroundHeightSample[] = [
      ...parked(9.9, 3),
      ...parked(10.0, 8),
      ...parked(10.1, 4),
    ];
    const offset = measureAglDatumOffset(samples);
    expect(offset).toBe(10);

    const wheelAtTouchdown = toWheelHeightFt(12.18, offset);
    expect(wheelAtTouchdown).toEqual({ value: 2.2, calibrated: true });

    const flareWheel = toWheelHeightFt(15.29, offset);
    expect(flareWheel).toEqual({ value: 5.3, calibrated: true });
  });

  it('(b) ~0 offset (C172-like): колесо совпадает с опорной точкой', () => {
    const offset = measureAglDatumOffset(parked(0, 6));
    expect(offset).toBe(0);
    expect(toWheelHeightFt(50, offset)).toEqual({ value: 50, calibrated: true });
    expect(toWheelHeightFt(0, offset)).toEqual({ value: 0, calibrated: true });
  });

  it('(c) нет измеримой площадки → честный null / не калибровано', () => {
    expect(measureAglDatumOffset([])).toBeNull();
    // Меньше minGroundSamples наземных сэмплов — не верим.
    expect(measureAglDatumOffset(parked(10, AGL_DATUM_DEFAULTS.minGroundSamples - 1))).toBeNull();
    // Все сэмплы в воздухе — площадки нет.
    expect(
      measureAglDatumOffset([
        { on_ground: false, groundspeed_kt: 140, agl_ft: 1200 },
        { on_ground: false, groundspeed_kt: 130, agl_ft: 800 },
      ]),
    ).toBeNull();

    // Неколиброванная высота колёс не подделывается.
    expect(toWheelHeightFt(12.18, null)).toEqual({ value: null, calibrated: false });
    expect(toWheelHeightFt(null, null)).toEqual({ value: null, calibrated: false });
  });

  it('исключает быстрые наземные сэмплы (разбег/пробег) и держит медиану', () => {
    const samples: GroundHeightSample[] = [
      ...parked(10, 8),
      // Разбег/пробег: agl по-прежнему ~10, но скорость выше порога → мимо.
      { on_ground: true, groundspeed_kt: 80, agl_ft: 10 },
      { on_ground: true, groundspeed_kt: 120, agl_ft: 10 },
      // Выброс на стоянке не должен сдвинуть медиану.
      { on_ground: true, groundspeed_kt: 0, agl_ft: 99 },
    ];
    expect(measureAglDatumOffset(samples)).toBe(10);
  });

  it('неправдоподобный сдвиг (> maxOffsetFt) → null', () => {
    expect(measureAglDatumOffset(parked(80, 6))).toBeNull();
  });

  it('(d) детерминированность: одинаковый вход → одинаковый выход, без Date.now/random', () => {
    const samples = [...parked(10.0, 5), { on_ground: true, groundspeed_kt: 0, agl_ft: 10.1 }];
    const a = measureAglDatumOffset(samples);
    const b = measureAglDatumOffset(samples);
    expect(a).toBe(b);
    expect(a).toBe(10);

    const w1 = toWheelHeightFt(15.29, a);
    const w2 = toWheelHeightFt(15.29, a);
    expect(w1).toEqual(w2);
  });

  it('экспортирует версию правил', () => {
    expect(AGL_DATUM_VERSION).toBe('agl-datum/1');
  });
});
