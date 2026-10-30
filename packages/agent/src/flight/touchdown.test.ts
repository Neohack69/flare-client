import { QUALITY_BITS } from '@flightlog/contracts';
import { segmentLandings, type LandingPoint } from '@flightlog/scoring';
import { describe, expect, it } from 'vitest';

import { LandingTracker, TouchdownTracker } from './touchdown.js';
import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';

function at(offsetS: number, overrides: Parameters<typeof makeSample>[1] = {}) {
  return makeSample(isoAt(BASE_MS, offsetS * 1000), overrides);
}

/**
 * Механические тесты (окно VS, группировка bounce, touch-and-go) используют
 * короткие синтетические фазы и AGL ниже порога. Чтобы изолировать проверяемую
 * механику от нового правила достоверного отрыва, отключаем его требования
 * (`minAirborneS: 0` и/или `credibleLiftoffAglFt: 0`). Само правило покрыто
 * тестами ниже с дефолтными порогами.
 */
const MECHANICS_ONLY = { minAirborneS: 0, credibleLiftoffAglFt: 0 } as const;
const NO_MIN_AIRBORNE = { minAirborneS: 0 } as const;

/** Точка трека для серверной `segmentLandings` (зеркало сэмплов трекера). */
function lp(
  offsetS: number,
  onGround: boolean,
  vsFpm: number,
  altitudeFt: number,
  gsKt: number,
): LandingPoint {
  return {
    ts: isoAt(BASE_MS, offsetS * 1000),
    on_ground: onGround,
    vertical_speed_fpm: vsFpm,
    g_force: 1.25,
    pitch_deg: 0,
    bank_deg: 0,
    quality: 0,
    altitude_ft: altitudeFt,
    groundspeed_kt: gsKt,
    latitude: 55.972,
    longitude: 37.414,
  };
}

