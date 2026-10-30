import { QUALITY_BITS } from '@flightlog/contracts';
import { describe, expect, it } from 'vitest';

import {
  analyzeTrackIntegrity,
  assessFlightQuality,
  assessTouchdownWindow,
  hasConfirmedLiftoff,
  hasCredibleClimb,
  plausibilityFlags,
  scoreLanding,
  scoringWeightsForComponents,
  SCORE_VERSION,
} from './index';

const TOUCHDOWN = '2026-09-23T12:00:00.000Z';

function pointsAt(hz: number, opts: { fromS?: number; toS?: number; startIndex?: number } = {}) {
  const fromS = opts.fromS ?? -30;
  const toS = opts.toS ?? 30;
  const step = 1 / hz;
  const result: { client_point_id: string; ts: string; quality: number }[] = [];
  const base = Date.parse(TOUCHDOWN);
  const start = opts.startIndex ?? 0;
  let i = start;
  for (let t = fromS; t <= toS + 1e-9; t += step) {
    result.push({
      client_point_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ts: new Date(base + Math.round(t * 1000)).toISOString(),
      quality: 0,
    });
    i += 1;
  }
  return result;
}

describe('assessTouchdownWindow', () => {
  it('10 Гц без разрывов — confidence 1 и допуск в лидерборд', () => {
    const result = assessTouchdownWindow(pointsAt(10), { touchdownTs: TOUCHDOWN });
    expect(result.sample_count).toBe(601);
    expect(result.effective_hz).toBeCloseTo(10, 0);
    expect(result.confidence).toBe(1);
    expect(result.gap_in_window).toBe(false);
    expect(result.leaderboard_eligible).toBe(true);
    expect(result.quality_flags).toBe(0);
  });

  it('низкий FPS (4 Гц) — LOW_RATE_WINDOW, но допуск сохраняется', () => {
    const result = assessTouchdownWindow(pointsAt(4), { touchdownTs: TOUCHDOWN });
    expect(result.effective_hz).toBeLessThan(5);
    expect(result.quality_flags & QUALITY_BITS.LOW_RATE_WINDOW).toBe(QUALITY_BITS.LOW_RATE_WINDOW);
    expect(result.leaderboard_eligible).toBe(true);
    expect(result.confidence).toBeLessThan(1);
    expect(result.point_updates.length).toBeGreaterThan(0);
    for (const update of result.point_updates) {
      expect(update.quality & QUALITY_BITS.LOW_RATE_WINDOW).toBe(QUALITY_BITS.LOW_RATE_WINDOW);
    }
  });

  it('разрыв в окне — GAP_BEFORE, но допуск сохраняется', () => {
    const dense = pointsAt(10, { fromS: -30, toS: -2 });
    const afterGap = pointsAt(10, { fromS: 5, toS: 30, startIndex: 1000 });
    const result = assessTouchdownWindow([...dense, ...afterGap], { touchdownTs: TOUCHDOWN });
    expect(result.gap_count).toBeGreaterThanOrEqual(1);
    expect(result.gap_in_window).toBe(true);
    expect(result.leaderboard_eligible).toBe(true);
    const flagged = result.point_updates.filter(
      (update) => update.quality & QUALITY_BITS.GAP_BEFORE,
    );
    expect(flagged.length).toBeGreaterThanOrEqual(1);
  });

  it('значения с битами SLEW в окне исключают рейс из лидерборда', () => {
    const points = pointsAt(10).map((point, index) => ({
      ...point,
      quality: index === 100 ? QUALITY_BITS.SLEW : 0,
    }));
    const result = assessTouchdownWindow(points, { touchdownTs: TOUCHDOWN });
    expect(result.leaderboard_eligible).toBe(false);
    expect(result.slew_in_eligibility_window).toBe(true);
    expect(result.quality_flags & QUALITY_BITS.SLEW).toBe(QUALITY_BITS.SLEW);
  });

  it('SLEW в начале рейса (10 минут до касания) не лишает допуска', () => {
    const early = {
      client_point_id: 'early-slew',
      ts: new Date(Date.parse(TOUCHDOWN) - 10 * 60 * 1000).toISOString(),
      quality: QUALITY_BITS.SLEW,
    };
    const result = assessTouchdownWindow([early, ...pointsAt(10)], { touchdownTs: TOUCHDOWN });
    expect(result.slew_in_eligibility_window).toBe(false);
    expect(result.leaderboard_eligible).toBe(true);
  });

  it('SLEW в последние 5 минут до касания лишает допуска', () => {
    const localSlew = {
      client_point_id: 'local-slew',
      ts: new Date(Date.parse(TOUCHDOWN) - 2 * 60 * 1000).toISOString(),
      quality: QUALITY_BITS.SLEW,
    };
    const result = assessTouchdownWindow([...pointsAt(10), localSlew], {
      touchdownTs: TOUCHDOWN,
    });
    expect(result.slew_in_eligibility_window).toBe(true);
    expect(result.leaderboard_eligible).toBe(false);
    expect(result.quality_flags & QUALITY_BITS.SLEW).toBe(QUALITY_BITS.SLEW);
  });

  it('граница ровно 5 минут до касания включена в гейт', () => {
    const atBoundary = {
      client_point_id: 'boundary-slew',
      ts: new Date(Date.parse(TOUCHDOWN) - 300 * 1000).toISOString(),
      quality: QUALITY_BITS.SLEW,
    };
    const result = assessTouchdownWindow([...pointsAt(10), atBoundary], {
      touchdownTs: TOUCHDOWN,
    });
    expect(result.slew_in_eligibility_window).toBe(true);
    expect(result.leaderboard_eligible).toBe(false);
  });

  it('CLOCK_INVALID/INTERPOLATED в окне не лишают допуска', () => {
    const points = pointsAt(10).map((point, index) => ({
      ...point,
      quality:
        index === 100 ? QUALITY_BITS.CLOCK_INVALID : index === 200 ? QUALITY_BITS.INTERPOLATED : 0,
    }));
    const result = assessTouchdownWindow(points, { touchdownTs: TOUCHDOWN });
    expect(result.leaderboard_eligible).toBe(true);
  });

  it('пустое окно — невалидный результат без допуска', () => {
    const result = assessTouchdownWindow([], { touchdownTs: TOUCHDOWN });
    expect(result.sample_count).toBe(0);
    expect(result.leaderboard_eligible).toBe(false);
    expect(result.confidence).toBe(0);
  });
});

