import { describe, expect, it } from 'vitest';

import {
  achievementProgressSchema,
  achievementsResponseSchema,
  activityDaySchema,
  activityQuerySchema,
  activityResponseSchema,
  levelBadgeSchema,
  leaderboardEntrySchema,
  leaderboardsResponseSchema,
  pilotProgressSchema,
  pilotRankSchema,
  profileVisibilitySchema,
  profileVisibilityUpdateSchema,
  safetyHistoryPointSchema,
  safetyHistoryQuerySchema,
  safetyHistoryResponseSchema,
} from './gamification.js';
import { publicLandingSummarySchema, publicFlightSchema } from './sharing.js';

const NOW = '2026-09-25T12:00:00.000Z';
const UUID = '123e4567-e89b-42d3-a456-426614174000';

describe('contracts — gamification (T111)', () => {
  it('pilotRankSchema валидирует ступени и пороги', () => {
    expect(
      pilotRankSchema.safeParse({
        rank_id: 4,
        code: 'captain',
        name_ru: 'Капитан',
        name_en: 'Captain',
        xp_threshold: 12000,
      }).success,
    ).toBe(true);
    expect(
      pilotRankSchema.safeParse({
        rank_id: 6,
        code: 'captain',
        name_ru: 'X',
        name_en: 'X',
        xp_threshold: 0,
      }).success,
    ).toBe(false);
    expect(
      pilotRankSchema.safeParse({
        rank_id: 1,
        code: 'spaceship',
        name_ru: 'X',
        name_en: 'X',
        xp_threshold: 0,
      }).success,
    ).toBe(false);
  });

  it('pilotProgressSchema: полные данные и nullable safety', () => {
    const progress = {
      xp_total: 8340,
      level: 3,
      rank_id: 3,
      rank_code: 'first_officer',
      xp_in_level: 4340,
      xp_to_next: 3660,
      prestige_stars: 0,
      safety_score: null,
      safety_band: null,
      safety_samples: 3,
      streak_current: 4,
      streak_best: 12,
      xp_since_last_visit: 340,
      next_badges: [
        {
          id: 'ten_landings',
          title_ru: 'Десять посадок',
          title_en: 'Ten landings',
          group: 'landings',
          metric: 'eligible_landings',
          target: 10,
          progress: 0.4,
          unlocked: false,
          unlocked_at: null,
          celebrated_at: null,
        },
      ],
      progression_version: '1.0.0',
      safety_version: '1.0.0',
    };
    expect(pilotProgressSchema.safeParse(progress).success).toBe(true);
    expect(achievementProgressSchema.safeParse(progress.next_badges[0]).success).toBe(true);
    expect(pilotProgressSchema.safeParse({ ...progress, extra: 1 }).success).toBe(false);
  });

  it('pilotProgressSchema: xp_daily_capped дефолт false (аддитивно) и валиден явно', () => {
    const base = {
      xp_total: 0,
      level: 1,
      rank_id: 1,
      rank_code: 'cadet',
      xp_in_level: 0,
      xp_to_next: 1000,
      prestige_stars: 0,
      safety_score: null,
      safety_band: null,
      safety_samples: 0,
      streak_current: 0,
      streak_best: 0,
      xp_since_last_visit: 0,
      next_badges: [],
      progression_version: '1.0.0',
      safety_version: '1.0.0',
    };
    const withoutField = pilotProgressSchema.safeParse(base);
    expect(withoutField.success).toBe(true);
    if (withoutField.success) expect(withoutField.data.xp_daily_capped).toBe(false);

    const explicit = pilotProgressSchema.safeParse({ ...base, xp_daily_capped: true });
    expect(explicit.success).toBe(true);
    if (explicit.success) expect(explicit.data.xp_daily_capped).toBe(true);

    expect(pilotProgressSchema.safeParse({ ...base, xp_daily_capped: 'yes' }).success).toBe(false);
  });

  it('profileVisibilitySchema: полный объект (с show_live) и строгость', () => {
    expect(
      profileVisibilitySchema.safeParse({
        show_level: true,
        show_safety: false,
        show_name: false,
        show_live: true,
      }).success,
    ).toBe(true);
    // show_live обязателен на чтении (аддитивное поле — API отдаёт его всегда).
    expect(
      profileVisibilitySchema.safeParse({ show_level: true, show_safety: false, show_name: false })
        .success,
    ).toBe(false);
    expect(
      profileVisibilitySchema.safeParse({
        show_level: true,
        show_safety: false,
        show_name: false,
        show_live: false,
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it('profileVisibilityUpdateSchema: частичный патч, пустое тело и чужие поля → ошибка', () => {
    expect(profileVisibilityUpdateSchema.safeParse({ show_level: false }).success).toBe(true);
    expect(
      profileVisibilityUpdateSchema.safeParse({ show_level: false, show_safety: true }).success,
    ).toBe(true);
    expect(profileVisibilityUpdateSchema.safeParse({}).success).toBe(false);
    expect(profileVisibilityUpdateSchema.safeParse({ show_name: false, display_name: 'X' }).success).toBe(
      false,
    );
    expect(profileVisibilityUpdateSchema.safeParse({ show_level: 'no' }).success).toBe(false);
  });

  it('pilotProgressSchema отклоняет safety_score вне 0..100', () => {
    const base = {
      level: 1,
      rank_id: 1,
      rank_code: 'cadet',
      xp_in_level: 0,
      xp_to_next: 1000,
      prestige_stars: 0,
      safety_score: 120,
      safety_band: 'reliable',
      safety_samples: 5,
      streak_current: 0,
      streak_best: 0,
      xp_since_last_visit: 0,
      next_badges: [],
      progression_version: '1.0.0',
      safety_version: '1.0.0',
    };
    expect(pilotProgressSchema.safeParse(base).success).toBe(false);
  });

  it('levelBadgeSchema анонимен (rank + labels)', () => {
    expect(
      levelBadgeSchema.safeParse({
        rank_id: 4,
        rank_code: 'captain',
        label_ru: 'Капитан',
        label_en: 'Captain',
      }).success,
    ).toBe(true);
    expect(
      levelBadgeSchema.safeParse({ rank_id: 4, rank_code: 'captain', label_ru: 'X' }).success,
    ).toBe(false);
  });

  it('achievementsResponseSchema: весь каталог + ближайшие, пустой аккаунт валиден', () => {
    const item = {
      id: 'countries_1',
      title_ru: 'Первая страна',
      title_en: 'First country',
      group: 'countries',
      metric: 'country_count',
      target: 1,
      progress: 0,
      unlocked: false,
      unlocked_at: null,
      celebrated_at: null,
    };
    expect(
      achievementsResponseSchema.safeParse({
        data: [],
        near: [],
        meta: { progression_version: '1.0.0' },
      }).success,
    ).toBe(true);
    expect(
      achievementsResponseSchema.safeParse({
        data: [item],
        near: [item],
        meta: { progression_version: '1.0.0' },
      }).success,
    ).toBe(true);
    expect(
      achievementsResponseSchema.safeParse({
        data: [item],
        near: [item],
        meta: { progression_version: '1.0.0', extra: 1 },
      }).success,
    ).toBe(false);
  });

  it('leaderboardsResponseSchema валиден', () => {
    const response = {
      data: [
        {
          position: 1,
          display_name: 'Pilot',
          handle: 'neohack',
          pilot_label: 'neohack',
          level: 4,
          rank_code: 'captain',
          best_score: 98,
          avg_score: 91.5,
          flights: 12,
          is_me: false,
        },
      ],
      meta: { scope: 'aircraft', key: 'B738', period: 'month', limit: 50 },
    };
    expect(leaderboardsResponseSchema.safeParse(response).success).toBe(true);
    expect(leaderboardEntrySchema.safeParse(response.data[0]).success).toBe(true);
    expect(leaderboardEntrySchema.safeParse({ ...response.data[0], handle: null }).success).toBe(
      true,
    );
    expect(leaderboardsResponseSchema.safeParse({ data: [], extra: 1 }).success).toBe(false);
    expect(
      leaderboardsResponseSchema.safeParse({
        ...response,
        meta: { scope: 'overall', key: '', period: 'all', limit: 50 },
      }).success,
    ).toBe(true);
  });

  it('share-схемы: level_badge аддитивен, xp_awarded не публикуется', () => {
    const flight = publicFlightSchema.parse({
      id: UUID,
      aircraft_icao: 'B738',
      aircraft: null,
      callsign: null,
      origin_icao: null,
      destination_icao: null,
      status: 'completed',
      started_at: NOW,
      ended_at: NOW,
      duration_s: 60,
      distance_m: 1000,
      max_altitude_ft: 2000,
      touchdown_at: NOW,
      score: null,
      quality: { is_partial: false, leaderboard_eligible: true, quality_flags: 0 },
    });
    expect(flight.level_badge).toBeNull();
    expect(
      publicFlightSchema.safeParse({
        ...flight,
        level_badge: {
          rank_id: 4,
          rank_code: 'captain',
          label_ru: 'Капитан',
          label_en: 'Captain',
        },
      }).success,
    ).toBe(true);

    // Публичная посадка санитизирована: `xp_awarded` (и внутренние поля) отсутствуют.
    expect(
      publicLandingSummarySchema.safeParse({
        seq: 1,
        touchdown_at: NOW,
        touch_and_go: false,
        ground_contact_s: null,
        metrics: { vs_fpm: -120, g_force: 1.2 },
        score: 90,
        grade: 'good',
        components: { vertical_speed: 90 },
        score_version: '1.0.0',
        segmentation_version: '1.0.0',
        confidence: 1,
        eligible: true,
        xp_awarded: 104,
      }).success,
    ).toBe(false);
  });
});

describe('contracts — история Safety (P1-1)', () => {
  const point = { ss: 82, samples: 12, computed_at: NOW, safety_version: '1.0.0' };

  it('safetyHistoryResponseSchema: точки + meta.min_samples; пустой набор валиден', () => {
    expect(safetyHistoryPointSchema.safeParse(point).success).toBe(true);
    expect(safetyHistoryPointSchema.safeParse({ ...point, ss: 101 }).success).toBe(false);
    expect(safetyHistoryPointSchema.safeParse({ ...point, samples: -1 }).success).toBe(false);
    expect(safetyHistoryPointSchema.safeParse({ ...point, extra: 1 }).success).toBe(false);

    expect(
      safetyHistoryResponseSchema.safeParse({
        data: [point],
        meta: { from: NOW, to: NOW, limit: 180, min_samples: 5 },
      }).success,
    ).toBe(true);
    expect(
      safetyHistoryResponseSchema.safeParse({
        data: [],
        meta: { from: NOW, to: NOW, limit: 180, min_samples: 5 },
      }).success,
    ).toBe(true);
    expect(
      safetyHistoryResponseSchema.safeParse({
        data: [point],
        meta: { from: NOW, to: NOW, limit: 180, min_samples: 5, extra: 1 },
      }).success,
    ).toBe(false);
  });

  it('safetyHistoryQuerySchema: limit коэрцится, есть дефолт, from<=to, чужие поля — ошибка', () => {
    const parsed = safetyHistoryQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.limit).toBe(180);

    const coerced = safetyHistoryQuerySchema.safeParse({ limit: '42' });
    expect(coerced.success).toBe(true);
    if (coerced.success) expect(coerced.data.limit).toBe(42);

    expect(safetyHistoryQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(safetyHistoryQuerySchema.safeParse({ limit: 5000 }).success).toBe(false);
    expect(
      safetyHistoryQuerySchema.safeParse({
        from: '2026-02-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(safetyHistoryQuerySchema.safeParse({ page: 1 }).success).toBe(false);
  });

  it('safetyHistoryQuerySchema: from<=to сравнивает инстанты, а не строки (`Z` vs `+00:00`)', () => {
    // Один и тот же момент, разный формат offset: `Z` лексикографически больше `+`.
    expect(
      safetyHistoryQuerySchema.safeParse({
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000+00:00',
      }).success,
    ).toBe(true);
    expect(
      safetyHistoryQuerySchema.safeParse({
        from: '2026-01-01T00:00:00.000+00:00',
        to: '2026-01-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      safetyHistoryQuerySchema.safeParse({
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
    // Действительно инвертированное окно всё равно отвергается.
    expect(
      safetyHistoryQuerySchema.safeParse({
        from: '2026-02-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000+00:00',
      }).success,
    ).toBe(false);
  });
});

describe('contracts — activity heatmap (T-AH)', () => {
  const day = {
    date: '2026-10-12',
    flights: 2,
    landings: 3,
    avg_score: 87.5,
    avg_score_samples: 3,
    partial: false,
  };

  it('activityDaySchema: валидный день, nullable avg_score, strict', () => {
    expect(activityDaySchema.safeParse(day).success).toBe(true);
    expect(activityDaySchema.safeParse({ ...day, avg_score: null, avg_score_samples: 0 }).success).toBe(
      true,
    );
    expect(activityDaySchema.safeParse({ ...day, avg_score: 101 }).success).toBe(false);
    expect(activityDaySchema.safeParse({ ...day, flights: -1 }).success).toBe(false);
    expect(activityDaySchema.safeParse({ ...day, extra: 1 }).success).toBe(false);
    expect(activityDaySchema.safeParse({ ...day, date: '2026-13-01' }).success).toBe(false);
    expect(activityDaySchema.safeParse({ ...day, date: '2026-02-30' }).success).toBe(false);
    expect(activityDaySchema.safeParse({ ...day, date: '12.10.2026' }).success).toBe(false);
  });

  it('activityQuerySchema: пустой окно-дефолт, локальные даты, from<=to', () => {
    expect(activityQuerySchema.safeParse({}).success).toBe(true);
    expect(activityQuerySchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success).toBe(
      true,
    );
    expect(activityQuerySchema.safeParse({ from: '2026-12-31', to: '2026-01-01' }).success).toBe(
      false,
    );
    expect(activityQuerySchema.safeParse({ from: '2026-01-01T00:00:00Z' }).success).toBe(false);
    expect(activityQuerySchema.safeParse({ page: 1 }).success).toBe(false);
  });

  it('activityResponseSchema: дни + totals + tz/version; пустой аккаунт валиден', () => {
    const response = {
      tz: 'Europe/Moscow',
      from: '2025-10-14',
      to: '2026-10-13',
      days: [day],
      totals: {
        active_days: 128,
        flights: 342,
        landings: 410,
        best_day: { date: '2026-06-02', flights: 4 },
      },
      version: 'activity@1.0.0',
    };
    expect(activityResponseSchema.safeParse(response).success).toBe(true);

    expect(
      activityResponseSchema.safeParse({
        tz: 'UTC',
        from: '2026-10-01',
        to: '2026-10-13',
        days: [],
        totals: { active_days: 0, flights: 0, landings: 0, best_day: null },
        version: 'activity@1.0.0',
      }).success,
    ).toBe(true);

    expect(activityResponseSchema.safeParse({ ...response, extra: 1 }).success).toBe(false);
    expect(activityResponseSchema.safeParse({ ...response, tz: undefined }).success).toBe(false);
  });
});
