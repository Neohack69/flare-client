import { z } from 'zod';
import { handleSchema } from './handle.js';
import { semverSchema, utcDateTimeSchema } from './primitives.js';

/**
 * Геймификация — прогресс пилота (T111, docs/design/gamification.md §7.3).
 * Схемы аддитивны; XP/SS считает только сервер (`apps/api`). `packages/scoring`
 * геймификацией не расширяется (листовой детерминированный пакет).
 */

/** Дискретные ступени (gamification.md §2.1): Курсант → Инструктор. */
export const pilotRankCodeSchema = z.enum([
  'cadet',
  'second_officer',
  'first_officer',
  'captain',
  'instructor',
]);
export type PilotRankCode = z.output<typeof pilotRankCodeSchema>;

export const pilotRankSchema = z
  .object({
    rank_id: z.number().int().min(1).max(5),
    code: pilotRankCodeSchema,
    name_ru: z.string().min(1),
    name_en: z.string().min(1),
    xp_threshold: z.number().int().nonnegative(),
  })
  .strict();
export type PilotRank = z.output<typeof pilotRankSchema>;

/** Полоса Safety Score (§3.3). `null` — данных меньше минимума, не 0. */
export const safetyBandSchema = z.enum(['reliable', 'confident', 'needs_attention', 'high_risk']);
export type SafetyBand = z.output<typeof safetyBandSchema>;

/**
 * Группа ачивки — для сетки на карте (ADR-0019 §5/§6): три коллекции
 * (страны/часы/дистанция) плюс исторические группы геймификации.
 */
export const achievementGroupSchema = z.enum([
  'landings',
  'streak',
  'rank',
  'countries',
  'hours',
  'distance',
]);
export type AchievementGroup = z.output<typeof achievementGroupSchema>;

/** Метрика, по которой считается прогресс (mirror `AchievementMetrics`). */
export const achievementMetricSchema = z.enum([
  'landings',
  'eligible_landings',
  'butter_count',
  'streak_best',
  'rank_id',
  'country_count',
  'airborne_hours',
  'distance_nm',
]);
export type AchievementMetric = z.output<typeof achievementMetricSchema>;

/**
 * Ачивка каталога с прогрессом (ADR-0019 §4.2). `progress` — доля 0..1;
 * `target` — порог метрики, `group` — коллекция для сетки на `/map`.
 * `celebrated_at` — T170: когда показали поздравительную модалку; `null` у
 * открытой ачивки → кандидат в очередь celebration.
 */
export const achievementProgressSchema = z
  .object({
    id: z.string().min(1),
    title_ru: z.string().min(1),
    title_en: z.string().min(1),
    group: achievementGroupSchema,
    metric: achievementMetricSchema,
    target: z.number().nonnegative(),
    progress: z.number().min(0).max(1),
    unlocked: z.boolean(),
    unlocked_at: utcDateTimeSchema.nullable(),
    celebrated_at: utcDateTimeSchema.nullable(),
  })
  .strict();
export type AchievementProgress = z.output<typeof achievementProgressSchema>;

/**
 * `POST /v1/me/achievements/celebrate` (T170): ack показа поздравления.
 * Обычно один id; batch — на будущее «skip all». Max = размер каталога (~22).
 */
export const celebrateAchievementsRequestSchema = z
  .object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(32),
  })
  .strict();
export type CelebrateAchievementsRequest = z.output<typeof celebrateAchievementsRequestSchema>;