describe('assessFlightQuality (серверный eligibility, T57/F-04)', () => {
  const clean = pointsAt(10).map((point) => ({ ...point, g_force: 1.2, vertical_speed_fpm: -150 }));

  it('чистое окно 10 Гц — confidence 1 и допуск в лидерборд', () => {
    const result = assessFlightQuality(clean, { touchdownTs: TOUCHDOWN });
    expect(result.confidence).toBe(1);
    expect(result.leaderboard_eligible).toBe(true);
    expect(result.is_partial).toBe(false);
    expect(result.quality_flags).toBe(0);
  });

  it('невозможный g/|vs| помечается SLEW и лишает допуска (plausibility)', () => {
    expect(plausibilityFlags({ client_point_id: 'x', ts: TOUCHDOWN, quality: 0, g_force: 9 })).toBe(
      QUALITY_BITS.SLEW,
    );
    expect(
      plausibilityFlags({
        client_point_id: 'x',
        ts: TOUCHDOWN,
        quality: 0,
        vertical_speed_fpm: -9000,
      }),
    ).toBe(QUALITY_BITS.SLEW);
    expect(
      plausibilityFlags({ client_point_id: 'x', ts: TOUCHDOWN, quality: 0, g_force: 1.3 }),
    ).toBe(0);

    const manipulated = clean.map((point, index) =>
      index === 200 ? { ...point, g_force: 12 } : point,
    );
    const result = assessFlightQuality(manipulated, { touchdownTs: TOUCHDOWN });
    expect(result.quality_flags & QUALITY_BITS.SLEW).toBe(QUALITY_BITS.SLEW);
    expect(result.leaderboard_eligible).toBe(false);
  });

  it('клиентский is_partial не лишает допуска, PAUSED — лишает', () => {
    const paused = assessFlightQuality(clean, {
      touchdownTs: TOUCHDOWN,
      qualityFlagsHint: QUALITY_BITS.PAUSED,
    });
    expect(paused.is_partial).toBe(true);
    expect(paused.leaderboard_eligible).toBe(false);

    const partial = assessFlightQuality(clean, { touchdownTs: TOUCHDOWN, isPartialHint: true });
    expect(partial.is_partial).toBe(true);
    expect(partial.leaderboard_eligible).toBe(true);
  });

  it('подтверждённая посадка снимает терминальный is_partial-hint (T99)', () => {
    const confirmed = assessFlightQuality(clean, {
      touchdownTs: TOUCHDOWN,
      isPartialHint: true,
      landingConfirmed: true,
    });
    expect(confirmed.is_partial).toBe(false);
    expect(confirmed.leaderboard_eligible).toBe(true);

    const unconfirmed = assessFlightQuality(clean, {
      touchdownTs: TOUCHDOWN,
      isPartialHint: true,
      landingConfirmed: false,
    });
    expect(unconfirmed.is_partial).toBe(true);
    expect(unconfirmed.leaderboard_eligible).toBe(true);
  });

  it('подтверждённая посадка не отменяет гэп/partial, но гэп не лишает допуска (T99)', () => {
    const dense = pointsAt(10, { fromS: -30, toS: -2 });
    const afterGap = pointsAt(10, { fromS: 5, toS: 30, startIndex: 1000 });
    const gapped = [...dense, ...afterGap].map((point) => ({
      ...point,
      g_force: 1.2,
      vertical_speed_fpm: -150,
    }));
    const result = assessFlightQuality(gapped, {
      touchdownTs: TOUCHDOWN,
      isPartialHint: true,
      landingConfirmed: true,
    });
    expect(result.is_partial).toBe(true);
    expect(result.leaderboard_eligible).toBe(true);
  });

  it('низкий FPS окна → LOW_RATE_WINDOW, но допуск сохраняется', () => {
    const sparse = pointsAt(4).map((point) => ({ ...point, g_force: 1.1 }));
    const result = assessFlightQuality(sparse, { touchdownTs: TOUCHDOWN });
    expect(result.quality_flags & QUALITY_BITS.LOW_RATE_WINDOW).toBe(QUALITY_BITS.LOW_RATE_WINDOW);
    expect(result.leaderboard_eligible).toBe(true);
  });

  it('SLEW в начале рейса не лишает допуска (5-минутное окно)', () => {
    const early = {
      client_point_id: 'early-slew',
      ts: new Date(Date.parse(TOUCHDOWN) - 10 * 60 * 1000).toISOString(),
      quality: QUALITY_BITS.SLEW,
      g_force: 1.0,
      vertical_speed_fpm: 0,
      altitude_ft: 0,
    };
    const result = assessFlightQuality([...clean, early], { touchdownTs: TOUCHDOWN });
    expect(result.quality_flags & QUALITY_BITS.SLEW).toBe(0);
    expect(result.leaderboard_eligible).toBe(true);
  });

  it('SLEW в последние 5 минут до касания лишает допуска', () => {
    const localSlew = {
      client_point_id: 'local-slew',
      ts: new Date(Date.parse(TOUCHDOWN) - 2 * 60 * 1000).toISOString(),
      quality: QUALITY_BITS.SLEW,
      g_force: 1.0,
      vertical_speed_fpm: -150,
      altitude_ft: 850,
    };
    const result = assessFlightQuality([...clean, localSlew], { touchdownTs: TOUCHDOWN });
    expect(result.quality_flags & QUALITY_BITS.SLEW).toBe(QUALITY_BITS.SLEW);
    expect(result.leaderboard_eligible).toBe(false);
  });

  it('серверный телепорт в последние 5 минут до касания лишает допуска', () => {
    const anchor = Date.parse(TOUCHDOWN);
    const teleport = [
      {
        client_point_id: 'tp-a',
        ts: new Date(anchor - 2 * 60 * 1000).toISOString(),
        quality: 0,
        latitude: 55.0,
        longitude: 37.0,
        groundspeed_kt: 140,
        g_force: 1.0,
        vertical_speed_fpm: -150,
        altitude_ft: 2000,
      },
      {
        client_point_id: 'tp-b',
        ts: new Date(anchor - 2 * 60 * 1000 + 1000).toISOString(),
        quality: 0,
        latitude: 56.0,
        longitude: 38.0,
        groundspeed_kt: 140,
        g_force: 1.0,
        vertical_speed_fpm: -150,
        altitude_ft: 2000,
      },
    ];
    const result = assessFlightQuality([...clean, ...teleport], { touchdownTs: TOUCHDOWN });
    expect(result.quality_flags & QUALITY_BITS.SLEW).toBe(QUALITY_BITS.SLEW);
    expect(result.leaderboard_eligible).toBe(false);
  });

  it('без касания — confidence 0 и не допускается', () => {
    const result = assessFlightQuality(clean, { touchdownTs: null, isPartialHint: true });
    expect(result.confidence).toBe(0);
    expect(result.leaderboard_eligible).toBe(false);
    expect(result.is_partial).toBe(true);
  });

  it('детерминирован', () => {
    expect(assessFlightQuality(clean, { touchdownTs: TOUCHDOWN })).toEqual(
      assessFlightQuality(clean, { touchdownTs: TOUCHDOWN }),
    );
  });
});

