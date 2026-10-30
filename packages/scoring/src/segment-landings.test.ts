import { QUALITY_BITS } from '@flightlog/contracts';
import { describe, expect, it } from 'vitest';

import {
  SEGMENTATION_VERSION,
  segmentLandings,
  type LandingEvent,
  type LandingPoint,
} from './index';

const BASE = Date.parse('2026-09-26T10:00:00.000Z');

function at(offsetS: number): string {
  return new Date(BASE + Math.round(offsetS * 1000)).toISOString();
}

function point(
  offsetS: number,
  onGround: boolean,
  overrides: Partial<LandingPoint> = {},
): LandingPoint {
  return {
    ts: at(offsetS),
    on_ground: onGround,
    vertical_speed_fpm: onGround ? -150 : -400,
    g_force: onGround ? 1.2 : 1.1,
    pitch_deg: onGround ? 2 : 3,
    bank_deg: 0,
    quality: 0,
    latitude: 55.972,
    longitude: 37.414,
    groundspeed_kt: onGround ? 120 : 140,
    altitude_ft: onGround ? 10 : 850,
    ...overrides,
  };
}

describe('segmentLandings (ADR-0010 §3)', () => {
  it('экспортирует semver правил сегментации', () => {
    expect(SEGMENTATION_VERSION).toBe('1.5.0');
    expect(SEGMENTATION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('одна посадка без отскоков — touch-and-go', () => {
    const result = segmentLandings([], [point(-1, false), point(0, true), point(10, false)]);
    expect(result).toHaveLength(1);
    const landing = result[0];
    expect(landing).toMatchObject({
      seq: 1,
      bounceCount: 0,
      bounced: false,
      groundContactS: 10,
      stoppedOnGround: false,
      touchAndGo: true,
      verified: true,
      flags: 0,
    });
    expect(landing?.metrics.vs_fpm).toBe(-150);
  });

  it('P2: vs_fpm=0 на кадре касания — неизмеренное значение (null), не идеальные 0 fpm', () => {
    const result = segmentLandings(
      [{ type: 'touchdown', ts: at(0), data: { vs_fpm: 0, g: 1.2 } }],
      [
        point(-1, false, { vertical_speed_fpm: -400, altitude_ft: 850 }),
        point(0, true, { vertical_speed_fpm: 0, altitude_ft: 10 }),
        point(1, true, { vertical_speed_fpm: 0, altitude_ft: 10 }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.metrics.vs_fpm).toBeNull();
    expect(result[0]?.verified).toBe(false);
  });

  it('vs=0, g=1.00 без события касания → посадка сохраняется (не отбрасывается), vs_fpm=null', () => {
    const result = segmentLandings(
      [],
      [
        point(-1, false, { vertical_speed_fpm: -400, altitude_ft: 850, g_force: 1.0 }),
        point(0, true, { vertical_speed_fpm: 0, g_force: 1.0, altitude_ft: 10 }),
        point(1, true, { vertical_speed_fpm: 0, g_force: 1.0, altitude_ft: 10 }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.metrics.vs_fpm).toBeNull();
    expect(result[0]?.metrics.g_force).toBe(1.0);
    expect(result[0]?.verified).toBe(false);
  });

  it('vs_fpm посадки — сырой кадр перехода air→ground (без интерполяции/усреднения)', () => {
    // Инцидент 2026-10-15: если точка перехода отсутствовала в треке, сервер брал
    // следующую наземную точку (после derotation) → VS мягче фактического.
    // Здесь точка перехода присутствует и обязана дать своё мгновенное значение.
    const result = segmentLandings(
      [],
      [
        point(-1, false, { vertical_speed_fpm: -450 }),
        point(0, true, { vertical_speed_fpm: -137 }),
        point(0.1, true, { vertical_speed_fpm: -120 }),
        point(2, true, { vertical_speed_fpm: -90 }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.metrics.vs_fpm).toBe(-137);
  });

  it('граница 5 c: низкий подскок ровно через 5 c — отскок той же посадки, не T&G', () => {
    const result = segmentLandings(
      [],
      [
        point(-1, false, { altitude_ft: 850 }),
        point(0, true, { altitude_ft: 10 }),
        point(2, false, { altitude_ft: 15 }),
        point(2.05, false, { altitude_ft: 15 }),
        point(2.1, false, { altitude_ft: 15 }),
        point(5, true, { altitude_ft: 10 }),
        point(6, false, { altitude_ft: 15 }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      seq: 1,
      bounceCount: 1,
      bounced: true,
      touchAndGo: false,
      groundContactS: null,
    });
  });

  it('D1 LIRN: дрожание on_ground +0.1 ft (≥3 сэмпла) — одна посадка, bounce=0', () => {
    const result = segmentLandings(
      [],
      [
        point(-1, false, { altitude_ft: 80 }),
        // Касание, затем «воздух» +0.1 ft на 0.45 c (20 Гц) и снова касание.
        point(0, true, { altitude_ft: 10, vertical_speed_fpm: -180 }),
        ...Array.from({ length: 9 }, (_, i) =>
          point(0.05 * (i + 1), false, { altitude_ft: 10.1, vertical_speed_fpm: 20 }),
        ),
        point(1.28, true, { altitude_ft: 10, vertical_speed_fpm: -160 }),
        point(1.33, true, { altitude_ft: 10, vertical_speed_fpm: -150 }),
        point(2, true, { altitude_ft: 10, vertical_speed_fpm: -100 }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ seq: 1, bounceCount: 0, bounced: false });
  });

  it('D1 LIRN: дрожание on_ground +0.8 ft — одна посадка, bounce=0', () => {
    const result = segmentLandings(
      [],
      [
        point(-1, false, { altitude_ft: 90 }),
        point(0, true, { altitude_ft: 12, vertical_speed_fpm: -190 }),
        ...Array.from({ length: 12 }, (_, i) =>
          point(0.05 * (i + 1) + 0.7, false, { altitude_ft: 12.8, vertical_speed_fpm: 10 }),
        ),
        point(1.76, true, { altitude_ft: 12, vertical_speed_fpm: -170 }),
        point(1.81, true, { altitude_ft: 12, vertical_speed_fpm: -160 }),
        point(2.5, true, { altitude_ft: 12, vertical_speed_fpm: -120 }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ seq: 1, bounceCount: 0, bounced: false });
  });

  it('D1: достоверный подскок +3 ft / 0.6 c — bounce=1', () => {
    const result = segmentLandings(
      [],
      [
        point(-1, false, { altitude_ft: 80 }),
        point(0, true, { altitude_ft: 10, vertical_speed_fpm: -180 }),
        ...Array.from({ length: 12 }, (_, i) =>
          point(0.05 * (i + 1), false, { altitude_ft: 13, vertical_speed_fpm: 100 }),
        ),
        point(0.65, true, { altitude_ft: 10, vertical_speed_fpm: -170 }),
        point(0.7, true, { altitude_ft: 10, vertical_speed_fpm: -160 }),
        point(1, true, { altitude_ft: 10, vertical_speed_fpm: -140 }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ seq: 1, bounceCount: 1, bounced: true });
  });

  it('D1: 1–2 сэмпла воздуха не открывают отскок (flicker)', () => {
    const oneSample = segmentLandings(
      [],
      [
        point(-1, false, { altitude_ft: 300 }),
        point(0, true, { altitude_ft: 10 }),
        point(0.5, false, { altitude_ft: 40 }),
        point(1, true, { altitude_ft: 10 }),
      ],
    );
    expect(oneSample[0]).toMatchObject({ bounceCount: 0, bounced: false });

    const twoSamples = segmentLandings(
      [],
      [
        point(-1, false, { altitude_ft: 300 }),
        point(0, true, { altitude_ft: 10 }),
        point(0.5, false, { altitude_ft: 40 }),
        point(0.55, false, { altitude_ft: 40 }),
        point(1, true, { altitude_ft: 10 }),
      ],
    );
    expect(twoSamples[0]).toMatchObject({ bounceCount: 0, bounced: false });
  });

  it('D1: lagged sim VS (−310) при чистом уклоне высоты −200 за 1.2 c → altitude выбран', () => {
    const result = segmentLandings(
      [],
      [
        point(-10, false, { altitude_ft: 800, vertical_speed_fpm: -300 }),
        point(-1.2, false, { altitude_ft: 600, vertical_speed_fpm: -200 }),
        point(-0.9, false, { altitude_ft: 599, vertical_speed_fpm: -200 }),
        point(-0.6, false, { altitude_ft: 598, vertical_speed_fpm: -200 }),
        point(-0.3, false, { altitude_ft: 597, vertical_speed_fpm: -200 }),
        point(0, true, { altitude_ft: 596, vertical_speed_fpm: -310 }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.metrics.vs_fpm).toBe(-200);
    expect(result[0]?.vsSource).toBe('altitude');
    expect(result[0]?.vsAltitudeFpm).toBe(-200);
  });

  it('D1 EDDS: разреженное окно (дыра 0.72 c, 4 точки) → остаётся sim VS', () => {
    const result = segmentLandings(
      [],
      [
        point(-10, false, { altitude_ft: 1_500, vertical_speed_fpm: -200 }),
        point(-1.42, false, { altitude_ft: 1_288, vertical_speed_fpm: -115 }),
        point(-0.93, false, { altitude_ft: 1_287, vertical_speed_fpm: -113 }),
        point(-0.2, false, { altitude_ft: 1_286.5, vertical_speed_fpm: -117 }),
        point(0, true, { altitude_ft: 1_285, vertical_speed_fpm: -140 }),
      ],
    );
    expect(result[0]?.metrics.vs_fpm).toBe(-140);
    expect(result[0]?.vsSource).toBe('sim');
    expect(result[0]?.vsAltitudeFpm).toBeNull();
  });

  it('D1 LIRN alekss: плотное окно, sim −310 против уклона −319 → остаётся sim', () => {
    const slopePerS = 319 / 60;
    const history = [-1.4, -1.2, -1, -0.8, -0.6, -0.4, -0.2].map((offsetS) =>
      point(offsetS, false, {
        altitude_ft: 500 + slopePerS * -offsetS,
        vertical_speed_fpm: -310,
      }),
    );
    const result = segmentLandings(
      [],
      [
        point(-10, false, { altitude_ft: 700, vertical_speed_fpm: -300 }),
        ...history,
        point(0, true, { altitude_ft: 500, vertical_speed_fpm: -310 }),
      ],
    );
    expect(result[0]?.metrics.vs_fpm).toBe(-310);
    expect(result[0]?.vsSource).toBe('sim');
    expect(result[0]?.vsAltitudeFpm).toBe(-319);
  });

  it('D1: R² < 0.9 (колеблющаяся высота) → остаётся sim VS', () => {
    const alts = [500, 496, 502, 497, 501, 498];
    const history = alts.map((altitudeFt, index) =>
      point(-1.2 + index * 0.2, false, {
        altitude_ft: altitudeFt,
        vertical_speed_fpm: -310,
      }),
    );
    const result = segmentLandings(
      [],
      [
        point(-10, false, { altitude_ft: 700, vertical_speed_fpm: -300 }),
        ...history,
        point(0, true, { altitude_ft: 500, vertical_speed_fpm: -310 }),
      ],
    );
    expect(result[0]?.metrics.vs_fpm).toBe(-310);
    expect(result[0]?.vsSource).toBe('sim');
    expect(result[0]?.vsAltitudeFpm).toBeNull();
  });

  it('D1: меньше 5 точек окна → остаётся sim VS (чистый уклон не спасает)', () => {
    const result = segmentLandings(
      [],
      [
        point(-10, false, { altitude_ft: 800, vertical_speed_fpm: -300 }),
        point(-0.9, false, { altitude_ft: 600, vertical_speed_fpm: -200 }),
        point(-0.6, false, { altitude_ft: 599, vertical_speed_fpm: -200 }),
        point(-0.3, false, { altitude_ft: 598, vertical_speed_fpm: -200 }),
        point(0, true, { altitude_ft: 597, vertical_speed_fpm: -310 }),
      ],
    );
    expect(result[0]?.metrics.vs_fpm).toBe(-310);
    expect(result[0]?.vsSource).toBe('sim');
    expect(result[0]?.vsAltitudeFpm).toBeNull();
  });

  it('D1: нет окна высоты → остаётся sim VS (vs_source=sim)', () => {
    const result = segmentLandings(
      [],
      [
        point(-1, false, { altitude_ft: 300, vertical_speed_fpm: -400 }),
        point(0, true, { altitude_ft: 100, vertical_speed_fpm: -310 }),
        point(0.2, true, { altitude_ft: 100, vertical_speed_fpm: -300 }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.metrics.vs_fpm).toBe(-310);
    expect(result[0]?.vsSource).toBe('sim');
    expect(result[0]?.vsAltitudeFpm).toBeNull();
  });

  it('D1: неправдоподобный скачок высоты не подменяет sim VS', () => {
    const result = segmentLandings(
      [],
      [
        point(-1, false, { altitude_ft: 2_000, vertical_speed_fpm: -150 }),
        point(-0.4, false, { altitude_ft: 2_000, vertical_speed_fpm: -150 }),
        point(0, true, { altitude_ft: 325, vertical_speed_fpm: -169 }),
      ],
    );
    expect(result[0]?.metrics.vs_fpm).toBe(-169);
    expect(result[0]?.vsSource).toBe('sim');
    expect(result[0]?.vsAltitudeFpm).toBeNull();
  });

  it('граница 5 c: достоверный отрыв → отдельная посадка', () => {
    const result = segmentLandings(
      [],
      [
        point(-1, false, { altitude_ft: 850 }),
        point(0, true, { altitude_ft: 10 }),
        point(1, false, { altitude_ft: 850 }),
        point(5.001, true, { altitude_ft: 10 }),
        point(6, false, { altitude_ft: 850 }),
      ],
    );
    expect(result).toHaveLength(2);
    expect(result.map((l) => l.seq)).toEqual([1, 2]);
    expect(result[0]).toMatchObject({ bounceCount: 0, touchAndGo: true });
    expect(result[1]).toMatchObject({ bounceCount: 0, touchAndGo: true });
    expect(result[1]?.touchdownTs).toBe(at(5.001));
  });

  it('touch-and-go vs full-stop: остановка дольше stopDwellS снимает touch-and-go', () => {
    const result = segmentLandings(
      [],
      [
        point(-1, false),
        point(0, true, { groundspeed_kt: 120 }),
        point(1, true, { groundspeed_kt: 0 }),
        point(3, true, { groundspeed_kt: 0 }),
        point(7, true, { groundspeed_kt: 0 }),
        point(20, false),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      stoppedOnGround: true,
      touchAndGo: false,
      groundContactS: 20,
    });
  });

  it('последняя посадка без отрыва: touch_and_go=false, groundContactS=null', () => {
    const result = segmentLandings([], [point(-1, false), point(0, true), point(10, true)]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      seq: 1,
      groundContactS: null,
      stoppedOnGround: false,
      touchAndGo: false,
      verified: true,
    });
  });

  it('событие ниже пика g (выравнивание/derotation) — не SLEW (T97 golden A350)', () => {
    // Фрагмент рейса A359 ZSPD→RJTT: событие агента снято на сэмпле касания —
    // до пика обжатия (g=1.01), серверный пик в ±2 c — 1.322; `vs`/`pitch`/`bank`
    // совпадают. Раньше разница 0.31 при пороге 0.3 давала ложный SLEW.
    const points: LandingPoint[] = [
      point(-1, false),
      point(0, true, {
        altitude_ft: 10,
        vertical_speed_fpm: -395,
        g_force: 1.245,
        pitch_deg: -4.391,
        bank_deg: -0.224,
      }),
      point(0.2, true, {
        altitude_ft: 9,
        vertical_speed_fpm: -367,
        g_force: 1.322,
        pitch_deg: -4.043,
        bank_deg: -0.445,
      }),
      point(0.4, true, {
        altitude_ft: 8,
        vertical_speed_fpm: -339,
        g_force: 1.304,
        pitch_deg: -3.769,
        bank_deg: -0.54,
      }),
    ];
    const events: LandingEvent[] = [
      {
        type: 'touchdown',
        ts: at(0),
        data: { vs_fpm: -402, g: 1.01, pitch_deg: -4.498, bank_deg: -0.184 },
      },
    ];
    const result = segmentLandings(events, points);
    expect(result).toHaveLength(1);
    expect(result[0]?.flags).toBe(0);
    expect(result[0]?.verified).toBe(true);
    expect(result[0]?.metrics.g_force).toBe(1.322);
    expect(result[0]?.metrics.vs_fpm).toBe(-395);
  });

  it('backfill: хронология по ts, а не по seq', () => {
    // При сортировке по seq получился бы ложный переход air→ground: seq 6 (air) раньше seq 11 (ground).
    const result = segmentLandings(
      [],
      [
        { ...point(0, true), seq: 5 },
        { ...point(2, true), seq: 11 },
        { ...point(3, false), seq: 6 },
      ],
    );
    expect(result).toHaveLength(0);
  });

  it('глубокий откат ts относительно seq помечает посадку CLOCK_INVALID (вне лидерборда)', () => {
    // Позже записанная точка (seq=2) имеет более раннее время на 60 с — сбой
    // часов/подмена телеметрии: value-бит сохраняется в флагах посадки.
    const result = segmentLandings(
      [],
      [
        point(-1, false, { seq: 1 }),
        point(-61, false, { seq: 2 }),
        point(0, true, { seq: 3 }),
        point(10, false, { seq: 4 }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.verified).toBe(true);
    expect((result[0]?.flags ?? 0) & QUALITY_BITS.CLOCK_INVALID).toBe(QUALITY_BITS.CLOCK_INVALID);
  });

  it('backfill окна касания (поздний seq, ранний ts) не даёт ложного CLOCK_INVALID (R6.1)', () => {
    // Штатный backfill: после касания (seq=1) материализуются точки окна за
    // последние 30 с с seq=2..n. Хронология восстанавливается по ts, `seq↔ts`
    // не инвариант (api.md §3.3) — рейс должен остаться допущенным.
    const points = [point(0, true, { seq: 1 })];
    for (let i = 0; i < 28; i += 1) {
      points.push(point(-29 + i, false, { seq: i + 2 }));
    }
    points.push(point(1, false, { seq: 30 }));
    const result = segmentLandings([], points);
    expect(result).toHaveLength(1);
    expect(result[0]?.flags).toBe(0);
  });

  it('монохронный seq/ts не даёт ложного CLOCK_INVALID', () => {
    const result = segmentLandings(
      [],
      [
        point(-1, false, { seq: 1 }),
        point(0, true, { seq: 2 }),
        point(10, false, { seq: 3 }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.flags).toBe(0);
  });

  it('без перехода air→ground, но с событием touchdown — неподтверждённая посадка (SLEW)', () => {
    const events: LandingEvent[] = [
      { type: 'touchdown', ts: at(0), data: { vs_fpm: -200, g: 1.1 } },
    ];
    const result = segmentLandings(events, [point(-3, false), point(-2, false)]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      seq: 1,
      verified: false,
      touchAndGo: false,
      groundContactS: null,
    });
    expect(result[0]?.metrics.vs_fpm).toBe(-200);
    expect((result[0]?.flags ?? 0) & QUALITY_BITS.SLEW).toBe(QUALITY_BITS.SLEW);
  });

  it('runway_icao из события: только ^[A-Z0-9]{1,8}$, иначе отбрасывается', () => {
    const points = [point(-1, false), point(0, true), point(10, false)];
    const malicious = segmentLandings(
      [
        {
          type: 'touchdown',
          ts: at(0),
          data: { vs_fpm: -150, g: 1.1, runway_icao: '=HYPERLINK("http://evil","x")' },
        },
      ],
      points,
    );
    expect(malicious[0]?.metrics.runway_icao).toBeUndefined();

    const valid = segmentLandings(
      [{ type: 'touchdown', ts: at(0), data: { vs_fpm: -150, g: 1.1, runway: ' 24l ' } }],
      points,
    );
    expect(valid[0]?.metrics.runway_icao).toBe('24L');
  });

  it('без трека и без события touchdown — нет посадок (no_score)', () => {
    expect(segmentLandings([], [])).toEqual([]);
    expect(segmentLandings([], [point(-1, false), point(0, false)])).toEqual([]);
  });

  it('отскоки: bounce-события не удваиваются с трековым bounce', () => {
    const withTrackBounce = segmentLandings(
      [{ type: 'bounce', ts: at(3), data: {} }],
      [
        point(-1, false, { altitude_ft: 850 }),
        point(0, true, { altitude_ft: 10 }),
        point(2, false, { altitude_ft: 15 }),
        point(3, true, { altitude_ft: 10 }),
        point(6, false, { altitude_ft: 15 }),
      ],
    );
    expect(withTrackBounce).toHaveLength(1);
    expect(withTrackBounce[0]?.bounceCount).toBe(1);

    const eventsOnly = segmentLandings(
      [
        { type: 'bounce', ts: at(2), data: {} },
        { type: 'bounce', ts: at(4), data: {} },
        { type: 'touchdown', ts: at(0), data: {} },
      ],
      [point(-1, false), point(0, true), point(10, false)],
    );
    expect(eventsOnly).toHaveLength(1);
    expect(eventsOnly[0]?.bounceCount).toBe(2);
  });

  it('1 м подскок (LYBE): одна посадка, bounce_count=1, не touch-and-go', () => {
    // Реальный трек: касание → отскок через 1 с → низкий «подлёт» до ≈11 ft AGL
    // на ~11 с → повторное касание через ~22 с. Достоверного набора высоты нет.
    const result = segmentLandings(
      [{ type: 'bounce', ts: at(1), data: {} }],
      [
        point(-2, false, { altitude_ft: 500, groundspeed_kt: 125 }),
        point(0, true, { altitude_ft: 345, groundspeed_kt: 125 }),
        point(0.8, false, { altitude_ft: 345.5, groundspeed_kt: 124 }),
        point(1, true, { altitude_ft: 345, groundspeed_kt: 124 }),
        point(11, false, { altitude_ft: 346.5, groundspeed_kt: 140 }),
        point(15, false, { altitude_ft: 356, groundspeed_kt: 140 }),
        point(20, false, { altitude_ft: 350, groundspeed_kt: 135 }),
        point(22, true, { altitude_ft: 345, groundspeed_kt: 130 }),
        point(30, true, { altitude_ft: 345, groundspeed_kt: 20 }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      seq: 1,
      bounceCount: 1,
      bounced: true,
      touchAndGo: false,
      groundContactS: null,
    });
  });

  it('реальный touch-and-go (набор >30 ft) → две отдельные посадки', () => {
    const result = segmentLandings(
      [],
      [
        point(-1, false, { altitude_ft: 500, groundspeed_kt: 130 }),
        point(0, true, { altitude_ft: 10, groundspeed_kt: 120 }),
        point(2, false, { altitude_ft: 150, groundspeed_kt: 125 }),
        point(12, false, { altitude_ft: 800, groundspeed_kt: 140 }),
        point(30, true, { altitude_ft: 10, groundspeed_kt: 115 }),
        point(40, false, { altitude_ft: 900, groundspeed_kt: 145 }),
      ],
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ seq: 1, bounceCount: 0, touchAndGo: true });
    expect(result[1]).toMatchObject({ seq: 2, bounceCount: 0, touchAndGo: true });
    expect(result[1]?.touchdownTs).toBe(at(30));
  });

  it('детерминирован и не зависит от порядка входа', () => {
    const points = [
      point(0, true),
      point(-1, false),
      point(2, false),
      point(5, true),
      point(6, false),
    ];
    const shuffled = [points[2], points[0], points[4], points[1], points[3]] as LandingPoint[];
    expect(segmentLandings([], points)).toEqual(segmentLandings([], shuffled));
    expect(segmentLandings([], points)).toEqual(segmentLandings([], points));
  });

  it('точки с value-битами исключаются из сегментации', () => {
    const result = segmentLandings(
      [],
      [point(-1, false), point(0, true, { quality: QUALITY_BITS.SLEW }), point(10, false)],
    );
    expect(result).toHaveLength(0);
  });

  it('старт на земле: транзиентный air→ground без отрыва не даёт посадку', () => {
    // ВС стоит на полосе (высота поля не меняется), но первый кадр ложно
    // `on_ground=false`: реального отрыва не было → посадок 0.
    const groundAlt = 612;
    const result = segmentLandings(
      [],
      [
        point(0, false, { altitude_ft: groundAlt, vertical_speed_fpm: 0, groundspeed_kt: 0 }),
        point(1, false, { altitude_ft: groundAlt, vertical_speed_fpm: 0, groundspeed_kt: 5 }),
        point(2, true, { altitude_ft: groundAlt, vertical_speed_fpm: 0, groundspeed_kt: 8 }),
        point(3, true, { altitude_ft: groundAlt, vertical_speed_fpm: 0, groundspeed_kt: 0 }),
      ],
    );
    expect(result).toEqual([]);
  });

  it('старт на земле: событие ложного touchdown не создаёт посадку без отрыва', () => {
    const groundAlt = 612;
    const events: LandingEvent[] = [
      { type: 'touchdown', ts: at(2), data: { vs_fpm: 0, g: 0.98 } },
    ];
    const result = segmentLandings(events, [
      point(0, false, { altitude_ft: groundAlt, vertical_speed_fpm: 0, groundspeed_kt: 0 }),
      point(2, true, { altitude_ft: groundAlt, vertical_speed_fpm: 0, groundspeed_kt: 8 }),
    ]);
    expect(result).toEqual([]);
  });

  it('разбег с полётной скоростью, но без набора высоты — не посадка (F: ложная #1)', () => {
    // F (client 0.3.x): ВС загружено на ВПП с работающими двигателями, разбег даёт
    // `on_ground=false`, `gs ≥ 40`, `agl ≈ 0`. Раньше flying-gs подтверждал отрыв
    // и следующее `on_ground=true` давало ложную посадку (~98). Теперь требуется
    // достоверный набор высоты (`credibleLiftoffFt`).
    const groundAlt = 612;
    const result = segmentLandings(
      [],
      [
        point(-2, false, { altitude_ft: groundAlt + 2, vertical_speed_fpm: 0, groundspeed_kt: 60 }),
        point(-1, false, { altitude_ft: groundAlt + 5, vertical_speed_fpm: 0, groundspeed_kt: 80 }),
        point(0, true, { altitude_ft: groundAlt, vertical_speed_fpm: 0, groundspeed_kt: 70 }),
        point(10, true, { altitude_ft: groundAlt, vertical_speed_fpm: 0, groundspeed_kt: 10 }),
      ],
    );
    expect(result).toEqual([]);
  });

  it('короткий подскок (15 ft AGL) — не посадка', () => {
    const groundAlt = 612;
    const result = segmentLandings(
      [],
      [
        point(0, true, { altitude_ft: groundAlt, vertical_speed_fpm: 0, groundspeed_kt: 60 }),
        point(2, false, {
          altitude_ft: groundAlt + 15,
          vertical_speed_fpm: 500,
          groundspeed_kt: 70,
        }),
        point(5, true, { altitude_ft: groundAlt, vertical_speed_fpm: -150, groundspeed_kt: 60 }),
        point(10, true, { altitude_ft: groundAlt, vertical_speed_fpm: 0, groundspeed_kt: 0 }),
      ],
    );
    expect(result).toEqual([]);
  });

  it('трек без высоты, но с полётной скоростью — посадка считается (AGL-unavailable fallback)', () => {
    // Обратная совместимость: когда `altitude_ft` нет вовсе, AGL неоценим —
    // действует прежнее доказательство отрыва (`hasFlightEvidence`).
    const result = segmentLandings(
      [],
      [
        point(-1, false, { altitude_ft: null, vertical_speed_fpm: -300, groundspeed_kt: 140 }),
        point(0, true, { altitude_ft: null, vertical_speed_fpm: -150, groundspeed_kt: 110 }),
        point(10, true, { altitude_ft: null, vertical_speed_fpm: 0, groundspeed_kt: 0 }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ seq: 1, verified: true });
  });

  it('после реального отрыва посадка считается (AGL-набор высоты)', () => {
    const result = segmentLandings(
      [],
      [
        point(0, true, { altitude_ft: 600, groundspeed_kt: 0 }),
        point(2, false, { altitude_ft: 640, vertical_speed_fpm: 700, groundspeed_kt: 80 }),
        point(10, false, { altitude_ft: 2000, vertical_speed_fpm: 0, groundspeed_kt: 150 }),
        point(20, true, { altitude_ft: 600, vertical_speed_fpm: -150, groundspeed_kt: 110 }),
        point(30, true, { altitude_ft: 600, vertical_speed_fpm: 0, groundspeed_kt: 0 }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ seq: 1, verified: true });
  });

  it('4 цикла взлёт-посадка → 4 посадки', () => {
    const points: LandingPoint[] = [point(0, true, { altitude_ft: 600, groundspeed_kt: 0 })];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const base = cycle * 20;
      points.push(
        point(base + 2, false, { altitude_ft: 700, vertical_speed_fpm: 800, groundspeed_kt: 90 }),
        point(base + 10, false, { altitude_ft: 1600, vertical_speed_fpm: 0, groundspeed_kt: 140 }),
        point(base + 18, true, { altitude_ft: 600, vertical_speed_fpm: -150, groundspeed_kt: 110 }),
        point(base + 19, true, { altitude_ft: 600, vertical_speed_fpm: 0, groundspeed_kt: 40 }),
      );
    }
    const result = segmentLandings([], points);
    expect(result).toHaveLength(4);
    expect(result.map((landing) => landing.seq)).toEqual([1, 2, 3, 4]);
    expect(result.every((landing) => landing.verified)).toBe(true);
  });

  it('bogus-airborne на полосе (реальный DA62): ложная #1 не создаётся, 4 T&G остаются', () => {
    // Фрагмент реального рейса fc655a46 (DA62): первые ~4 c SimConnect отдаёт
    // `on_ground=false`, `alt≈221 ft`, `gs=0`, `vs=0`, координаты 0/90 — bogus.
    // Затем ВС на ВПП (alt≈80 ft, `on_ground=true`, gs=0). Раньше «подъём высоты»
    // на 140 ft при gs=0 подтверждал отрыв → ложная посадка #1 и SLEW (телепорт).
    const groundAlt = 80.2;
    const realLat = 43.45189;
    const realLon = 39.9592;
    const points: LandingPoint[] = [
      point(0, false, {
        altitude_ft: 220.8,
        groundspeed_kt: 0,
        vertical_speed_fpm: 0,
        latitude: 0,
        longitude: 90.00032,
      }),
      point(1, false, {
        altitude_ft: 220.8,
        groundspeed_kt: 0,
        vertical_speed_fpm: 0,
        latitude: 0,
        longitude: 90.00032,
      }),
      point(3, false, {
        altitude_ft: 220.8,
        groundspeed_kt: 0,
        vertical_speed_fpm: 0,
        latitude: 0,
        longitude: 90.00032,
      }),
      point(4, true, {
        altitude_ft: groundAlt,
        groundspeed_kt: 0,
        vertical_speed_fpm: 0,
        latitude: realLat,
        longitude: realLon,
      }),
    ];
    const events: LandingEvent[] = [
      // Ложное событие агента на стартовом артефакте (vs_fpm=0, score 98).
      { type: 'touchdown', ts: at(4), data: { vs_fpm: 0, g: 0.98 } },
    ];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const base = 60 + cycle * 120;
      const touchdownS = base + 100;
      points.push(
        point(base, true, {
          altitude_ft: groundAlt,
          groundspeed_kt: 20,
          vertical_speed_fpm: 0,
          latitude: realLat,
          longitude: realLon,
        }),
        point(base + 10, false, {
          altitude_ft: 500,
          groundspeed_kt: 90,
          vertical_speed_fpm: 700,
          latitude: realLat,
          longitude: realLon,
        }),
        point(base + 60, false, {
          altitude_ft: 1200,
          groundspeed_kt: 120,
          vertical_speed_fpm: -300,
          latitude: realLat,
          longitude: realLon,
        }),
        point(touchdownS, true, {
          altitude_ft: groundAlt,
          groundspeed_kt: 74,
          vertical_speed_fpm: -150,
          latitude: realLat,
          longitude: realLon,
        }),
      );
      events.push({
        type: 'touchdown',
        ts: at(touchdownS),
        data: { vs_fpm: -150, g: 1.1 },
      });
    }

    const result = segmentLandings(events, points);
    expect(result).toHaveLength(4);
    expect(result.map((landing) => landing.seq)).toEqual([1, 2, 3, 4]);
    expect(result.every((landing) => landing.verified)).toBe(true);
    // Стартовый артефакт (прыжок 0/90 → реальные координаты без движения) — не SLEW.
    expect(result.every((landing) => (landing.flags & QUALITY_BITS.SLEW) === 0)).toBe(true);
  });

  it('событие vs сверяется с оконным минимумом трека (реальный DA62 T&G) — не SLEW', () => {
    // Агент берёт `vs_fpm` события как минимум за 3 c до касания (-176), а
    // мгновенный `vs` точки перехода мягче (-106). Раньше сравнение с переходом
    // давало ложный SLEW на реальных T&G и лишало рейс лидерборда.
    const points: LandingPoint[] = [
      point(-2.5, false, {
        vertical_speed_fpm: -176,
        altitude_ft: 300,
        groundspeed_kt: 120,
        pitch_deg: -1.86,
        bank_deg: -0.44,
      }),
      point(-1, false, { vertical_speed_fpm: -150, altitude_ft: 120, groundspeed_kt: 100 }),
      point(0, true, {
        vertical_speed_fpm: -106,
        g_force: 1.2213,
        pitch_deg: -0.403,
        bank_deg: -0.845,
        altitude_ft: 80.2,
        groundspeed_kt: 74,
      }),
      point(10, false, { vertical_speed_fpm: 300, altitude_ft: 400, groundspeed_kt: 100 }),
    ];
    const events: LandingEvent[] = [
      {
        type: 'touchdown',
        ts: at(0),
        data: { vs_fpm: -176, g: 1.29, pitch_deg: -1.86, bank_deg: -0.44 },
      },
    ];
    const result = segmentLandings(events, points);
    expect(result).toHaveLength(1);
    expect(result[0]?.flags).toBe(0);
    // Метрика скоринга остаётся мгновенным `vs` точки перехода.
    expect(result[0]?.metrics.vs_fpm).toBe(-106);
  });

  it('R5.7: метрика = VS касания, пик снижения — в vs_peak_fpm (не SLEW)', () => {
    const points: LandingPoint[] = [
      point(-2, false, { vertical_speed_fpm: -479, altitude_ft: 300, groundspeed_kt: 130 }),
      point(-1, false, { vertical_speed_fpm: -300, altitude_ft: 120, groundspeed_kt: 110 }),
      point(0, true, {
        vertical_speed_fpm: -210,
        g_force: 1.25,
        altitude_ft: 10,
        groundspeed_kt: 120,
      }),
      point(10, false, { vertical_speed_fpm: 300, altitude_ft: 400, groundspeed_kt: 110 }),
    ];
    const events: LandingEvent[] = [
      {
        type: 'touchdown',
        ts: at(0),
        data: { vs_fpm: -210, vs_peak_fpm: -479, g: 1.25 },
      },
    ];
    const result = segmentLandings(events, points);
    expect(result).toHaveLength(1);
    expect((result[0]?.flags ?? 0) & QUALITY_BITS.SLEW).toBe(0);
    expect(result[0]?.metrics.vs_fpm).toBe(-210);
  });
});
