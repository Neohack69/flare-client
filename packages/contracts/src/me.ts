import { z } from 'zod';
import { planCodeSchema } from './billing.js';
import { handleSchema, userRoleSchema } from './handle.js';
import { displayNameSchema, emailSchema, utcDateTimeSchema, uuidSchema } from './primitives.js';

/**
 * Активный Pro-триал (owner: 3 дня, 10 AI-отчётов всего). Поле аддитивное и
 * опциональное: старые клиенты его не видят, новый UI показывает чип/CTA.
 * После истечения trial поле отсутствует — `/me` отдаёт обычный Free.
 */
export const mePlanTrialSchema = z
  .object({
    active: z.boolean(),
    ends_at: utcDateTimeSchema,
    days_left: z.number().int().nonnegative(),
    ai_reports_remaining: z.number().int().nonnegative(),
  })
  .strict();
export type MePlanTrial = z.output<typeof mePlanTrialSchema>;

/**
 * Профиль и лимиты текущего пользователя (GET /v1/me, T41).
 * `null` в лимите — «без ограничения».
 *
 * `includes_ai` — доступ к AI входит в тариф (T145/BUG-AI-02): отдельный флаг,
 * не выводится из `ai_reports_per_month` (последний — только квота).
 */
export const mePlanSchema = z
  .object({
    code: planCodeSchema,
    name: z.string().min(1),
    includes_ai: z.boolean(),
    ai_reports_per_month: z.number().int().nonnegative().nullable(),
    history_days: z.number().int().nonnegative().nullable(),
    max_flights: z.number().int().nonnegative().nullable(),
    /** Лимит устройств тарифа (ADR-0018 §8.2); `null` — безлимит. */
    max_devices: z.number().int().nonnegative().nullable(),
    /** Активный trial; отсутствует у обычных тарифов и после истечения. */
    trial: mePlanTrialSchema.optional(),
  })
  .strict();
export type MePlan = z.output<typeof mePlanSchema>;

/**
 * GET /v1/agent/me (iter77): минимальный снимок тарифа для desktop-клиента.
 * Agent-scope token не имеет доступа к `/v1/me`, поэтому окно клиента берёт
 * только то, что нужно скину: код, имя и (опционально) активный trial.
 * Контракт аддитивный: новые поля можно добавлять, старые клиенты их игнорируют.
 */
export const agentMePlanSchema = z
  .object({
    code: planCodeSchema,
    name: z.string().min(1),
    trial: mePlanTrialSchema.optional(),
  })
  .strict();
export type AgentMePlan = z.output<typeof agentMePlanSchema>;

export const agentMeSchema = z.object({ plan: agentMePlanSchema }).strict();
export type AgentMe = z.output<typeof agentMeSchema>;

export const meUsageSchema = z
  .object({
    /**
     * Число завершённых рейсов пользователя (T-UIFIX5). Рейсы в статусе
     * `in_progress`/`failed`/`archived`/`abandoned` не считаются — «фантомный»
     * рейс не должен занимать Free-лимит.
     */
    flights_total: z.number().int().nonnegative(),
    /** Завершённые рейсы в текущем периоде (`period_start` … сейчас). */
    flights_this_period: z.number().int().nonnegative(),
    period_start: utcDateTimeSchema,
    /**
     * Сколько дней занимает облачная история данных: возраст самого старого
     * завершённого рейса, ограниченный сроком хранения тарифа (`history_days`).
     * Нет завершённых рейсов → `0`. Считается только по фактическим рейсам,
     * не по дате регистрации (T-UIFIX5).
     */
    history_days_used: z.number().int().nonnegative(),
  })
  .strict();
export type MeUsage = z.output<typeof meUsageSchema>;

/**
 * Фактические права доступа пользователя (iter58). Ручной безлимит и AI —
 * отдельные признаки, не выводятся из лимитов тарифа:
 * - `unlimited` — тариф `unlimited` выдан вручную (безлимит истории/рейсов);
 * - `ai_granted` — доступ к AI-разбору выдан (владельцем или тарифом Pro);
 * - `ai_available` — гейт: `ai_granted` ∧ AI подключён на сервере (`LLM_ENABLED`).
 */
export const meEntitlementsSchema = z
  .object({
    unlimited: z.boolean(),
    ai_granted: z.boolean(),
    ai_available: z.boolean(),
    /** T184: создание/ведение клубов и publish экзаменов (Pro/Lifetime/unlimited или ручной грант). */
    clubs_enabled: z.boolean(),
    /** B1: CSV-отчёт, телеметрия и печатный PDF — Pro/Lifetime/unlimited. */
    exports_enabled: z.boolean(),
  })
  .strict();
export type MeEntitlements = z.output<typeof meEntitlementsSchema>;

/**
 * IANA-пояс пользователя (P0-1): по нему считаются его локальный день, серия и
 * дневные бонусы. `null` — пояс не задан (сервер считает по UTC). Здесь только
 * формат/длина; реальность зоны проверяет сервер через `Intl.DateTimeFormat`.
 */
export const timeZoneSchema = z.string().min(1).max(64);
export type TimeZone = z.output<typeof timeZoneSchema>;

