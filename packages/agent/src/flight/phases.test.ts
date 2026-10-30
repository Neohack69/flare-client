import { describe, expect, it } from 'vitest';

import { FlightPhaseDetector } from './phases.js';
import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';

function at(offsetS: number, overrides: Parameters<typeof makeSample>[1] = {}) {
  return makeSample(isoAt(BASE_MS, offsetS * 1000), overrides);
}

describe('FlightPhaseDetector', () => {
  it('стартует в on_ground и не меняет фазу на стоянке', () => {
    const detector = new FlightPhaseDetector();
    expect(detector.phase).toBe('on_ground');
    expect(detector.update(at(0, { gs_kt: 0 }))).toBeNull();
    expect(detector.phase).toBe('on_ground');
  });

  it('проходит полный цикл on_ground → taxi → takeoff → airborne → landing → on_ground', () => {
    const detector = new FlightPhaseDetector();
    const phases = [
      detector.update(at(0, { gs_kt: 0 }))?.to,
      detector.update(at(1, { gs_kt: 12 }))?.to,
      detector.update(at(5, { gs_kt: 60, agl_ft: 0 }))?.to,
      detector.update(at(6, { gs_kt: 120, on_ground: false, agl_ft: 40, vs_fpm: 1200 }))?.to,
      detector.update(at(60, { gs_kt: 140, on_ground: false, agl_ft: 320, vs_fpm: -650 }))?.to,
      detector.update(at(70, { gs_kt: 130, on_ground: true, agl_ft: 0, vs_fpm: -180 }))?.to,
    ];
    expect(phases).toEqual([undefined, 'taxi', 'takeoff', 'airborne', 'landing', 'on_ground']);
  });

  it('возвращает причины переходов', () => {
    const detector = new FlightPhaseDetector();
    expect(detector.update(at(0, { gs_kt: 10 }))?.reason).toBe('ground_movement');
    expect(detector.update(at(1, { gs_kt: 60 }))?.reason).toBe('takeoff_roll');
    expect(
      detector.update(at(2, { gs_kt: 100, on_ground: false, agl_ft: 30, vs_fpm: 900 }))?.reason,
    ).toBe('liftoff');
    expect(detector.update(at(3, { on_ground: false, agl_ft: 200, vs_fpm: -500 }))?.reason).toBe(
      'approach',
    );
    expect(detector.update(at(4, { on_ground: true, agl_ft: 0 }))?.reason).toBe('touchdown');
  });

  it('разбег может быть прерван (aborted takeoff)', () => {
    const detector = new FlightPhaseDetector();
    detector.update(at(0, { gs_kt: 10 }));
    detector.update(at(1, { gs_kt: 60 }));
    expect(detector.phase).toBe('takeoff');
    const transition = detector.update(at(2, { gs_kt: 2, on_ground: true }));
    expect(transition?.to).toBe('taxi');
    expect(transition?.reason).toBe('aborted_takeoff');
  });

  it('уход на повторный круг из landing', () => {
    const detector = new FlightPhaseDetector();
    detector.update(at(0, { gs_kt: 140, on_ground: false, agl_ft: 3000, vs_fpm: -600 }));
    detector.update(at(2, { gs_kt: 130, on_ground: false, agl_ft: 300, vs_fpm: -600 }));
    expect(detector.phase).toBe('landing');
    const transition = detector.update(
      at(5, { gs_kt: 150, on_ground: false, agl_ft: 700, vs_fpm: 900 }),
    );
    expect(transition?.to).toBe('airborne');
    expect(transition?.reason).toBe('go_around');
  });

  it('не «дребезжит» на границе landing при гистерезисе', () => {
    const detector = new FlightPhaseDetector();
    detector.update(at(0, { gs_kt: 140, on_ground: false, agl_ft: 3000, vs_fpm: -600 }));
    detector.update(at(2, { gs_kt: 130, on_ground: false, agl_ft: 300, vs_fpm: -600 }));
    expect(detector.phase).toBe('landing');
    const jitter = detector.update(
      at(3, { gs_kt: 120, on_ground: false, agl_ft: 520, vs_fpm: -400 }),
    );
    expect(jitter).toBeNull();
    expect(detector.phase).toBe('landing');
  });

  it('поддерживает отрыв без разбега (вертолёт)', () => {
    const detector = new FlightPhaseDetector();
    detector.update(at(0, { gs_kt: 10 }));
    const transition = detector.update(
      at(1, { gs_kt: 20, on_ground: false, agl_ft: 60, vs_fpm: 400 }),
    );
    expect(transition?.to).toBe('airborne');
  });

  it('старт на земле: транзиентный on_ground=false не даёт ложный airborne', () => {
    const detector = new FlightPhaseDetector();
    // Первые кадры: SIM ON GROUND ещё не заполнен, AGL/vs нулевые.
    expect(detector.update(at(0, { on_ground: false, agl_ft: 0, vs_fpm: 0, gs_kt: 0 }))).toBeNull();
    expect(detector.update(at(1, { on_ground: true, agl_ft: 0, vs_fpm: 0, gs_kt: 3 }))?.to).toBe(
      'taxi',
    );
    expect(detector.update(at(2, { on_ground: false, agl_ft: 0, vs_fpm: 0, gs_kt: 8 }))).toBeNull();
    expect(detector.phase).toBe('taxi');
  });

  it('bogus on_ground=false с большим AGL при gs=0 не даёт airborne (реальный DA62)', () => {
    // Первые кадры SimConnect: `on_ground=false`, `agl=204 ft`, `alt=221 ft`,
    // `gs=0`, `vs=0` — ВС на полосе. Высота без движения не подтверждает отрыв.
    const detector = new FlightPhaseDetector();
    expect(
      detector.update(at(0, { on_ground: false, agl_ft: 204, alt_ft: 221, gs_kt: 0, vs_fpm: 0 })),
    ).toBeNull();
    expect(
      detector.update(at(4, { on_ground: true, agl_ft: 3, alt_ft: 80, gs_kt: 0, vs_fpm: 0 })),
    ).toBeNull();
    expect(detector.phase).toBe('on_ground');
  });

  it('старт в воздухе (AGL выше порога) сразу даёт airborne', () => {
    const detector = new FlightPhaseDetector();
    expect(
      detector.update(at(0, { on_ground: false, agl_ft: 2000, vs_fpm: 0, gs_kt: 150 }))?.to,
    ).toBe('airborne');
  });

  it('кадры slew не меняют фазу', () => {
    const detector = new FlightPhaseDetector();
    detector.update(at(0, { gs_kt: 10 }));
    expect(detector.phase).toBe('taxi');

    const slew = detector.update(
      at(1, { slew: true, on_ground: false, agl_ft: 5000, vs_fpm: 2000, gs_kt: 220 }),
    );
    expect(slew).toBeNull();
    expect(detector.phase).toBe('taxi');
  });

  it('телепорт (скачок позиции при slew=false) не меняет фазу', () => {
    const detector = new FlightPhaseDetector();
    detector.update(at(0, { gs_kt: 10, lat: 55.972, lon: 37.414 }));
    expect(detector.phase).toBe('taxi');

    const teleport = detector.update(
      at(1, { on_ground: false, agl_ft: 5000, vs_fpm: 2000, gs_kt: 220, lat: 40, lon: -74 }),
    );
    expect(teleport).toBeNull();
    expect(detector.phase).toBe('taxi');
  });

  it('reset возвращает начальное состояние', () => {
    const detector = new FlightPhaseDetector();
    detector.update(at(0, { gs_kt: 10 }));
    detector.reset();
    expect(detector.phase).toBe('on_ground');
  });
});