describe('analyzeTrackIntegrity (DATA-1/R-01)', () => {
  function point(offsetS: number, overrides: Record<string, unknown> = {}) {
    return {
      ts: new Date(Date.parse(TOUCHDOWN) + offsetS * 1000).toISOString(),
      lat: 55.972,
      lon: 37.414,
      groundspeed_kt: 140,
      vertical_speed_fpm: -150,
      g_force: 1.1,
      altitude_ft: 850,
      ...overrides,
    };
  }

  it('непрерывный трек без аномалий — flags 0', () => {
    const result = analyzeTrackIntegrity([point(0), point(1), point(2)]);
    expect(result.flags).toBe(0);
    expect(result.teleports).toBe(0);
    expect(result.value_violations).toBe(0);
  });

  it('скачок позиции (телепорт) помечается SLEW', () => {
    const result = analyzeTrackIntegrity([
      point(0, { lat: 55.972, lon: 37.414 }),
      point(1, { lat: 56.972, lon: 38.414 }),
    ]);
    expect(result.teleports).toBe(1);
    expect(result.flags & QUALITY_BITS.SLEW).toBe(QUALITY_BITS.SLEW);
  });

  it('стартовый артефакт SimConnect: прыжок позиции без движения — не телепорт (DA62)', () => {
    // Реальный рейс: первые кадры отдают координаты 0/90 при `gs=0`, `vs=0`,
    // затем позиция «прыгает» на аэродром. Это не slew, а неустоявшаяся телеметрия.
    const result = analyzeTrackIntegrity([
      {
        ts: '2026-09-25T15:04:59.124Z',
        lat: 0,
        lon: 90.00032,
        groundspeed_kt: 0,
        vertical_speed_fpm: 0,
        altitude_ft: 220.8,
      },
      {
        ts: '2026-09-25T15:05:02.706Z',
        lat: 0,
        lon: 90.00032,
        groundspeed_kt: 0,
        vertical_speed_fpm: 0,
        altitude_ft: 220.8,
      },
      {
        ts: '2026-09-25T15:05:03.280Z',
        lat: 43.45189,
        lon: 39.9592,
        groundspeed_kt: 0,
        vertical_speed_fpm: 0,
        altitude_ft: 80.2,
      },
    ]);
    expect(result.teleports).toBe(0);
    expect(result.flags).toBe(0);
  });

  it('устойчивое движение с невозможной скоростью — телепорт (slew, не сбой)', () => {
    const result = analyzeTrackIntegrity([
      point(0, { lat: 55.0, lon: 37.0, altitude_ft: 850, groundspeed_kt: 140 }),
      point(1, { lat: 55.02, lon: 37.0, altitude_ft: 850, groundspeed_kt: 140 }),
      point(2, { lat: 55.04, lon: 37.0, altitude_ft: 850, groundspeed_kt: 140 }),
    ]);
    expect(result.teleports).toBeGreaterThan(0);
    expect(result.flags & QUALITY_BITS.SLEW).toBe(QUALITY_BITS.SLEW);
  });

  it('большой разрыв во времени — гэп/пауза, а не телепорт (T97)', () => {
    const result = analyzeTrackIntegrity([
      point(0, { lat: 55.972, lon: 37.414 }),
      point(30, { lat: 56.972, lon: 38.414 }),
    ]);
    expect(result.teleports).toBe(0);
    expect(result.flags).toBe(0);
  });

  it('артефакт таймбазы на реальном треке A350 — не телепорт (T97 golden)', () => {
    // Фрагмент рейса A359 ZSPD→RJTT (seq 2951→2952): позиция прошла ~1516 м за
    // заявленные 0.968 с, но и высота продвинулась в те же ~5.5× относительно
    // приборных `vs`/`gs`, т.е. сдвинуто всё состояние во времени (сжатый `dt`),
    // а не только координата. Раньше такой одиночный сэмпл помечал весь рейс
    // ложным `SLEW` и лишал лидерборда.
    const result = analyzeTrackIntegrity([
      {
        ts: '2026-09-24T17:18:46.299Z',
        lat: 31.89841814087165,
        lon: 126.47708854665039,
        groundspeed_kt: 529.2286,
        vertical_speed_fpm: 633,
        altitude_ft: 39963.844,
      },
      {
        ts: '2026-09-24T17:18:47.267Z',
        lat: 31.901758538959406,
        lon: 126.49266135241366,
        groundspeed_kt: 529.461,
        vertical_speed_fpm: 719,
        altitude_ft: 40027.73,
      },
    ]);
    expect(result.teleports).toBe(0);
    expect(result.flags).toBe(0);
  });

  it('невозможные g/vs/alt и groundspeed помечаются SLEW', () => {
    const result = analyzeTrackIntegrity([
      point(0, { g_force: 9 }),
      point(1, { vertical_speed_fpm: -9000 }),
      point(2, { altitude_ft: 90000 }),
      point(3, { groundspeed_kt: 9999 }),
    ]);
    expect(result.flags & QUALITY_BITS.SLEW).toBe(QUALITY_BITS.SLEW);
    expect(result.value_violations).toBe(3);
    expect(result.speed_spikes).toBe(1);
  });

  it('две точки с одинаковым ts не дают ложного телепорта (dt=0)', () => {
    const result = analyzeTrackIntegrity([
      point(0, { lat: 55.972, lon: 37.414 }),
      point(0, { lat: 56.972, lon: 38.414 }),
    ]);
    expect(result.teleports).toBe(0);
    expect(result.flags).toBe(0);
  });

  it('глубокий откат ts относительно seq → CLOCK_INVALID (вне лидерборда)', () => {
    // Позже записанная точка (seq=2) имеет более раннее время на 60 с — это не
    // backfill окна касания (≤30 с), а сбой часов/подмена: value-бит исключает
    // рейс из скоринга и лидерборда.
    const result = analyzeTrackIntegrity([
      { ...point(0), seq: 1, ts: new Date(Date.parse(TOUCHDOWN) + 1000).toISOString() },
      { ...point(0), seq: 2, ts: new Date(Date.parse(TOUCHDOWN) - 60_000).toISOString() },
      { ...point(0), seq: 3, ts: new Date(Date.parse(TOUCHDOWN) + 2000).toISOString() },
    ]);
    expect(result.ts_inversions).toBe(1);
    expect(result.flags & QUALITY_BITS.CLOCK_INVALID).toBe(QUALITY_BITS.CLOCK_INVALID);
    expect(result.teleports).toBe(0);
  });

  it('точечный (одиночный) откат ts значимой глубины → CLOCK_INVALID', () => {
    const result = analyzeTrackIntegrity([
      { ...point(0), seq: 1, ts: TOUCHDOWN },
      { ...point(0), seq: 2, ts: new Date(Date.parse(TOUCHDOWN) - 20_000).toISOString() },
      { ...point(0), seq: 3, ts: new Date(Date.parse(TOUCHDOWN) + 200).toISOString() },
    ]);
    expect(result.ts_inversions).toBe(1);
    expect(result.flags & QUALITY_BITS.CLOCK_INVALID).toBe(QUALITY_BITS.CLOCK_INVALID);
  });

  it('legit backfill окна касания (поздний seq, ранний ts ≤30 с) — НЕ CLOCK_INVALID (R6.1)', () => {
    // Реальный паттерн агента: после касания (seq=1, ts=TOUCHDOWN) материализуются
    // точки окна за 30 с до него с seq=2..N; хронология по ts, `seq↔ts` — не
    // инвариант (api.md §3.3). Раньше это ложно дисквалифицировало рейс.
    const points = [
      { ...point(0), seq: 1, ts: TOUCHDOWN },
      ...Array.from({ length: 29 }, (_, i) => ({
        ...point(0),
        seq: i + 2,
        ts: new Date(Date.parse(TOUCHDOWN) - 29_000 + i * 1000).toISOString(),
      })),
      { ...point(0), seq: 31, ts: new Date(Date.parse(TOUCHDOWN) + 1000).toISOString() },
    ];
    const result = analyzeTrackIntegrity(points);
    expect(result.ts_inversions).toBe(0);
    expect(result.flags & QUALITY_BITS.CLOCK_INVALID).toBe(0);
  });

  it('дубли seq (seq-reset/две сессии) — признак неоценим, НЕ CLOCK_INVALID (R6.1)', () => {
    // Смешение двух сессий с независимыми счётчиками seq не восстанавливает
    // порядок записи, поэтому ложный вердикт о подмене часов недопустим.
    const result = analyzeTrackIntegrity([
      { ...point(0), seq: 1, ts: new Date(Date.parse(TOUCHDOWN) + 5000).toISOString() },
      { ...point(0), seq: 2, ts: new Date(Date.parse(TOUCHDOWN) + 6000).toISOString() },
      { ...point(0), seq: 1, ts: TOUCHDOWN },
      { ...point(0), seq: 2, ts: new Date(Date.parse(TOUCHDOWN) + 1000).toISOString() },
    ]);
    expect(result.ts_inversions).toBe(0);
    expect(result.flags & QUALITY_BITS.CLOCK_INVALID).toBe(0);
  });

  it('неупорядоченный назад-блок ts → CLOCK_INVALID', () => {
    // Откат внутри блока скачет (не backfill, который строго возрастает).
    const result = analyzeTrackIntegrity([
      { ...point(0), seq: 1, ts: TOUCHDOWN },
      { ...point(0), seq: 2, ts: new Date(Date.parse(TOUCHDOWN) - 5_000).toISOString() },
      { ...point(0), seq: 3, ts: new Date(Date.parse(TOUCHDOWN) - 15_000).toISOString() },
      { ...point(0), seq: 4, ts: new Date(Date.parse(TOUCHDOWN) - 10_000).toISOString() },
      { ...point(0), seq: 5, ts: new Date(Date.parse(TOUCHDOWN) + 1_000).toISOString() },
    ]);
    expect(result.ts_inversions).toBeGreaterThan(0);
    expect(result.flags & QUALITY_BITS.CLOCK_INVALID).toBe(QUALITY_BITS.CLOCK_INVALID);
  });

  it('порядок массива не влияет: инверсия ловится по seq, а не по индексу', () => {
    const input = [
      { ...point(0), seq: 3, ts: new Date(Date.parse(TOUCHDOWN) + 2000).toISOString() },
      { ...point(0), seq: 1, ts: new Date(Date.parse(TOUCHDOWN) + 1000).toISOString() },
      { ...point(0), seq: 2, ts: new Date(Date.parse(TOUCHDOWN) - 60_000).toISOString() },
    ];
    const result = analyzeTrackIntegrity(input);
    expect(result.ts_inversions).toBe(1);
    expect(result.flags & QUALITY_BITS.CLOCK_INVALID).toBe(QUALITY_BITS.CLOCK_INVALID);
  });

  it('равный ts при растущем seq — не инверсия (один кадр времени)', () => {
    const result = analyzeTrackIntegrity([
      { ...point(0), seq: 1, ts: TOUCHDOWN },
      { ...point(0), seq: 2, ts: TOUCHDOWN },
    ]);
    expect(result.ts_inversions).toBe(0);
    expect(result.flags).toBe(0);
  });

  it('без seq немонотонность не оценивается (обратная совместимость)', () => {
    const result = analyzeTrackIntegrity([
      point(0, { ts: new Date(Date.parse(TOUCHDOWN) + 1000).toISOString() }),
      point(0, { ts: TOUCHDOWN }),
    ]);
    expect(result.ts_inversions).toBe(0);
    expect(result.flags).toBe(0);
  });

  it('детерминирован', () => {
    const input = [point(0), point(1, { groundspeed_kt: 200 })];
    expect(analyzeTrackIntegrity(input)).toEqual(analyzeTrackIntegrity(input));
  });

  it('детерминирован и при немонотонном ts', () => {
    const input = [
      { ...point(0), seq: 1, ts: new Date(Date.parse(TOUCHDOWN) + 1000).toISOString() },
      { ...point(0), seq: 2, ts: TOUCHDOWN },
    ];
    expect(analyzeTrackIntegrity(input)).toEqual(analyzeTrackIntegrity(input));
  });
});