describe('TouchdownTracker', () => {
  it('детектит касание по переходу air→ground и берёт VS касания', () => {
    const tracker = new TouchdownTracker({ aircraftIcao: 'B738', ...NO_MIN_AIRBORNE });
    expect(tracker.update(at(0, { on_ground: false, agl_ft: 50, vs_fpm: -400 }))).toEqual([]);
    tracker.update(at(1, { on_ground: false, agl_ft: 20, vs_fpm: -520 }));
    tracker.update(at(2, { on_ground: false, agl_ft: 5, vs_fpm: -700, g: 1.1 }));
    const events = tracker.update(at(3, { on_ground: true, agl_ft: 0, vs_fpm: -180, g: 1.45 }));

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.kind).toBe('touchdown');
    // R5.7: `vs_fpm` = VS касания (точка перехода), а не пик снижения окна.
    expect(event?.metrics.vs_fpm).toBe(-180);
    expect(event?.vsPeakFpm).toBe(-700);
    expect(event?.metrics.g_force).toBe(1.45);
    expect(event?.metrics.aircraft_icao).toBe('B738');
    expect(event?.bounceCount).toBe(0);
    expect(event?.score.score_version).toBe('1.0.0');
    expect(event?.score.score).toBeGreaterThanOrEqual(0);
    // score-preview.md §4: событие несёт точку касания и курс для превью.
    expect(event?.latitude).toBe(55.972);
    expect(event?.longitude).toBe(37.414);
    expect(event?.headingDeg).toBe(0);
  });

  it('headingDeg — круговая средняя курса в окне (без разрыва 359→0)', () => {
    const tracker = new LandingTracker({ ...NO_MIN_AIRBORNE });
    tracker.update(at(0, { on_ground: false, agl_ft: 50, vs_fpm: -300, heading_deg: 359 }));
    tracker.update(at(1, { on_ground: false, agl_ft: 20, vs_fpm: -300, heading_deg: 1 }));
    const events = tracker.update(
      at(2, { on_ground: true, agl_ft: 0, vs_fpm: -150, heading_deg: 0 }),
    );
    expect(events[0]?.headingDeg).toBe(0);
  });

  it('R1: разряженное окно (<3 валидных курсов) → headingDeg null (как /complete)', () => {
    const tracker = new LandingTracker({ ...MECHANICS_ONLY });
    tracker.update(at(0, { on_ground: false, agl_ft: 20, vs_fpm: -300, heading_deg: 280 }));
    const events = tracker.update(
      at(0.5, { on_ground: true, agl_ft: 0, vs_fpm: -150, heading_deg: 281 }),
    );
    expect(events[0]?.headingDeg).toBeNull();
  });

  it('R1: плотное окно (≥3 валидных курсов) → курс отправляется', () => {
    const tracker = new LandingTracker({ ...MECHANICS_ONLY });
    tracker.update(at(0, { on_ground: false, agl_ft: 20, vs_fpm: -300, heading_deg: 280 }));
    tracker.update(at(1, { on_ground: false, agl_ft: 10, vs_fpm: -300, heading_deg: 281 }));
    const events = tracker.update(
      at(2, { on_ground: true, agl_ft: 0, vs_fpm: -150, heading_deg: 279 }),
    );
    expect(events[0]?.headingDeg).toBe(280);
  });

  it('R1: sentinel-координаты (0,0) не считаются валидным курсом', () => {
    const tracker = new LandingTracker({ ...MECHANICS_ONLY });
    tracker.update(at(0, { on_ground: false, agl_ft: 20, vs_fpm: -300, lat: 0, lon: 0 }));
    tracker.update(at(1, { on_ground: false, agl_ft: 10, vs_fpm: -300, lat: 0, lon: 0 }));
    const events = tracker.update(at(2, { on_ground: true, agl_ft: 0, vs_fpm: -150, lat: 0, lon: 0 }));
    expect(events[0]?.headingDeg).toBeNull();
  });

  it('считает отскок при достоверном подскоке (20 Гц, AGL +5 ft)', () => {
    const tracker = new TouchdownTracker({ ...MECHANICS_ONLY });
    tracker.update(at(0, { on_ground: false, vs_fpm: -300, agl_ft: 20 }));
    const first = tracker.update(at(1, { on_ground: true, vs_fpm: -150, agl_ft: 0, g: 1.2 }));
    expect(first[0]?.kind).toBe('touchdown');

    tracker.update(at(1.5, { on_ground: false, vs_fpm: 200, agl_ft: 5 }));
    tracker.update(at(1.55, { on_ground: false, vs_fpm: 200, agl_ft: 5 }));
    tracker.update(at(1.6, { on_ground: false, vs_fpm: 200, agl_ft: 5 }));
    const second = tracker.update(at(2.5, { on_ground: true, vs_fpm: -120, agl_ft: 0, g: 1.15 }));
    expect(second[0]?.kind).toBe('bounce');
    expect(second[0]?.bounceCount).toBe(1);
  });

  it('не считает отскоком длительный повторный полёт', () => {
    const tracker = new TouchdownTracker({ ...MECHANICS_ONLY });
    tracker.update(at(0, { on_ground: false, vs_fpm: -300, agl_ft: 20 }));
    tracker.update(at(1, { on_ground: true, vs_fpm: -150, agl_ft: 0 }));
    tracker.update(at(2, { on_ground: false, vs_fpm: 200, agl_ft: 500 }));
    const events = tracker.update(at(30, { on_ground: true, vs_fpm: -160, agl_ft: 0 }));
    expect(events[0]?.kind).toBe('touchdown');
    expect(events[0]?.bounceCount).toBe(0);
  });

  it('не пропускает точку перехода, если её не было в окне', () => {
    const tracker = new TouchdownTracker({ preContactWindowS: 1, ...NO_MIN_AIRBORNE });
    tracker.update(at(0, { on_ground: false, agl_ft: 150, vs_fpm: -250 }));
    const events = tracker.update(at(0.5, { on_ground: true, vs_fpm: -90, g: 1.7 }));
    // VS касания — из точки перехода, пик окна отдаётся отдельно.
    expect(events[0]?.metrics.vs_fpm).toBe(-90);
    expect(events[0]?.vsPeakFpm).toBe(-250);
    expect(events[0]?.metrics.g_force).toBe(1.7);
  });

  it('R5.7: клиентский vs_fpm = серверному при пике окна ≠ VS касания (−479/−210)', () => {
    const tracker = new LandingTracker({ ...NO_MIN_AIRBORNE });
    tracker.update(at(0, { on_ground: false, agl_ft: 300, vs_fpm: -260, alt_ft: 1_200, gs_kt: 140 }));
    tracker.update(at(1, { on_ground: false, agl_ft: 120, vs_fpm: -479, alt_ft: 1_000, gs_kt: 135 }));
    tracker.update(at(2, { on_ground: false, agl_ft: 30, vs_fpm: -300, alt_ft: 900, gs_kt: 130 }));
    const events = tracker.update(
      at(3, { on_ground: true, agl_ft: 0, vs_fpm: -210, alt_ft: 870, gs_kt: 120, g: 1.25 }),
    );
    const event = events[0];
    expect(event?.metrics.vs_fpm).toBe(-210);
    expect(event?.vsPeakFpm).toBe(-479);

    // Серверная сегментация по тем же точкам трека должна дать ту же VS.
    const points: LandingPoint[] = [
      lp(-2, false, -260, 1_000, 140),
      lp(-1, false, -479, 950, 135),
      lp(0, false, -300, 871.75, 130),
      lp(0.5, true, -210, 870, 120),
    ];
    const segments = segmentLandings(
      [
        {
          type: 'touchdown',
          ts: isoAt(BASE_MS, 0.5 * 1000),
          data: {
            vs_fpm: event?.metrics.vs_fpm,
            vs_peak_fpm: event?.vsPeakFpm,
            g: event?.metrics.g_force,
          },
        },
      ],
      points,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.metrics.vs_fpm).toBe(event?.metrics.vs_fpm);
    expect((segments[0]?.flags ?? 0) & QUALITY_BITS.SLEW).toBe(0);
  });

  it('VS касания — сырой кадр перехода, без интерполяции/усреднения окна', () => {
    // Инцидент 2026-10-15: при касании VS меняется быстро (флаер/derotation).
    // Метрика обязана быть мгновенным значением кадра `air→ground`, а не
    // сглаженной величиной между соседними сэмплами (иначе sink занижен).
    const tracker = new LandingTracker({ ...NO_MIN_AIRBORNE });
    tracker.update(at(0, { on_ground: false, agl_ft: 60, vs_fpm: -100 }));
    tracker.update(at(1, { on_ground: false, agl_ft: 20, vs_fpm: -96 }));
    const events = tracker.update(at(2, { on_ground: true, agl_ft: 0, vs_fpm: -137, g: 1.2 }));
    const event = events[0];
    expect(event?.kind).toBe('touchdown');
    expect(event?.metrics.vs_fpm).toBe(-137);
  });

  it('reset очищает состояние', () => {
    const tracker = new TouchdownTracker({ ...NO_MIN_AIRBORNE });
    tracker.update(at(0, { on_ground: false, agl_ft: 150, vs_fpm: -300 }));
    tracker.update(at(1, { on_ground: true, vs_fpm: -150 }));
    expect(tracker.hasTouchdown).toBe(true);
    tracker.reset();
    expect(tracker.hasTouchdown).toBe(false);
    expect(tracker.currentBounceCount).toBe(0);
  });
});