export const celebrateAchievementsResponseSchema = z
  .object({
    data: z
      .object({
        celebrated: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();
export type CelebrateAchievementsResponse = z.output<typeof celebrateAchievementsResponseSchema>;

/**
 * `GET /v1/me/achievements` (ADR-0019 §4.2): весь каталог с прогрессом + ближайшие
 * к открытию. `near` — top-3 среди закрытых по убыванию прогресса (тот же
 * `nextLockedAchievements`, что и `next_badges`). Пустой аккаунт → `200` c
 * прогрессом 0 у всех ступеней (baseline 0).
 */
export const achievementsResponseSchema = z
  .object({
    data: z.array(achievementProgressSchema),
    near: z.array(achievementProgressSchema),
    meta: z.object({ progression_version: semverSchema }).strict(),
  })
  .strict();
export type AchievementsResponse = z.output<typeof achievementsResponseSchema>;

/** `GET /v1/me/progress` (gamification.md §7.3). */
export const pilotProgressSchema = z
  .object({
    xp_total: z.number().int().nonnegative(),
    /** Денормализованный `rank_id` (1..5); синоним `rank_id` для UI. */
    level: z.number().int().min(1).max(5),
    rank_id: z.number().int().min(1).max(5),
    rank_code: pilotRankCodeSchema,
    xp_in_level: z.number().int().nonnegative(),
    /** `null` на максимальной ступени (далее — престиж-звёзды). */
    xp_to_next: z.number().int().nonnegative().nullable(),
    prestige_stars: z.number().int().nonnegative(),
    safety_score: z.number().int().min(0).max(100).nullable(),
    safety_band: safetyBandSchema.nullable(),
    safety_samples: z.number().int().nonnegative(),
    streak_current: z.number().int().nonnegative(),
    streak_best: z.number().int().nonnegative(),
    xp_since_last_visit: z.number().int().nonnegative(),
    /**
     * Достигнут ли дневной кап XP (`DAILY_XP_CAP`, gamification.md §2.4(6)).
     * UI показывает честную подпись «Дневной лимит прогресса достигнут» и
     * `XPBar` в состоянии `capped` — никогда «0 XP». Дефолт `false` — старый
     * API без поля не ломает клиент.
     */
    xp_daily_capped: z.boolean().default(false),
    next_badges: z.array(achievementProgressSchema),
    progression_version: semverSchema,
    safety_version: semverSchema,
  })
  .strict();
export type PilotProgress = z.output<typeof pilotProgressSchema>;

/** Окно истории Safety по умолчанию (дней) — последние снимки `safety_snapshots`. */
export const SAFETY_HISTORY_DEFAULT_DAYS = 180;
/** Жёсткий кап окна истории: сервер обрезает `from` до `to - N` дней. */
export const SAFETY_HISTORY_MAX_DAYS = 365;
/** Лимит точек по умолчанию/максимум (кап размера ответа). */
export const SAFETY_HISTORY_DEFAULT_LIMIT = 180;
export const SAFETY_HISTORY_MAX_LIMIT = 365;

/**
 * Одна точка истории Safety Score (P1-1, gamification.md §3.2/§5.5/§7.1) —
 * снимок `safety_snapshots` на момент финализации рейса. `ss` — Safety Score
 * окна (0..100), `samples` — размер окна (всегда ≥ `SAFETY_MIN_SAMPLES`),
 * `computed_at` — время **рейса** (`COALESCE(ended_at, started_at)`, UTC), а не
 * момент расчёта снимка: бэкфилл пишет пачку снимков одним `computed_at`.
 * `safety_version` — версия правил.
 */
export const safetyHistoryPointSchema = z
  .object({
    ss: z.number().int().min(0).max(100),
    samples: z.number().int().nonnegative(),
    computed_at: utcDateTimeSchema,
    safety_version: semverSchema,
  })
  .strict();
export type SafetyHistoryPoint = z.output<typeof safetyHistoryPointSchema>;

/**
 * Сравнение двух UTC-инстантов по времени, а не по строке: `Z` и `+00:00`
 * обозначают один и тот же момент, но лексикографически `Z` > `+`. Отсутствие
 * или невалидная дата (схема уже отвергает её отдельно) — не нарушение порядка.
 */
function instantLte(from: string | undefined, to: string | undefined): boolean {
  if (from === undefined || to === undefined) return true;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return true;
  return fromMs <= toMs;
}

/**
 * Query `GET /v1/me/safety-history`: `from`/`to` — границы окна (UTC ISO,
 * необязательны; дефолт — последние `SAFETY_HISTORY_DEFAULT_DAYS` дней),
 * `limit` — кап числа точек. Сервер дополнительно зажимает окно в
 * `SAFETY_HISTORY_MAX_DAYS`; пустой/недостаточный набор снимков — валидный
 * `200` с `data: []`, а не ошибка.
 */
export const safetyHistoryQuerySchema = z
  .object({
    from: utcDateTimeSchema.optional(),
    to: utcDateTimeSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SAFETY_HISTORY_MAX_LIMIT)
      .optional()
      .default(SAFETY_HISTORY_DEFAULT_LIMIT),
  })
  .strict()
  .refine((value) => instantLte(value.from, value.to), {
    message: 'from must be <= to',
  });
export type SafetyHistoryQuery = z.output<typeof safetyHistoryQuerySchema>;

/**
 * `GET /v1/me/safety-history` (приватный, scope `web`, только свои данные):
 * точки в хронологическом порядке (от старых к новым). `meta.min_samples` —
 * честный порог показа (`SAFETY_MIN_SAMPLES`), чтобы UI не хардкодил 5.
 */
export const safetyHistoryResponseSchema = z
  .object({
    data: z.array(safetyHistoryPointSchema),
    meta: z
      .object({
        from: utcDateTimeSchema,
        to: utcDateTimeSchema,
        limit: z.number().int().positive(),
        min_samples: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type SafetyHistoryResponse = z.output<typeof safetyHistoryResponseSchema>;

/**
 * `users.profile_visibility` (gamification.md §5.3/§7.1) — что показывает
 * публичный debrief. Дефолты: уровень — да (`true`), Safety/имя — нет.
 * Публично XP/Safety/серия не показываются никогда; имя анонимно.
 *
 * `show_live` — независимая ось (`docs/architecture/friends-live.md` §3.2):
 * видимость live-рейса приёмо-друзьям, на публичный debrief не влияет. Ключа
 * нет в jsonb → дефолт на чтении `FRIENDS_LIVE_SHOW_LIVE_DEFAULT` (`true`,
 * opt-out). Аддитивно: старые клиенты, которые не знают ключ, ломаются только
 * если парсят строго без него — поэтому читающий API обязан его отдавать.
 */
export const profileVisibilitySchema = z
  .object({
    show_level: z.boolean(),
    show_safety: z.boolean(),
    show_name: z.boolean(),
    show_live: z.boolean(),
  })
  .strict();
export type ProfileVisibility = z.output<typeof profileVisibilitySchema>;

/**
 * Тело `PATCH /v1/me/profile-visibility`: частичное обновление, сервер мерджит
 * с текущим jsonb (без mass-assignment). Пустое тело и неизвестные поля → 422.
 *
 * `show_live` — независимая ось (`docs/architecture/friends-live.md` §3.2):
 * управляет видимостью live-рейса приёмо-друзьям. На публичный debrief не влияет.
 * Дефолт (ключа нет) задаётся на чтении — `FRIENDS_LIVE_SHOW_LIVE_DEFAULT`.
 */
export const profileVisibilityUpdateSchema = z
  .object({
    show_level: z.boolean().optional(),
    show_safety: z.boolean().optional(),
    show_name: z.boolean().optional(),
    show_live: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one of show_level, show_safety, show_name, show_live must be provided',
  });
export type ProfileVisibilityUpdate = z.output<typeof profileVisibilityUpdateSchema>;

/**
 * `LevelBadge` для публичного debrief (§5.3): анонимно — без XP/SS/имени.
 * Присутствует только при `users.profile_visibility.show_level = true`.
 */
export const levelBadgeSchema = z
  .object({
    rank_id: z.number().int().min(1).max(5),
    rank_code: pilotRankCodeSchema,
    label_ru: z.string().min(1),
    label_en: z.string().min(1),
  })
  .strict();
export type LevelBadge = z.output<typeof levelBadgeSchema>;

/**
 * Лидерборды (§5.4): уровень в строке, без Safety Score.
 * `overall` — общий зачёт без разреза (ключ не передаётся).
 */
export const leaderboardScopeSchema = z.enum(['overall', 'aircraft', 'airport']);
export type LeaderboardScope = z.output<typeof leaderboardScopeSchema>;

export const leaderboardPeriodSchema = z.enum(['month', 'all']);
export type LeaderboardPeriod = z.output<typeof leaderboardPeriodSchema>;

export const leaderboardEntrySchema = z
  .object({
    position: z.number().int().positive(),
    display_name: z.string(),
    /**
     * Уникальный `@handle` для поиска и друзей. В лидерборде показывается
     * `display_name`. `null` — у старого аккаунта тег ещё не задан.
     */
    handle: handleSchema.nullable(),
    /**
     * L1: готовая подпись для показа — `display_name` в режиме `name`, иначе
     * `@handle`, а без тега `pilot-xxxxxx` (первые 6 символов id). UI
     * лидерборда показывает только это поле, чтобы имя не утекало в `tag`.
     */
    pilot_label: z.string().min(1),
    level: z.number().int().min(1).max(5),
    rank_code: pilotRankCodeSchema,
    best_score: z.number().int().min(0).max(100),
    avg_score: z.number().min(0).max(100).nullable(),
    flights: z.number().int().nonnegative(),
    is_me: z.boolean(),
  })
  .strict();
export type LeaderboardEntry = z.output<typeof leaderboardEntrySchema>;

export const leaderboardsMetaSchema = z
  .object({
    scope: leaderboardScopeSchema,
    /** Пустая строка для `scope=overall` — разреза нет. */
    key: z.string().max(4),
    period: leaderboardPeriodSchema,
    limit: z.number().int().positive(),
  })
  .strict();

export const leaderboardsResponseSchema = z
  .object({
    data: z.array(leaderboardEntrySchema),
    meta: leaderboardsMetaSchema,
  })
  .strict();
export type LeaderboardsResponse = z.output<typeof leaderboardsResponseSchema>;

/**
 * Activity heatmap (`docs/design/activity-heatmap.md` §8): агрегаты по
 * **локальным** дням пилота (`users.timezone`, `NULL → UTC`). Отдельный флоу от
 * лидербордов/leaderboard-eligibility: «день с рейсом» = `flights.started_at`.
 */

/** Локальная календарная дата `YYYY-MM-DD` (день в поясе пилота, не UTC-инстант). */
export const localDateKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a local calendar date (YYYY-MM-DD)')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'must be a real calendar date');
export type LocalDateKey = z.output<typeof localDateKeySchema>;

/** Окно по умолчанию (дней): ~12 месяцев; первый день — понедельник ≤ `сегодня − 364`. */
export const ACTIVITY_DEFAULT_WINDOW_DAYS = 364;
/** Жёсткий кап окна включительно (§8 п.6: окно ≤ 366 дней). */
export const ACTIVITY_MAX_WINDOW_DAYS = 366;
/** Версия правил агрегата `GET /v1/me/activity` (история не переписывается молча). */
export const ACTIVITY_VERSION = 'activity@1.0.0';

/**
 * Один активный день (только дни, где есть хотя бы рейс или посадка; пустые
 * клетки клиент достраивает по календарю сам — §8 п.10).
 *
 * - `flights` — рейсы с `started_at` в этом локальном дне; `failed` не считаем,
 *   `in_progress` считаем (§8 п.2).
 * - `landings` — касания по `touchdown_at` в том же локальном дне (§8 п.3).
 * - `avg_score` — среднее по зачётным серверным баллам (`eligible ∧ verified`);
 *   `null`, если баллов нет (`no_score` не подставляем нулём, §8 п.4).
 * - `avg_score_samples` — знаменатель (честные `—`/`partial`).
 * - `partial` — в дне есть `is_partial`/`verified=false` (§8 п.5).
 */
export const activityDaySchema = z
  .object({
    date: localDateKeySchema,
    flights: z.number().int().nonnegative(),
    landings: z.number().int().nonnegative(),
    avg_score: z.number().min(0).max(100).nullable(),
    avg_score_samples: z.number().int().nonnegative(),
    partial: z.boolean(),
  })
  .strict();
export type ActivityDay = z.output<typeof activityDaySchema>;

/** День-рекорд в окне (`max(flights)`, tie-break — ранняя дата). */
export const activityBestDaySchema = z
  .object({
    date: localDateKeySchema,
    flights: z.number().int().positive(),
  })
  .strict();
export type ActivityBestDay = z.output<typeof activityBestDaySchema>;

/** `totals` ответа: сводка за окно; пустой аккаунт → нули + `best_day: null`. */
export const activityTotalsSchema = z
  .object({
    active_days: z.number().int().nonnegative(),
    flights: z.number().int().nonnegative(),
    landings: z.number().int().nonnegative(),
    best_day: activityBestDaySchema.nullable(),
  })
  .strict();
export type ActivityTotals = z.output<typeof activityTotalsSchema>;

/**
 * Query `GET /v1/me/activity`: `from`/`to` — локальные даты (`YYYY-MM-DD`,
 * включительно). Без параметров — последние 12 месяцев по локальный «сегодня».
 * Сервер зажимает окно в `ACTIVITY_MAX_WINDOW_DAYS`. `from > to` → 422.
 */
export const activityQuerySchema = z
  .object({
    from: localDateKeySchema.optional(),
    to: localDateKeySchema.optional(),
  })
  .strict()
  .refine((value) => value.from === undefined || value.to === undefined || value.from <= value.to, {
    message: 'from must be <= to',
  });
export type ActivityQuery = z.output<typeof activityQuerySchema>;

/**
 * `GET /v1/me/activity` (приватно, scope `web`, только свои данные) — форма ответа
 * 1:1 по `activity-heatmap.md` §8: `tz` (использованный пояс, fallback `UTC`),
 * `from`/`to` (включительно, локальные даты), `days` — активные дни (от старых к
 * новым), `totals` — сводка, `version` — версия правил агрегата. Пустой аккаунт →
 * `200` с `days: []` и нулевыми `totals` (не 404/не ошибка).
 */
export const activityResponseSchema = z
  .object({
    tz: z.string().min(1).max(64),
    from: localDateKeySchema,
    to: localDateKeySchema,
    days: z.array(activityDaySchema),
    totals: activityTotalsSchema,
    version: z.string().min(1).max(32),
  })
  .strict();
export type ActivityResponse = z.output<typeof activityResponseSchema>;