describe('FlightPhaseDetector — телепорт-инвалидация (BUG-1)', () => {
  it('короткий slew в воздух не даёт фазу airborne', () => {
    const detector = new FlightPhaseDetector();
    detector.update(at(0, { on_ground: true, gs_kt: 0 }));
    detector.update(
      at(1, { slew: true, on_ground: false, agl_ft: 3000, vs_fpm: 1500, gs_kt: 200 }),
    );
    const transition = detector.update(
      at(2, { on_ground: false, agl_ft: 4000, vs_fpm: 0, gs_kt: 220 }),
    );
    expect(transition).toBeNull();
    expect(detector.phase).toBe('on_ground');
  });

  it('длинный slew (> maxGapS) в воздух не даёт airborne', () => {
    const detector = new FlightPhaseDetector();
    detector.update(at(0, { on_ground: true, gs_kt: 60 }));
    expect(detector.phase).toBe('takeoff');
    detector.update(
      at(1, { slew: true, on_ground: false, agl_ft: 3000, vs_fpm: 1500, gs_kt: 200 }),
    );
    detector.update(
      at(6, { slew: true, on_ground: false, agl_ft: 3500, vs_fpm: 1000, gs_kt: 220 }),
    );
    // Slew off с устаревшей базой: скачок не классифицируется, но флаг держит фазу.
    const transition = detector.update(
      at(7, { on_ground: false, agl_ft: 4000, vs_fpm: 0, gs_kt: 220 }),
    );
    expect(transition).toBeNull();
    expect(detector.phase).toBe('takeoff');
  });

  it('сессия начинается в slew → airborne не подтверждается', () => {
    const detector = new FlightPhaseDetector();
    detector.update(
      at(0, { slew: true, on_ground: false, agl_ft: 5000, vs_fpm: 2000, gs_kt: 220 }),
    );
    const transition = detector.update(
      at(1, { on_ground: false, agl_ft: 6000, vs_fpm: 0, gs_kt: 220 }),
    );
    expect(transition).toBeNull();
    expect(detector.phase).toBe('on_ground');
  });

  it('slew на земле → наземный кадр снимает инвалидацию → реальный взлёт', () => {
    const detector = new FlightPhaseDetector();
    detector.update(at(0, { on_ground: true, gs_kt: 0 }));
    detector.update(at(1, { slew: true, on_ground: true, gs_kt: 0 }));
    expect(detector.update(at(2, { on_ground: true, gs_kt: 5 }))?.to).toBe('taxi');
    expect(detector.update(at(4, { on_ground: true, gs_kt: 60 }))?.to).toBe('takeoff');
    const liftoff = detector.update(
      at(6, { on_ground: false, agl_ft: 50, vs_fpm: 800, gs_kt: 120 }),
    );
    expect(liftoff?.to).toBe('airborne');
    expect(liftoff?.reason).toBe('liftoff');
  });
});