describe('LandingTracker — D1: достоверный подскок (LIRN 21 Oct, 20 Гц)', () => {
  /** Воздушные сэмплы 20 Гц с `startS` по `endS` (шаг 0.05 с) и общим AGL. */
  function airRun(startS: number, count: number, aglFt: number): Array<ReturnType<typeof at>> {
    return Array.from({ length: count }, (_, i) =>
      at(startS + i * 0.05, { on_ground: false, agl_ft: aglFt, vs_fpm: 20, gs_kt: 120 }),
    );
  }

  function landingPoints(
    contactAgl: number,
    hopAgl: number,
    hopStartS: number,
    hopSamples: number,
    contact2S: number,
  ): LandingPoint[] {
    const points: LandingPoint[] = [
      lp(-1, false, -500, 100 + contactAgl + 40, 130),
      lp(0, true, -180, 100 + contactAgl, 120),
    ];
    for (let i = 0; i < hopSamples; i += 1) {
      points.push(lp(hopStartS + i * 0.05, false, 20, 100 + hopAgl, 120));
    }
    points.push(lp(contact2S, true, -160, 100 + contactAgl, 118));
    points.push(lp(contact2S + 0.05, true, -150, 100 + contactAgl, 117));
    points.push(lp(contact2S + 0.5, true, -100, 100 + contactAgl, 100));
    return points;
  }

  it('alekss +0.1 ft: одна посадка, bounceCount=0', () => {
    const tracker = new LandingTracker();
    tracker.update(at(-1, { on_ground: false, agl_ft: 50, vs_fpm: -500, gs_kt: 130 }));
    tracker.update(at(0, { on_ground: true, agl_ft: 10.2, vs_fpm: -180, gs_kt: 120, g: 1.2 }));
    for (const sample of airRun(0.75, 10, 10.3)) tracker.update(sample);
    expect(
      tracker.update(at(1.3, { on_ground: true, agl_ft: 10.2, vs_fpm: -160, gs_kt: 118 })),
    ).toEqual([]);
    expect(tracker.landingCount).toBe(1);
    expect(tracker.currentBounceCount).toBe(0);

    const server = segmentLandings([], landingPoints(10.2, 10.3, 0.75, 10, 1.3));
    expect(server).toHaveLength(1);
    expect(server[0]?.bounceCount).toBe(0);
  });

  it('neohack +0.8 ft: одна посадка, bounceCount=0', () => {
    const tracker = new LandingTracker();
    tracker.update(at(-1, { on_ground: false, agl_ft: 60, vs_fpm: -480, gs_kt: 135 }));
    tracker.update(at(0, { on_ground: true, agl_ft: 12, vs_fpm: -190, gs_kt: 125, g: 1.25 }));
    for (const sample of airRun(0.7, 12, 12.8)) tracker.update(sample);
    expect(
      tracker.update(at(1.76, { on_ground: true, agl_ft: 12, vs_fpm: -170, gs_kt: 120 })),
    ).toEqual([]);
    expect(tracker.landingCount).toBe(1);
    expect(tracker.currentBounceCount).toBe(0);

    const server = segmentLandings([], landingPoints(12, 12.8, 0.7, 12, 1.76));
    expect(server).toHaveLength(1);
    expect(server[0]?.bounceCount).toBe(0);
  });

  it('достоверный подскок +3 ft / 0.6 c: bounceCount=1 (клиент = сервер)', () => {
    const tracker = new LandingTracker();
    tracker.update(at(-1, { on_ground: false, agl_ft: 50, vs_fpm: -500, gs_kt: 130 }));
    tracker.update(at(0, { on_ground: true, agl_ft: 10, vs_fpm: -180, gs_kt: 120, g: 1.2 }));
    for (const sample of airRun(0.05, 12, 13)) tracker.update(sample);
    const events = tracker.update(
      at(0.65, { on_ground: true, agl_ft: 10, vs_fpm: -170, gs_kt: 118 }),
    );
    expect(events[0]).toMatchObject({ kind: 'bounce', bounceCount: 1 });
    expect(tracker.landingCount).toBe(1);

    const server = segmentLandings([], landingPoints(10, 13, 0.05, 12, 0.65));
    expect(server).toHaveLength(1);
    expect(server[0]?.bounceCount).toBe(1);
    expect(tracker.currentBounceCount).toBe(server[0]?.bounceCount);
  });

  it('1–2 воздушных сэмпла (flicker) не открывают отскок', () => {
    const tracker = new LandingTracker();
    tracker.update(at(-1, { on_ground: false, agl_ft: 50, vs_fpm: -500, gs_kt: 130 }));
    tracker.update(at(0, { on_ground: true, agl_ft: 10, vs_fpm: -180, gs_kt: 120, g: 1.2 }));
    tracker.update(at(0.1, { on_ground: false, agl_ft: 12, vs_fpm: 20, gs_kt: 120 }));
    tracker.update(at(0.15, { on_ground: false, agl_ft: 12, vs_fpm: 20, gs_kt: 120 }));
    expect(
      tracker.update(at(0.5, { on_ground: true, agl_ft: 10, vs_fpm: -170, gs_kt: 118 })),
    ).toEqual([]);
    expect(tracker.landingCount).toBe(1);
    expect(tracker.currentBounceCount).toBe(0);
  });

  it('lagged sim VS (−310 vs −200 по высоте) → клиент берёт высоту', () => {
    const tracker = new LandingTracker();
    tracker.update(at(-1.2, { on_ground: false, agl_ft: 300, alt_ft: 600, vs_fpm: -200 }));
    tracker.update(at(-0.9, { on_ground: false, agl_ft: 240, alt_ft: 599, vs_fpm: -200 }));
    tracker.update(at(-0.6, { on_ground: false, agl_ft: 180, alt_ft: 598, vs_fpm: -200 }));
    tracker.update(at(-0.3, { on_ground: false, agl_ft: 120, alt_ft: 597, vs_fpm: -200 }));
    const events = tracker.update(
      at(0, { on_ground: true, agl_ft: 0, alt_ft: 596, vs_fpm: -310, g: 1.2 }),
    );
    expect(events[0]?.metrics.vs_fpm).toBe(-200);
  });
});