/**
 * WAVE 3a: предпочтение единиц измерения пользователя. Влияет только на
 * отображение (клиент), сервер/AI/скоринг остаются SI/авиационно-каноничны.
 * `null` — не задано, поведение по умолчанию `metric` (трактуют и сервер, и UI).
 */
export const userUnitsSchema = z.enum(['metric', 'imperial']);
export type UserUnits = z.output<typeof userUnitsSchema>;

/**
 * Дефолтные единицы отображения (WAVE 3a). Явный серверный дефолт: свежий
 * пользователь и legacy-`NULL` трактуются как `metric`. Выбор согласован с
 * авиационным каноном данных (ft/kt/fpm/NM остаются на сервере) и с EN-локалью:
 * англоязычный интерфейс не переключает единицы сам — пользователь меняет их
 * в настройках, предпочтение хранится в `users.units`.
 */
export const DEFAULT_USER_UNITS: UserUnits = 'metric';

/**
 * L1: что показывать в лидерборде — публичный тег (`tag`) или отображаемое
 * имя (`name`). Тег по умолчанию: имя не утекает без явного выбора пилота.
 */
export const leaderboardNameModeSchema = z.enum(['tag', 'name']);
export type LeaderboardNameMode = z.output<typeof leaderboardNameModeSchema>;

export const DEFAULT_LEADERBOARD_VISIBLE = true;
export const DEFAULT_LEADERBOARD_NAME_MODE: LeaderboardNameMode = 'tag';

export const meSchema = z
  .object({
    id: uuidSchema,
    email: emailSchema,
    display_name: z.string(),
    locale: z.string(),
    /**
     * IANA-пояс пользователя (P0-1); `null` — не задан (сервер трактует как UTC).
     * Заполняется браузером при загрузке сессии, не влияет на отображение времени.
     */
    timezone: timeZoneSchema.nullable(),
    /**
     * WAVE 3a: единицы измерения (`metric`/`imperial`), `null` — не заданы
     * (по умолчанию `metric`). Только отображение: серверные данные SI/каноничны.
     */
    units: userUnitsSchema.nullable(),
    created_at: utcDateTimeSchema,
    plan: mePlanSchema,
    usage: meUsageSchema,
    entitlements: meEntitlementsSchema,
    /** Подтверждён ли e-mail (T-AUTH1). */
    email_verified: z.boolean(),
    /** Ожидаемый новый адрес при смене e-mail до подтверждения. */
    pending_email: emailSchema.nullable(),
    /**
     * Уникальный `@handle` (ADR-0020 / T-IDN1). `null` — тег ещё не занят;
     * существующие пользователи остаются без тега.
     */
    handle: handleSchema.nullable(),
    /** Роль из БД (не JWT); для UI-ссылки на админку. Сервер всегда перепроверяет. */
    role: userRoleSchema,
    /** Когда тег последний раз меняли; `null` если ещё не ставили. */
    handle_changed_at: utcDateTimeSchema.nullable(),
    /**
     * Когда можно снова сменить тег (cooldown 30 дней). `null` — смена сейчас
     * разрешена (нет тега / cooldown истёк). Первый захват — без cooldown.
     */
    handle_can_change_at: utcDateTimeSchema.nullable(),
    /**
     * L1: участвовать ли в лидербордах. Уровень пользователя, не рейса:
     * при `false` пилот не попадает ни в один разрез (ВС/аэропорт/общий).
     */
    leaderboard_visible: z.boolean(),
    /** L1: `tag` — тег (`pilot-xxxxxx` без тега), `name` — display_name. */
    leaderboard_name_mode: leaderboardNameModeSchema,
  })
  .strict();
export type Me = z.output<typeof meSchema>;

/**
 * Тело `PATCH /v1/me` (T41 кр.9 / ADR-0020 T-IDN2): `display_name`, `locale`,
 * `handle`, `timezone`. `.strict()` — неизвестные поля → 422 (никакого
 * mass-assignment); `.refine` — пустое тело `{}` тоже 422. `display_name` — общий
 * `displayNameSchema` (ADR-0020 §2.1 / IDN-07), тот же что у `registerSchema`.
 * `handle` нормализуется lowercase в `handleSchema`; бизнес-правила
 * (резерв/занятость/cooldown) — на сервере. `timezone` (P0-1) — IANA-имя,
 * `null` сбрасывает пояс на UTC; реальность зоны проверяет сервер.
 * `units` (WAVE 3a) — только отображение (`metric`/`imperial`), enum → 422.
 */
export const meUpdateSchema = z
  .object({
    display_name: displayNameSchema.optional(),
    locale: z.enum(['ru', 'en']).optional(),
    handle: handleSchema.optional(),
    timezone: timeZoneSchema.nullable().optional(),
    units: userUnitsSchema.optional(),
    /** L1: показывать пилота в лидербордах (по умолчанию включено). */
    leaderboard_visible: z.boolean().optional(),
    /** L1: `tag` (по умолчанию) или `name` в подписи лидерборда. */
    leaderboard_name_mode: leaderboardNameModeSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message:
      'at least one of display_name, locale, handle, timezone, units, leaderboard_visible, leaderboard_name_mode must be provided',
  });
export type MeUpdate = z.output<typeof meUpdateSchema>;