describe('scoreLanding (детерминированный, без I/O)', () => {
  it('P2: vs_fpm=0 — неизмеренное снижение, а не идеальная посадка', () => {
    const result = scoreLanding({ vs_fpm: 0, g_force: 1.0, bounce_count: 0, bounced: false });
    // Нулевая VS исключена из суммы и перенормировки, а не оценена в 100.
    expect(result.components.vertical_speed).toBeUndefined();
    expect(result.components.g_force).toBe(100);
    expect(result.components.bounce).toBe(100);
  });

  it('P0/P2 data-honesty: null vs_fpm/g_force не дают идеальную посадку (absent != 0 fpm/1.0 g)', () => {
    const result = scoreLanding({ vs_fpm: null, g_force: null, bounce_count: 0, bounced: false });
    // null/0 НЕ подменяются «идеальным» 0 fpm: критерии исключены, вертикальной
    // составляющей в раскладке нет.
    expect(result.components.vertical_speed).toBeUndefined();
    expect(result.components.g_force).toBeUndefined();
    expect(result.components.bounce).toBe(100);
  });

  it('мягкое касание без отскока (golden)', () => {
    expect(scoreLanding({ vs_fpm: -150, g_force: 1.2, bounce_count: 0, bounced: false })).toEqual({
      score: 93,
      grade: 'good',
      components: {
        vertical_speed: 90.63,
        g_force: 90,
        bounce: 100,
      },
      score_version: '1.0.0',
    });
  });

  it('то же, но с двумя отскоками (golden)', () => {
    expect(scoreLanding({ vs_fpm: -150, g_force: 1.2, bounce_count: 2, bounced: true })).toEqual({
      score: 79,
      grade: 'firm',
      components: {
        vertical_speed: 90.63,
        g_force: 90,
        bounce: 40,
      },
      score_version: '1.0.0',
    });
  });

  it('экстремальные значения схлопываются в 0 (golden)', () => {
    expect(scoreLanding({ vs_fpm: -5000, g_force: 3, bounce_count: 5, bounced: true })).toEqual({
      score: 0,
      grade: 'crash',
      components: {
        vertical_speed: 0,
        g_force: 0,
        bounce: 0,
      },
      score_version: '1.0.0',
    });
  });

  it('реалистичный заход со всеми полями (golden)', () => {
    const result = scoreLanding({
      vs_fpm: -312,
      g_force: 1.62,
      pitch_deg: 1.1,
      bank_deg: 2.4,
      bounce_count: 1,
      bounced: true,
      centreline_offset_m: 8,
      touchdown_zone: 'after',
    });
    expect(result).toEqual({
      score: 72,
      grade: 'firm',
      components: {
        vertical_speed: 76.45,
        g_force: 50.4,
        centreline: 81,
        bounce: 70,
        attitude: 82.12,
        touchdown_zone: 70,
      },
      score_version: '1.0.0',
    });
  });

  it('NaN/Infinity дают предсказуемый результат и не падают', () => {
    expect(() =>
      scoreLanding({ vs_fpm: NaN, g_force: Infinity, bounce_count: NaN, bounced: false }),
    ).not.toThrow();

    const result = scoreLanding({
      vs_fpm: NaN,
      g_force: Infinity,
      bounce_count: NaN,
      bounced: false,
    });
    expect(result.score).toBe(0);
    expect(result.grade).toBe('crash');
    expect(result.components.vertical_speed).toBeUndefined();
    expect(result.components.g_force).toBeUndefined();
  });

  it('неизмеренные опциональные критерии не награждают баллами и не штрафуют', () => {
    const result = scoreLanding({ vs_fpm: -100, g_force: 1.0, bounce_count: 0, bounced: false });
    // Остались VS/G/bounce, веса перенормированы (0.35+0.15+0.15).
    expect(result.score).toBe(97);
    expect(result.grade).toBe('butter');
  });

  it('QA-R3-01: null осевой/зоны не даёт 100/100 — критерии исключены и веса перенормированы', () => {
    const nullGeometry = scoreLanding({
      vs_fpm: -200,
      g_force: 1.2,
      pitch_deg: 3,
      bank_deg: 1,
      bounce_count: 0,
      bounced: false,
      centreline_offset_m: null,
      touchdown_zone: null,
    });

    // Критериев просто нет в раскладке — UI покажет «—»/«не измерено».
    expect(nullGeometry.components.centreline).toBeUndefined();
    expect(nullGeometry.components.touchdown_zone).toBeUndefined();
    expect(nullGeometry.score).toBeLessThanOrEqual(100);

    const weights = scoringWeightsForComponents(nullGeometry.components);
    expect(weights.centreline).toBeUndefined();
    expect(weights.touchdown_zone).toBeUndefined();
    expect(Object.values(weights).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 12);

    // Балл = только измеренные критерии с перенормированными весами.
    const measuredPoints = Object.entries(weights).reduce((sum, [criterion, weight]) => {
      const value = nullGeometry.components[criterion]!;
      return sum + value * weight!;
    }, 0);
    expect(nullGeometry.score).toBe(Math.round(measuredPoints));

    // Та же посадка с измеренной осевой/зоной учитывает их — балл другой и
    // «неидеальная» геометрия не может быть лучше неизмеренной по сумме весов.
    const measuredGeometry = scoreLanding({
      vs_fpm: -200,
      g_force: 1.2,
      pitch_deg: 3,
      bank_deg: 1,
      bounce_count: 0,
      bounced: false,
      centreline_offset_m: 15,
      touchdown_zone: 'after',
    });
    expect(measuredGeometry.components.centreline).toBe(60);
    expect(measuredGeometry.components.touchdown_zone).toBe(70);
    // Неидеальная, но измеренная геометрия снижает балл, а не «награждает» его.
    expect(measuredGeometry.score).toBeLessThan(nullGeometry.score);
  });

  it('только измеренная VS: остальные критерии null — балл считается по VS', () => {
    const result = scoreLanding({
      vs_fpm: -100,
      g_force: null,
      pitch_deg: null,
      bank_deg: null,
      bounce_count: Number.NaN,
      bounced: false,
      centreline_offset_m: null,
      touchdown_zone: null,
    });
    expect(result.components).toEqual({ vertical_speed: 95 });
    expect(result.score).toBe(95);
  });

  it('полностью измеренная посадка не меняет балл (bit-identical golden)', () => {
    const result = scoreLanding({
      vs_fpm: -312,
      g_force: 1.62,
      pitch_deg: 1.1,
      bank_deg: 2.4,
      bounce_count: 1,
      bounced: true,
      centreline_offset_m: 8,
      touchdown_zone: 'after',
    });
    expect(result.score).toBe(72);
    expect(result.components).toEqual({
      vertical_speed: 76.45,
      g_force: 50.4,
      centreline: 81,
      bounce: 70,
      attitude: 82.12,
      touchdown_zone: 70,
    });
    // Веса полностью измеренной посадки — исходные (сумма 1).
    const weights = scoringWeightsForComponents(result.components);
    expect(weights.vertical_speed).toBeCloseTo(0.35, 12);
    expect(weights.touchdown_zone).toBeCloseTo(0.1, 12);
    expect(Object.values(weights).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 12);
  });

  it('QA-R3-01: null-геометрия детерминирована', () => {
    const input = {
      vs_fpm: -180,
      g_force: 1.25,
      pitch_deg: 4,
      bank_deg: 0.5,
      bounce_count: 0,
      bounced: false,
      centreline_offset_m: null,
      touchdown_zone: null,
    };
    expect(scoreLanding(input)).toEqual(scoreLanding(input));
  });

  it('положительная vs_fpm — неизмеренная (посадка не получает за VS)', () => {
    const down = scoreLanding({ vs_fpm: -500, g_force: 1.0, bounce_count: 0, bounced: false });
    const up = scoreLanding({ vs_fpm: 500, g_force: 1.0, bounce_count: 0, bounced: false });
    expect(up.components.vertical_speed).toBeUndefined();
    expect(down.components.vertical_speed).toBe(60);
  });

  it('g_force < 1.0 — неизмеренная перегрузка (не оценивается как идеальная 1.0 g)', () => {
    const result = scoreLanding({ vs_fpm: -150, g_force: 0.94, bounce_count: 0, bounced: false });
    expect(result.components.g_force).toBeUndefined();
    expect(result.components.vertical_speed).toBe(90.63);
    expect(result.components.bounce).toBe(100);
  });

  it('пороги и веса переопределяются через opts', () => {
    const result = scoreLanding(
      { vs_fpm: -150, g_force: 1.2, bounce_count: 0, bounced: false },
      { thresholds: { vsSoftFpm: 200 } },
    );
    expect(result.components.vertical_speed).toBe(96.25);
    expect(result.score).toBe(96);
  });

  it('всегда в диапазоне 0..100 и целое', () => {
    const inputs = [
      { vs_fpm: 0, g_force: 1.0, bounce_count: 0, bounced: false },
      { vs_fpm: -100, g_force: 1.1, bounce_count: 0, bounced: false },
      { vs_fpm: -300, g_force: 1.4, bounce_count: 1, bounced: true },
      { vs_fpm: -700, g_force: 1.8, bounce_count: 2, bounced: true },
      { vs_fpm: -2000, g_force: 3, bounce_count: 4, bounced: true },
    ];
    for (const input of inputs) {
      const result = scoreLanding(input);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(Number.isInteger(result.score)).toBe(true);
    }
  });

  it('детерминирован: одинаковый вход даёт одинаковый выход', () => {
    const input = {
      vs_fpm: -312,
      g_force: 1.62,
      pitch_deg: 1.1,
      bank_deg: 2.4,
      bounce_count: 1,
      bounced: true,
      centreline_offset_m: 8,
      touchdown_zone: 'after' as const,
    };
    expect(scoreLanding(input)).toEqual(scoreLanding(input));
  });

  it('экспортирует текущую semver-версию алгоритма', () => {
    expect(SCORE_VERSION).toBe('1.0.0');
    expect(SCORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('hasCredibleClimb', () => {
  it('полётная скорость при agl ≈ 0 (разбег) — не набор высоты', () => {
    expect(hasCredibleClimb({ on_ground: false, groundspeed_kt: 60, agl_ft: 0 })).toBe(false);
    expect(
      hasCredibleClimb({ on_ground: false, groundspeed_kt: 80, agl_ft: 5, vertical_speed_fpm: 0 }),
    ).toBe(false);
  });

  it('подскок ниже порога (15 ft) — не набор высоты', () => {
    expect(
      hasCredibleClimb({ on_ground: false, groundspeed_kt: 70, agl_ft: 15, vertical_speed_fpm: 500 }),
    ).toBe(false);
  });

  it('набор высоты выше порога при движении подтверждает отрыв', () => {
    expect(
      hasCredibleClimb({ on_ground: false, groundspeed_kt: 150, agl_ft: 800, vertical_speed_fpm: 0 }),
    ).toBe(true);
  });

  it('высота без движения и вертикали — не отрыв (bogus airborne)', () => {
    expect(
      hasCredibleClimb({
        on_ground: false,
        groundspeed_kt: 0,
        agl_ft: 5000,
        vertical_speed_fpm: 0,
      }),
    ).toBe(false);
  });

  it('медленное ВС подтверждается вертикальной динамикой', () => {
    expect(
      hasCredibleClimb({ on_ground: false, groundspeed_kt: 20, agl_ft: 40, vertical_speed_fpm: 100 }),
    ).toBe(true);
  });

  it('без AGL — работает прежнее доказательство (полётная скорость)', () => {
    expect(hasCredibleClimb({ on_ground: false, groundspeed_kt: 140, agl_ft: null })).toBe(true);
    expect(hasCredibleClimb({ on_ground: false, groundspeed_kt: 0, agl_ft: null })).toBe(false);
  });

  it('minAglFt=0 отключает требование набора высоты (возврат к hasFlightEvidence)', () => {
    expect(
      hasCredibleClimb({ on_ground: false, groundspeed_kt: 60, agl_ft: 0 }, { minAglFt: 0 }),
    ).toBe(true);
  });
});

describe('hasConfirmedLiftoff', () => {
  const base = Date.parse('2026-09-23T12:00:00.000Z');
  const at = (s: number) => new Date(base + s * 1000).toISOString();

  it('ground-only session has no confirmed liftoff', () => {
    const points = [
      { ts: at(0), on_ground: true, altitude_ft: 36, groundspeed_kt: 0, vertical_speed_fpm: 0 },
      { ts: at(10), on_ground: true, altitude_ft: 36, groundspeed_kt: 3.9, vertical_speed_fpm: 0 },
      { ts: at(60), on_ground: true, altitude_ft: 36, groundspeed_kt: 0, vertical_speed_fpm: 0 },
    ];
    expect(hasConfirmedLiftoff(points)).toBe(false);
  });

  it('flying groundspeed confirms liftoff even without ground altitude', () => {
    const points = [
      { ts: at(0), on_ground: true, groundspeed_kt: 0 },
      { ts: at(2), on_ground: false, groundspeed_kt: 140, vertical_speed_fpm: 900 },
    ];
    expect(hasConfirmedLiftoff(points)).toBe(true);
  });

  it('altitude separation with movement confirms liftoff (slow aircraft)', () => {
    const points = [
      { ts: at(0), on_ground: true, altitude_ft: 100, groundspeed_kt: 10 },
      { ts: at(2), on_ground: false, altitude_ft: 400, groundspeed_kt: 20, vertical_speed_fpm: 100 },
    ];
    expect(hasConfirmedLiftoff(points)).toBe(true);
  });

  it('bogus airborne altitude without movement is not a liftoff', () => {
    const points = [
      { ts: at(0), on_ground: true, altitude_ft: 36, groundspeed_kt: 0 },
      { ts: at(1), on_ground: false, altitude_ft: 5000, groundspeed_kt: 0, vertical_speed_fpm: 0 },
    ];
    expect(hasConfirmedLiftoff(points)).toBe(false);
  });

  it('no altitude and no groundspeed is not enough', () => {
    const points = [{ ts: at(0), on_ground: false, vertical_speed_fpm: 500 }];
    expect(hasConfirmedLiftoff(points)).toBe(false);
  });

  it('подскок на рулении (низкий AGL + всплеск vs) не подтверждает отрыв', () => {
    const points = [
      { ts: at(0), on_ground: true, altitude_ft: 600, groundspeed_kt: 15, vertical_speed_fpm: 0 },
      { ts: at(1), on_ground: false, altitude_ft: 603, groundspeed_kt: 15, vertical_speed_fpm: 320 },
      { ts: at(2), on_ground: true, altitude_ft: 600, groundspeed_kt: 12, vertical_speed_fpm: 0 },
    ];
    expect(hasConfirmedLiftoff(points)).toBe(false);
  });

  it('взлётная пробежка (gs 40–60 kt, agl ≈ 0) не подтверждает отрыв', () => {
    // BUG-QA-1: `ground → on_ground=false, gs 40/60, agl ≈ 0 → ground`. Раньше
    // одной полётной скорости (`hasFlightEvidence`) хватало, чтобы сессия прошла
    // `/complete`; теперь пробежка не набирает `credibleAglFt` → отрыва нет.
    const points = [
      { ts: at(0), on_ground: true, altitude_ft: 36, groundspeed_kt: 0, vertical_speed_fpm: 0 },
      { ts: at(1), on_ground: false, altitude_ft: 37, groundspeed_kt: 40, vertical_speed_fpm: 0 },
      { ts: at(2), on_ground: false, altitude_ft: 40, groundspeed_kt: 60, vertical_speed_fpm: 0 },
      { ts: at(3), on_ground: true, altitude_ft: 36, groundspeed_kt: 70, vertical_speed_fpm: 0 },
    ];
    expect(hasConfirmedLiftoff(points)).toBe(false);
  });

  it('slew-only воздушные точки (value-биты) не подтверждают отрыв', () => {
    const points = [
      { ts: at(0), on_ground: true, altitude_ft: 36, groundspeed_kt: 0, quality: 0 },
      {
        ts: at(1),
        on_ground: false,
        altitude_ft: 5000,
        groundspeed_kt: 140,
        vertical_speed_fpm: 900,
        quality: QUALITY_BITS.SLEW,
      },
    ];
    expect(hasConfirmedLiftoff(points)).toBe(false);
  });

  it('одна чистая воздушная точка среди slew-точек подтверждает отрыв', () => {
    const points = [
      { ts: at(0), on_ground: true, altitude_ft: 36, groundspeed_kt: 0, quality: 0 },
      {
        ts: at(1),
        on_ground: false,
        altitude_ft: 5000,
        groundspeed_kt: 140,
        vertical_speed_fpm: 900,
        quality: QUALITY_BITS.SLEW,
      },
      {
        ts: at(2),
        on_ground: false,
        altitude_ft: 5100,
        groundspeed_kt: 140,
        vertical_speed_fpm: 900,
        quality: 0,
      },
    ];
    expect(hasConfirmedLiftoff(points)).toBe(true);
  });
});