describe('LandingTracker — сессия с несколькими посадками (ADR-0010)', () => {
  it('3 посадки: две touch-and-go и full-stop, seq растёт', () => {
    const tracker = new LandingTracker({ ...MECHANICS_ONLY });
    tracker.update(at(0, { on_ground: true, gs_kt: 0 }));

    tracker.update(at(1, { on_ground: false, agl_ft: 100, vs_fpm: -400 }));
    const first = tracker.update(at(2, { on_ground: true, gs_kt: 60, vs_fpm: -150, g: 1.2 }));
    expect(first[0]).toMatchObject({ kind: 'touchdown', landingSeq: 1, bounceCount: 0 });
    tracker.update(at(3, { on_ground: true, gs_kt: 30 }));
    tracker.update(at(4, { on_ground: false, agl_ft: 20, gs_kt: 80, vs_fpm: 300 }));

    tracker.update(at(30, { on_ground: false, agl_ft: 100, vs_fpm: -300 }));
    const second = tracker.update(at(31, { on_ground: true, gs_kt: 60, vs_fpm: -140, g: 1.15 }));
    expect(second[0]).toMatchObject({ kind: 'touchdown', landingSeq: 2, bounceCount: 0 });
    tracker.update(at(33, { on_ground: false, agl_ft: 20, gs_kt: 80, vs_fpm: 300 }));

    tracker.update(at(60, { on_ground: false, agl_ft: 100, vs_fpm: -300 }));
    const third = tracker.update(at(61, { on_ground: true, gs_kt: 60, vs_fpm: -160, g: 1.1 }));
    expect(third[0]).toMatchObject({ kind: 'touchdown', landingSeq: 3, bounceCount: 0 });
    tracker.update(at(62, { on_ground: true, gs_kt: 5 }));
    tracker.update(at(63, { on_ground: true, gs_kt: 0 }));

    expect(tracker.landingCount).toBe(3);
    expect(tracker.touchAndGoCount).toBe(2);
    const [l1, l2, l3] = tracker.landings;
    expect(l1).toMatchObject({ seq: 1, touchAndGo: true, groundContactS: 2, bounceCount: 0 });
    expect(l2).toMatchObject({ seq: 2, touchAndGo: true, groundContactS: 2, bounceCount: 0 });
    expect(l3).toMatchObject({ seq: 3, touchAndGo: false, groundContactS: null });
  });

  it('граница 5 c: повторное касание ровно через 5 c — отскок той же посадки', () => {
    const tracker = new LandingTracker({ ...NO_MIN_AIRBORNE });
    tracker.update(at(0, { on_ground: false, agl_ft: 100, vs_fpm: -300 }));
    tracker.update(at(1, { on_ground: true, gs_kt: 60, vs_fpm: -150 }));
    tracker.update(at(1.5, { on_ground: false, agl_ft: 10, vs_fpm: 100 }));
    tracker.update(at(1.55, { on_ground: false, agl_ft: 10, vs_fpm: 100 }));
    tracker.update(at(1.6, { on_ground: false, agl_ft: 10, vs_fpm: 100 }));
    const events = tracker.update(at(6, { on_ground: true, gs_kt: 60, vs_fpm: -140 }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'bounce', landingSeq: 1, bounceCount: 1 });
    expect(tracker.landingCount).toBe(1);
    expect(tracker.landings[0]?.bounceCount).toBe(1);
    // Подскок не является отрывом — touch-and-go ещё не подтверждён.
    expect(tracker.landings[0]?.touchAndGo).toBe(false);
  });

  it('низкий подскок ≈1 м (LYBE): одна посадка, bounce=1, без touch-and-go', () => {
    const tracker = new LandingTracker();
    tracker.update(at(0, { on_ground: false, agl_ft: 100, vs_fpm: -300, gs_kt: 130 }));
    tracker.update(at(1, { on_ground: false, agl_ft: 20, vs_fpm: -200, gs_kt: 125 }));
    const first = tracker.update(
      at(2, { on_ground: true, agl_ft: 0, vs_fpm: -150, g: 1.2, gs_kt: 120 }),
    );
    expect(first[0]).toMatchObject({ kind: 'touchdown', landingSeq: 1, bounceCount: 0 });

    tracker.update(at(3, { on_ground: false, agl_ft: 3, vs_fpm: -50, gs_kt: 120 }));
    tracker.update(at(3.05, { on_ground: false, agl_ft: 3, vs_fpm: -50, gs_kt: 120 }));
    tracker.update(at(3.1, { on_ground: false, agl_ft: 3, vs_fpm: -50, gs_kt: 120 }));
    const bounce = tracker.update(
      at(3.5, { on_ground: true, agl_ft: 0, vs_fpm: -80, g: 1.1, gs_kt: 118 }),
    );
    expect(bounce[0]).toMatchObject({ kind: 'bounce', landingSeq: 1, bounceCount: 1 });

    // Применён взлётный режим: ~11 ft AGL на ~11 с, затем повторное касание.
    tracker.update(at(5, { on_ground: false, agl_ft: 2, vs_fpm: 200, gs_kt: 125 }));
    tracker.update(at(10, { on_ground: false, agl_ft: 8, vs_fpm: 100, gs_kt: 135 }));
    tracker.update(at(15, { on_ground: false, agl_ft: 11, vs_fpm: -100, gs_kt: 140 }));
    expect(
      tracker.update(at(17, { on_ground: true, agl_ft: 0, vs_fpm: -120, g: 1.1, gs_kt: 130 })),
    ).toEqual([]);

    expect(tracker.landingCount).toBe(1);
    expect(tracker.landings[0]).toMatchObject({
      seq: 1,
      bounceCount: 1,
      touchAndGo: false,
      groundContactS: null,
    });
  });

  it('граница 5 c: касание позже 5 c — новая посадка seq+1', () => {
    const tracker = new LandingTracker({ ...MECHANICS_ONLY });
    tracker.update(at(0, { on_ground: false, agl_ft: 100, vs_fpm: -300 }));
    tracker.update(at(1, { on_ground: true, gs_kt: 60, vs_fpm: -150 }));
    tracker.update(at(1.5, { on_ground: false, agl_ft: 10, vs_fpm: 100, gs_kt: 80 }));
    const events = tracker.update(at(6.001, { on_ground: true, gs_kt: 60, vs_fpm: -140 }));

    expect(events[0]).toMatchObject({ kind: 'touchdown', landingSeq: 2, bounceCount: 0 });
    expect(tracker.landingCount).toBe(2);
  });

  it('полная остановка > stopDwellS снимает touch-and-go', () => {
    const tracker = new LandingTracker({ ...MECHANICS_ONLY });
    tracker.update(at(0, { on_ground: false, agl_ft: 100, vs_fpm: -300 }));
    tracker.update(at(1, { on_ground: true, gs_kt: 120, vs_fpm: -150 }));
    tracker.update(at(2, { on_ground: true, gs_kt: 0 }));
    tracker.update(at(8, { on_ground: true, gs_kt: 0 }));
    tracker.update(at(20, { on_ground: false, agl_ft: 20, gs_kt: 80 }));

    expect(tracker.landings[0]).toMatchObject({
      stoppedOnGround: true,
      touchAndGo: false,
      groundContactS: 19,
    });
  });

  it('короткая выдержка на земле без остановки — touch-and-go', () => {
    const tracker = new LandingTracker({ ...NO_MIN_AIRBORNE });
    tracker.update(at(0, { on_ground: false, agl_ft: 100, vs_fpm: -300 }));
    tracker.update(at(1, { on_ground: true, gs_kt: 100, vs_fpm: -150 }));
    tracker.update(at(2, { on_ground: true, gs_kt: 50 }));
    tracker.update(at(10, { on_ground: false, agl_ft: 30, gs_kt: 90 }));
    expect(tracker.landings[0]).toMatchObject({ touchAndGo: true, groundContactS: 9 });
  });

  it('onGround отражает текущее состояние ВС', () => {
    const tracker = new LandingTracker();
    tracker.update(at(0, { on_ground: true }));
    expect(tracker.onGround).toBe(true);
    tracker.update(at(1, { on_ground: false, agl_ft: 100, gs_kt: 120 }));
    expect(tracker.onGround).toBe(false);
  });
});

