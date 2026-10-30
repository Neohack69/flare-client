import { z } from 'zod';
import { planCodeSchema } from './billing.js';
import { meDeviceSchema } from './devices.js';
import { handleSchema, userRoleSchema } from './handle.js';
import { paginationMetaSchema } from './errors.js';
import { emailSchema, utcDateTimeSchema, uuidSchema } from './primitives.js';

/**
 * Админ-API (ADR-0020 §4/§10.2 / T-IDN3).
 *
 * Наружу **никогда** не отдаём `password_hash`, `totp_secret`, токены, `*_hash`,
 * IP, `machine_hash`. Аудит хранит id/action/metadata-allowlist, не email/имя.
 */

/** Step-up на разрушительные действия (§5.1): TOTP или текущий пароль. */
export const adminStepUpSchema = z
  .object({
    totp_code: z.string().trim().min(6).max(12).optional(),
    current_password: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.totp_code || v.current_password), {
    message: 'step_up requires totp_code or current_password',
  });
export type AdminStepUp = z.output<typeof adminStepUpSchema>;

/** Краткий пользователь в поиске/списке. */
export const adminUserSummarySchema = z
  .object({
    id: uuidSchema,
    email: emailSchema,
    display_name: z.string(),
    handle: handleSchema.nullable(),
    role: userRoleSchema,
    plan_code: planCodeSchema,
    ai_enabled: z.boolean(),
    email_verified: z.boolean(),
    created_at: utcDateTimeSchema,
  })
  .strict();
export type AdminUserSummary = z.output<typeof adminUserSummarySchema>;

/** Карточка пользователя (без секретов). */
export const adminUserDetailSchema = z
  .object({
    id: uuidSchema,
    email: emailSchema,
    display_name: z.string(),
    handle: handleSchema.nullable(),
    role: userRoleSchema,
    locale: z.string(),
    plan_code: planCodeSchema,
    ai_enabled: z.boolean(),
    email_verified: z.boolean(),
    pending_email: emailSchema.nullable(),
    device_limit_override: z.number().int().nonnegative().nullable(),
    devices_active: z.number().int().nonnegative(),
    devices_limit: z.number().int().nonnegative().nullable(),
    flights_total: z.number().int().nonnegative(),
    handle_changed_at: utcDateTimeSchema.nullable(),
    created_at: utcDateTimeSchema,
    updated_at: utcDateTimeSchema,
  })
  .strict();
export type AdminUserDetail = z.output<typeof adminUserDetailSchema>;

export const adminUsersQuerySchema = z
  .object({
    /** Поиск ≥ 2 символа (email / имя / тег / uuid). */
    query: z.string().trim().min(2).max(128),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type AdminUsersQuery = z.output<typeof adminUsersQuerySchema>;

export const adminUsersResponseSchema = z
  .object({
    data: z.array(adminUserSummarySchema),
    meta: paginationMetaSchema,
  })
  .strict();
export type AdminUsersResponse = z.output<typeof adminUsersResponseSchema>;

export const adminEntitlementsUpdateSchema = z
  .object({
    plan_code: planCodeSchema.optional(),
    ai_enabled: z.boolean().optional(),
    step_up: adminStepUpSchema,
  })
  .strict()
  .refine((v) => v.plan_code !== undefined || v.ai_enabled !== undefined, {
    message: 'at least one of plan_code, ai_enabled must be provided',
  });
export type AdminEntitlementsUpdate = z.output<typeof adminEntitlementsUpdateSchema>;

/** Устройство в админ-карточке — тот же whitelist, что `meDeviceSchema` (без *_hash). */
export const adminDeviceSchema = meDeviceSchema;
export type AdminDevice = z.output<typeof adminDeviceSchema>;

export const adminDevicesDataSchema = z
  .object({
    limit: z.number().int().nonnegative().nullable(),
    active: z.number().int().nonnegative(),
    items: z.array(adminDeviceSchema),
  })
  .strict();
export type AdminDevicesData = z.output<typeof adminDevicesDataSchema>;

export const adminDeviceLimitUpdateSchema = z
  .object({
    /** `null` — наследовать тариф; `int ≥ 0` — override (0 = устройства запрещены). */
    device_limit_override: z.number().int().nonnegative().nullable(),
    step_up: adminStepUpSchema,
  })
  .strict();
export type AdminDeviceLimitUpdate = z.output<typeof adminDeviceLimitUpdateSchema>;

export const adminUserDeleteSchema = z
  .object({
    /** Typed-confirm: должен совпасть с email цели. */
    confirm: emailSchema,
    step_up: adminStepUpSchema,
  })
  .strict();
export type AdminUserDelete = z.output<typeof adminUserDeleteSchema>;

export const adminShareRevokeSchema = z
  .object({
    step_up: adminStepUpSchema,
  })
  .strict();
export type AdminShareRevoke = z.output<typeof adminShareRevokeSchema>;

export const adminShareRevokeResultSchema = z
  .object({
    flight_id: uuidSchema,
    revoked_count: z.number().int().nonnegative(),
  })
  .strict();
export type AdminShareRevokeResult = z.output<typeof adminShareRevokeResultSchema>;

export const adminAuditTargetTypeSchema = z.enum([
  'user',
  'device',
  'share',
  'flight',
  'session',
  'system',
  'aircraft_model',
]);
export type AdminAuditTargetType = z.output<typeof adminAuditTargetTypeSchema>;

export const adminAuditEntrySchema = z
  .object({
    id: uuidSchema,
    actor_user_id: uuidSchema.nullable(),
    actor_label: z.string().nullable(),
    action: z.string().min(1),
    target_type: adminAuditTargetTypeSchema,
    target_id: uuidSchema.nullable(),
    metadata: z.record(z.string(), z.unknown()),
    ip_hash: z.string().nullable(),
    created_at: utcDateTimeSchema,
  })
  .strict();
export type AdminAuditEntry = z.output<typeof adminAuditEntrySchema>;

export const adminAuditQuerySchema = z
  .object({
    actor: uuidSchema.optional(),
    target: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type AdminAuditQuery = z.output<typeof adminAuditQuerySchema>;

export const adminAuditResponseSchema = z
  .object({
    data: z.array(adminAuditEntrySchema),
    meta: paginationMetaSchema,
  })
  .strict();
export type AdminAuditResponse = z.output<typeof adminAuditResponseSchema>;
