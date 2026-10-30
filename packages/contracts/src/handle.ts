import { z } from 'zod';

/**
 * Пилотский `@handle` (ADR-0020 §3): уникальный тег, латиница/цифры/`_`,
 * 3–20 символов. Префикс `@` — только UI; в контракте и БД — без `@`.
 * Нормализация: trim + lowercase до regex-проверки.
 */
export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;

/** Cooldown смены тега (дней); первый захват (`handle IS NULL`) — без cooldown. */
export const HANDLE_CHANGE_COOLDOWN_DAYS = 30;

/** Резерв старого тега в `handle_history` после смены/удаления (дней). */
export const HANDLE_RELEASE_RESERVE_DAYS = 30;

export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .min(HANDLE_MIN)
      .max(HANDLE_MAX)
      .regex(/^[a-z][a-z0-9_]{2,19}$/, 'handle must be 3-20 chars: [a-z][a-z0-9_]'),
  );
export type Handle = z.output<typeof handleSchema>;

/**
 * Резерв-лист системных/брендовых тегов (ADR-0020 §3.2). Единый источник —
 * константа в contracts, не таблица БД. Сравнение регистронезависимо
 * (после нормализации handle всегда lowercase).
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'admins',
  'root',
  'support',
  'help',
  'helpdesk',
  'moderator',
  'mod',
  'staff',
  'official',
  'system',
  'sys',
  'security',
  'api',
  'www',
  'app',
  'mail',
  'email',
  'billing',
  'payments',
  'settings',
  'login',
  'register',
  'device',
  'tdmoment',
  'touchdown',
  'touchdownmoment',
  'flightlog',
  'avsim',
  'me',
  'null',
  'undefined',
]);

/** `true`, если нормализованный handle входит в резерв-лист. */
export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.trim().toLowerCase());
}

/** Роль пользователя (колонка `users.role`, миграция 0002). Не кладём в JWT. */
export const userRoleSchema = z.enum(['user', 'admin']);
export type UserRole = z.output<typeof userRoleSchema>;

/**
 * Причина недоступности тега (`GET /v1/handles/available`, T-IDN2).
 * При `available=true` поле `reason` отсутствует.
 */
export const handleAvailabilityReasonSchema = z.enum([
  'taken',
  'reserved',
  'recently_released',
  'invalid',
]);
export type HandleAvailabilityReason = z.output<typeof handleAvailabilityReasonSchema>;

export const handleAvailabilitySchema = z
  .object({
    handle: z.string(),
    available: z.boolean(),
    reason: handleAvailabilityReasonSchema.optional(),
  })
  .strict();
export type HandleAvailability = z.output<typeof handleAvailabilitySchema>;

/**
 * Query `GET /v1/handles/available?handle=` (T-IDN2). Сырая строка: невалидный
 * формат → `{ available: false, reason: 'invalid' }`, не `422` (ADR-0020 §3.3).
 */
export const handleAvailabilityQuerySchema = z
  .object({
    handle: z.string(),
  })
  .strict();
export type HandleAvailabilityQuery = z.output<typeof handleAvailabilityQuerySchema>;