describe('LandingTracker — защита от ложной посадки на старте сессии', () => {
  it('старт на земле с транзиентным on_ground=false → 0 посадок и 0 touchdown', () => {
    // Реальная сессия: ВС стоит на полосе, первый кадр ложно сообщает `on_ground=false`
    // (SimVar ещё не заполнен), AGL/vs нулевые. Ложного air→ground быть не должно.
    const tracker = new LandingTracker();
    expect(tracker.update(at(0, { on_ground: false, agl_ft: 0, vs_fpm: 0, gs_kt: 0 }))).toEqual([]);
    expect(tracker.update(at(0.5, { on_ground: false, agl_ft: 0, vs_fpm: 0, gs_kt: 0 }))).toEqual(
      [],
    );
    expect(tracker.update(at(1, { on_ground: true, agl_ft: 0, vs_fpm: 0, gs_kt: 5 }))).toEqual([]);
    expect(tracker.update(at(4, { on_ground: true, gs_kt: 12 }))).toEqual([]);

    expect(tracker.landingCount).toBe(0);
    expect(tracker.hasTouchdown).toBe(false);
    expect(tracker.onGround).toBe(true);
  });

  it('bogus-airborne с большим agl при gs=0 на полосе → 0 посадок (реальный DA62)', () => {
    // Фрагмент рейса fc655a46: первые кадры `on_ground=false`, `agl=204 ft`,
    // `alt=221 ft`, `gs=0`, `vs=0` — ВС реально на ВПП. Высота без движения не
    // должна подтверждать отрыв → ложной посадки #1 нет.
    const tracker = new LandingTracker();
    expect(
      tracker.update(at(0, { on_ground: false, agl_ft: 204, alt_ft: 221, gs_kt: 0, vs_fpm: 0 })),
    ).toEqual([]);
    expect(
      tracker.update(at(1, { on_ground: false, agl_ft: 204, alt_ft: 221, gs_kt: 0, vs_fpm: 0 })),
    ).toEqual([]);
    expect(
      tracker.update(at(4, { on_ground: true, agl_ft: 3, alt_ft: 80, gs_kt: 0, vs_fpm: 0 })),
    ).toEqual([]);

    expect(tracker.landingCount).toBe(0);
    expect(tracker.hasTouchdown).toBe(false);
    expect(tracker.onGround).toBe(true);
  });

  it('подскок на рулении: on_ground=false с низким AGL и всплеском vs — не отрыв', () => {
    const tracker = new LandingTracker();
    tracker.update(at(0, { on_ground: true, gs_kt: 15, agl_ft: 0, vs_fpm: 0 }));
    tracker.update(at(1, { on_ground: false, gs_kt: 15, agl_ft: 3, vs_fpm: 320 }));
    tracker.update(at(2, { on_ground: true, gs_kt: 12, agl_ft: 0, vs_fpm: 0 }));

    expect(tracker.hasConfirmedLiftoff).toBe(false);
    expect(tracker.landingCount).toBe(0);
    expect(tracker.onGround).toBe(true);
  });

  it('старт на земле → руление → взлёт → посадка → 1 посадка', () => {
    const tracker = new LandingTracker();
    tracker.update(at(0, { on_ground: true, gs_kt: 0 }));
    tracker.update(at(2, { on_ground: true, gs_kt: 15 }));
    tracker.update(at(6, { on_ground: true, gs_kt: 60 }));
    tracker.update(at(8, { on_ground: false, agl_ft: 30, vs_fpm: 800, gs_kt: 110 }));
    tracker.update(at(20, { on_ground: false, agl_ft: 2000, vs_fpm: 0, gs_kt: 150 }));
    tracker.update(at(60, { on_ground: false, agl_ft: 200, vs_fpm: -450, gs_kt: 140 }));
    const events = tracker.update(at(70, { on_ground: true, agl_ft: 0, vs_fpm: -180, g: 1.3 }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'touchdown', landingSeq: 1, bounceCount: 0 });
    expect(tracker.landingCount).toBe(1);
    expect(tracker.landings[0]).toMatchObject({ seq: 1, touchAndGo: false, groundContactS: null });
  });

  it('старт в воздухе → посадка засчитывается', () => {
    const tracker = new LandingTracker({ ...NO_MIN_AIRBORNE });
    tracker.update(at(0, { on_ground: false, agl_ft: 1500, vs_fpm: 0, gs_kt: 150 }));
    tracker.update(at(1, { on_ground: false, agl_ft: 100, vs_fpm: -450, gs_kt: 140 }));
    const events = tracker.update(at(2, { on_ground: true, agl_ft: 0, vs_fpm: -160, g: 1.25 }));
    expect(events[0]).toMatchObject({ kind: 'touchdown', landingSeq: 1 });
    expect(tracker.landingCount).toBe(1);
  });

  it('старт в воздухе → посадка через 2 c засчитывается без гейта minAirborneS', () => {
    // BUG-QA-3: запись началась в полёте (поздний арм/старт на финале) — наземного
    // кадра до первого воздушного сэмпла не было. Гейт `minAirborneS` (10 c) не
    // должен подавлять реальную посадку; достоверность держит проверка AGL.
    const tracker = new LandingTracker();
    tracker.update(at(0, { on_ground: false, agl_ft: 1500, vs_fpm: -300, gs_kt: 150 }));
    const events = tracker.update(
      at(2, { on_ground: true, agl_ft: 0, vs_fpm: -160, g: 1.25, gs_kt: 130 }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'touchdown', landingSeq: 1, bounceCount: 0 });
    expect(tracker.landingCount).toBe(1);
    expect(tracker.hasConfirmedLiftoff).toBe(true);
  });

  it('взлёт с земли и посадка в пределах 10 c: гейт длительности сохраняется', () => {
    // Гейт `minAirborneS` — то, что блокирует взлётную пробежку: фаза, начавшаяся
    // на земле, короче 10 c не даёт посадку, даже если AGL успел набраться.
    const tracker = new LandingTracker();
    tracker.update(at(0, { on_ground: true, gs_kt: 0, agl_ft: 0 }));
    tracker.update(at(1, { on_ground: false, agl_ft: 60, vs_fpm: 900, gs_kt: 120 }));
    const events = tracker.update(
      at(3, { on_ground: true, agl_ft: 0, vs_fpm: -150, g: 1.2, gs_kt: 110 }),
    );
    expect(events).toEqual([]);
    expect(tracker.landingCount).toBe(0);
  });

  it('slew-кадр не подтверждает отрыв; последующая земля не даёт посадку', () => {
    const tracker = new LandingTracker();
    tracker.update(at(0, { on_ground: true, gs_kt: 0 }));
    expect(
      tracker.update(
        at(1, {
          slew: true,
          on_ground: false,
          agl_ft: 3000,
          vs_fpm: 1500,
          gs_kt: 200,
          lat: 40,
          lon: -74,
        }),
      ),
    ).toEqual([]);
    expect(tracker.hasConfirmedLiftoff).toBe(false);

    expect(tracker.update(at(2, { on_ground: true, gs_kt: 0, lat: 40, lon: -74 }))).toEqual([]);
    expect(tracker.hasConfirmedLiftoff).toBe(false);
    expect(tracker.hasTouchdown).toBe(false);
    expect(tracker.landingCount).toBe(0);
  });

  it('slew-off телепорт (флаг сброшен) распознаётся по скачку позиции', () => {
    const tracker = new LandingTracker();
    tracker.update(at(0, { on_ground: true, gs_kt: 0 }));
    expect(
      tracker.update(
        at(1, { on_ground: false, agl_ft: 3000, vs_fpm: 1500, gs_kt: 200, lat: 40, lon: -74 }),
      ),
    ).toEqual([]);
    expect(tracker.hasConfirmedLiftoff).toBe(false);

    expect(tracker.update(at(2, { on_ground: true, gs_kt: 0, lat: 40, lon: -74 }))).toEqual([]);
    expect(tracker.landingCount).toBe(0);
    expect(tracker.hasConfirmedLiftoff).toBe(false);
  });

  it('4 цикла взлёт-посадка → 4 посадки', () => {
    const tracker = new LandingTracker();
    tracker.update(at(0, { on_ground: true, gs_kt: 0 }));
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const base = cycle * 30;
      tracker.update(at(base + 2, { on_ground: true, gs_kt: 60 }));
      tracker.update(at(base + 4, { on_ground: false, agl_ft: 50, vs_fpm: 800, gs_kt: 110 }));
      tracker.update(at(base + 12, { on_ground: false, agl_ft: 1000, vs_fpm: 0, gs_kt: 150 }));
      tracker.update(at(base + 20, { on_ground: false, agl_ft: 150, vs_fpm: -400, gs_kt: 135 }));
      const events = tracker.update(
        at(base + 22, { on_ground: true, agl_ft: 0, vs_fpm: -150, gs_kt: 110 }),
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'touchdown', landingSeq: cycle + 1, bounceCount: 0 });
      tracker.update(at(base + 23, { on_ground: true, gs_kt: 40 }));
    }
    expect(tracker.landingCount).toBe(4);
    expect(tracker.landings.map((landing) => landing.seq)).toEqual([1, 2, 3, 4]);
  });
});

