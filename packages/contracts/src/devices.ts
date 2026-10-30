import { z } from 'zod';
import { utcDateTimeSchema, uuidSchema } from './primitives.js';

/**
 * Управление устройствами аккаунта (ADR-0018 §8.2/§9.1, T-DEVL2/T-DEVL5).
 *
 * «Устройство» — строка `devices` со `status='approved'` и заполненным `user_id`.
 * `revoked_at` определяет soft-revoke: история рейсов и офлайн-буфер не удаляются.
 *
 * Наружу **никогда** не отдаём `token_hash`, `device_code_hash`, `machine_hash`,
 * raw `machine_id`, `user_code`, полный IP (инвариант закреплён контракт-тестом).
 */
export const meDeviceStatusSchema = z.enum(['active', 'stale', 'archived', 'revoked']);
export type MeDeviceStatus = z.output<typeof meDeviceStatusSchema>;

/** Максимальная длина имени устройства (`PATCH /v1/me/devices/:id`, ADR-0018 §4.1). */
export const DEVICE_NAME_MAX_LENGTH = 64;

/**
 * Управляющие символы в имени запрещены (кроме trim-очищаемых хвостов):
 * переносы строк/табы/NUL не должны попадать в UI-подписи.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const meDeviceSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(DEVICE_NAME_MAX_LENGTH),
    platform: z.string().nullable(),
    /** Канал подключения: `agent` | `msfs-plugin` | `electron` | `null` (legacy). */
    source: z.string().nullable(),
    agent_version: z.string().nullable(),
    status: meDeviceStatusSchema,
    /** `machine_hash IS NOT NULL` — факт привязки, без значения хэша (ADR-0018 §8.2). */
    machine_bound: z.boolean(),
    /** Устройство, которым сделан запрос (по `dev`-клейму), если однозначно определимо. */
    is_current: z.boolean(),
    created_at: utcDateTimeSchema,
    approved_at: utcDateTimeSchema.nullable(),
    last_seen_at: utcDateTimeSchema.nullable(),
    revoked_at: utcDateTimeSchema.nullable(),
    device_token_expires_at: utcDateTimeSchema.nullable(),
  })
  .strict();
export type MeDevice = z.output<typeof meDeviceSchema>;

/** Фильтр `GET /v1/me/devices?include=...`; по умолчанию — только активные. */
export const meDevicesIncludeSchema = z.enum(['active', 'revoked', 'all']).default('active');
export type MeDevicesInclude = z.output<typeof meDevicesIncludeSchema>;

export const meDevicesDataSchema = z
  .object({
    /** `null` — безлимит (`plans.max_devices IS NULL`, напр. `unlimited`). */
    limit: z.number().int().nonnegative().nullable(),
    /** Число устройств, учитываемых в лимите: `approved` ∧ `revoked_at IS NULL`. */
    active: z.number().int().nonnegative(),
    items: z.array(meDeviceSchema),
  })
  .strict();
export type MeDevicesData = z.output<typeof meDevicesDataSchema>;

/**
 * Query `GET /v1/me/devices`. Не `.strict()`: неизвестные query-параметры
 * (напр. UI-only `highlight=<id>`) не должны превращаться в 422.
 */
export const meDevicesQuerySchema = z.object({
  include: meDevicesIncludeSchema,
});
export type MeDevicesQuery = z.output<typeof meDevicesQuerySchema>;

export const meDeviceUpdateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(DEVICE_NAME_MAX_LENGTH)
      .refine((value) => !CONTROL_CHARS.test(value), {
        message: 'name must not contain control characters',
      }),
  })
  .strict();
export type MeDeviceUpdate = z.output<typeof meDeviceUpdateSchema>;