describe('LandingTracker — телепорт-инвалидация (BUG-1)', () => {
  it('короткий slew в воздух → нет отрыва и касания', () => {
    const tracker = new LandingTracker();
    tracker.update(at(0, { on_ground: true, gs_kt: 0 }));
    tracker.update(
      at(1, { slew: true, on_ground: false, agl_ft: 3000, vs_fpm: 1500, gs_kt: 200 }),
    );
    // Кадр после slew: до-slew база (t=0) рядом, скачка нет — кадр обрабатывается,
    // но флаг телепорта не даёт подтвердить отрыв.
    expect(tracker.update(at(2, { on_ground: false, agl_ft: 4000, vs_fpm: 0, gs_kt: 220 }))).toEqual(
      [],
    );
    expect(tracker.hasConfirmedLiftoff).toBe(false);
    expect(tracker.landingCount).toBe(0);

    // Возврат на землю — тоже не посадка: подтверждённого отрыва не было.
    expect(tracker.update(at(10, { on_ground: true, agl_ft: 0, vs_fpm: -150 }))).toEqual([]);
    expect(tracker.hasTouchdown).toBe(false);
    expect(tracker.landingCount).toBe(0);
  });

  it('длинный slew (> maxGapS) в воздух → нет отрыва (флаг переживает устаревшую базу)', () => {
    const tracker = new LandingTracker();
    tracker.update(at(0, { on_ground: true, gs_kt: 60 }));
    tracker.update(
      at(1, { slew: true, on_ground: false, agl_ft: 3000, vs_fpm: 1500, gs_kt: 200 }),
    );
    tracker.update(
      at(6, { slew: true, on_ground: false, agl_ft: 3500, vs_fpm: 1000, gs_kt: 220 }),
    );
    // Slew off: `previousSample` = t=0, dt=7 c > maxGapS → скачок не классифицируется,
    // но флаг уже выставлен на кадрах slew и держится до наземного кадра.
    tracker.update(at(7, { on_ground: false, agl_ft: 4000, vs_fpm: 0, gs_kt: 220 }));
    expect(tracker.hasConfirmedLiftoff).toBe(false);
    expect(tracker.landingCount).toBe(0);
  });

  it('сессия начинается в slew → воздух не подтверждает отрыв', () => {
    const tracker = new LandingTracker();
    tracker.update(at(0, { slew: true, on_ground: false, agl_ft: 5000, vs_fpm: 2000, gs_kt: 220 }));
    tracker.update(at(1, { on_ground: false, agl_ft: 6000, vs_fpm: 0, gs_kt: 220 }));
    expect(tracker.hasConfirmedLiftoff).toBe(false);
    expect(tracker.landingCount).toBe(0);
  });

  it('slew на земле → наземные кадры снимают инвалидацию → реальный взлёт и посадка', () => {
    const tracker = new LandingTracker();
    tracker.update(at(0, { on_ground: true, gs_kt: 0 }));
    tracker.update(at(1, { slew: true, on_ground: true, gs_kt: 0 }));
    tracker.update(at(2, { on_ground: true, gs_kt: 5 }));
    tracker.update(at(4, { on_ground: true, gs_kt: 60 }));
    tracker.update(at(6, { on_ground: false, agl_ft: 50, vs_fpm: 800, gs_kt: 120 }));
    expect(tracker.hasConfirmedLiftoff).toBe(true);

    tracker.update(at(20, { on_ground: false, agl_ft: 2000, vs_fpm: 0, gs_kt: 150 }));
    const events = tracker.update(
      at(30, { on_ground: true, agl_ft: 0, vs_fpm: -160, g: 1.25, gs_kt: 120 }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'touchdown', landingSeq: 1 });
    expect(tracker.landingCount).toBe(1);
  });
});

describe('LandingTracker — достоверный отрыв и посадка (F: ложная #1 на разбеге)', () => {
  it('разбег с gs 60 kt и agl ≈ 0 → ни отрыва, ни касания, ни посадки', () => {
    // F (client 0.3.x): ВС загружено на ВПП с работающими двигателями. Пробежка
    // даёт `on_ground=false`, `gs ≥ 40`, `agl ≈ 0`; раньше flying-gs подтверждал
    // отрыв и следующее `on_ground=true` давало ложную посадку на ~98 баллов.
    const tracker = new LandingTracker();
    tracker.update(at(0, { on_ground: true, gs_kt: 0, agl_ft: 0 }));
    expect(tracker.update(at(1, { on_ground: false, gs_kt: 40, agl_ft: 1, vs_fpm: 0 }))).toEqual(
      [],
    );
    expect(tracker.update(at(2, { on_ground: false, gs_kt: 60, agl_ft: 5, vs_fpm: 0 }))).toEqual(
      [],
    );
    const events = tracker.update(
      at(3, { on_ground: true, gs_kt: 70, agl_ft: 0, vs_fpm: 0, g: 1.0 }),
    );

    expect(events).toEqual([]);
    expect(tracker.hasConfirmedLiftoff).toBe(false);
    expect(tracker.landingCount).toBe(0);
    expect(tracker.hasTouchdown).toBe(false);
  });

  it('реальный рейс: набор 3000 ft, крейсер и посадка → ровно 1 посадка со скором', () => {
    const tracker = new LandingTracker({ aircraftIcao: 'B738' });
    tracker.update(at(0, { on_ground: true, gs_kt: 0, agl_ft: 0 }));
    tracker.update(at(2, { on_ground: true, gs_kt: 60, agl_ft: 0 }));
    tracker.update(at(5, { on_ground: false, agl_ft: 40, vs_fpm: 1200, gs_kt: 130 }));
    tracker.update(at(20, { on_ground: false, agl_ft: 3000, vs_fpm: 0, gs_kt: 220 }));
    tracker.update(at(200, { on_ground: false, agl_ft: 2500, vs_fpm: -800, gs_kt: 180 }));
    tracker.update(at(240, { on_ground: false, agl_ft: 50, vs_fpm: -600, gs_kt: 140 }));
    const events = tracker.update(
      at(242, { on_ground: true, agl_ft: 0, vs_fpm: -150, g: 1.2, gs_kt: 120 }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'touchdown', landingSeq: 1, bounceCount: 0 });
    expect(events[0]?.metrics.vs_fpm).toBe(-150);
    expect(events[0]?.metrics.aircraft_icao).toBe('B738');
    expect(events[0]?.score.score).toBeGreaterThan(0);
    expect(tracker.hasConfirmedLiftoff).toBe(true);
    expect(tracker.landingCount).toBe(1);
  });

  it('touch-and-go: достоверный набор высоты и выдержка ≥ MIN_AIRBORNE_S → считается', () => {
    const tracker = new LandingTracker();
    tracker.update(at(0, { on_ground: false, agl_ft: 2000, vs_fpm: -500, gs_kt: 140 }));
    tracker.update(at(20, { on_ground: false, agl_ft: 50, vs_fpm: -400, gs_kt: 130 }));
    const first = tracker.update(
      at(21, { on_ground: true, gs_kt: 110, vs_fpm: -150, g: 1.2, agl_ft: 0 }),
    );
    expect(first[0]).toMatchObject({ kind: 'touchdown', landingSeq: 1 });

    tracker.update(at(23, { on_ground: false, agl_ft: 40, vs_fpm: 800, gs_kt: 120 }));
    tracker.update(at(40, { on_ground: false, agl_ft: 1500, vs_fpm: 0, gs_kt: 160 }));

    expect(tracker.landingCount).toBe(1);
    expect(tracker.landings[0]).toMatchObject({ seq: 1, touchAndGo: true });
  });

  it('короткий подскок (15 ft AGL, 3 c) → не посадка', () => {
    const tracker = new LandingTracker();
    tracker.update(at(0, { on_ground: true, gs_kt: 60, agl_ft: 0 }));
    tracker.update(at(1, { on_ground: false, agl_ft: 15, vs_fpm: 300, gs_kt: 70 }));
    tracker.update(at(3, { on_ground: false, agl_ft: 10, vs_fpm: -300, gs_kt: 65 }));
    const events = tracker.update(
      at(4, { on_ground: true, agl_ft: 0, vs_fpm: -100, gs_kt: 60 }),
    );

    expect(events).toEqual([]);
    expect(tracker.hasConfirmedLiftoff).toBe(false);
    expect(tracker.hasTouchdown).toBe(false);
    expect(tracker.landingCount).toBe(0);
  });
});

describe('LandingTracker — P2: валидность касания', () => {
  function approach(tracker: LandingTracker): void {
    tracker.update(
      at(0, { on_ground: false, agl_ft: 50, vs_fpm: -400, gs_kt: 140, alt_ft: 700 }),
    );
    tracker.update(
      at(1, { on_ground: false, agl_ft: 20, vs_fpm: -500, gs_kt: 135, alt_ft: 650 }),
    );
  }

  it('vs_fpm=0, g=1.00 на касании → посадка эмитится, vs_fpm=null (неизмеренный)', () => {
    const tracker = new LandingTracker();
    approach(tracker);
    const events = tracker.update(
      at(2, { on_ground: true, agl_ft: 0, vs_fpm: 0, g: 1.0, gs_kt: 120, alt_ft: 600 }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'touchdown', landingSeq: 1 });
    expect(events[0]?.metrics.vs_fpm).toBeNull();
    expect(events[0]?.metrics.g_force).toBe(1);
    expect(tracker.landingCount).toBe(1);
    expect(tracker.hasTouchdown).toBe(true);
  });

  it('g_force < 1.0 на касании → посадка эмитится, g сохранён (не обнулён)', () => {
    const tracker = new LandingTracker();
    approach(tracker);
    const events = tracker.update(
      at(2, { on_ground: true, agl_ft: 0, vs_fpm: -180, g: 0.94, gs_kt: 120, alt_ft: 600 }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.metrics.vs_fpm).toBe(-180);
    expect(events[0]?.metrics.g_force).toBe(0.94);
    expect(tracker.landingCount).toBe(1);
  });

  it('нормальная посадка (vs<0, g>=1) не затронута', () => {
    const tracker = new LandingTracker();
    approach(tracker);
    const events = tracker.update(
      at(2, { on_ground: true, agl_ft: 0, vs_fpm: -180, g: 1.2, gs_kt: 120, alt_ft: 600 }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'touchdown', landingSeq: 1 });
    expect(events[0]?.metrics.vs_fpm).toBe(-180);
    expect(tracker.landingCount).toBe(1);
  });
});
