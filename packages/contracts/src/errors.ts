import { z } from 'zod';

export const errorCodesSchema = z.enum([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  // T-D §4.1: `aircraft_icao` не прошёл `aircraftIcaoSchema` при правке типа рейса.
  'INVALID_ICAO',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'PLAN_LIMIT_EXCEEDED',
  'ENTITLEMENT_REQUIRED',
  'NO_LANDINGS',
  'NOT_ENOUGH_DATA',
  'AI_UNAVAILABLE',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL_ERROR',
  'AUTHORIZATION_PENDING',
  'EXPIRED_TOKEN',
  'NOT_IMPLEMENTED',
  // ADR-0018: превышен `plans.max_devices`/`users.device_limit_override` на `device/approve`.
  'DEVICE_LIMIT_REACHED',
  // ADR-0018 §5: `X-TD-Machine-Id`/`machine_id` не совпал с `devices.machine_hash`.
  'MACHINE_MISMATCH',
  // T-PAIRUX2: повторный approve кода, который уже потреблён (устройство создано).
  // Отличается от `NOT_FOUND` (кода нет вовсе), чтобы web не показывал «не найден».
  'DEVICE_CODE_ALREADY_USED',
  // T-AUTH1: анти-абьюз auth (auth-abuse-protection.md §2.3/§3.3).
  'CAPTCHA_REQUIRED',
  'CAPTCHA_FAILED',
  'CAPTCHA_UNAVAILABLE',
  'EMAIL_NOT_VERIFIED',
  'EMAIL_TOKEN_INVALID',
  'EMAIL_TOKEN_EXPIRED',
  'EMAIL_UNAVAILABLE',
  'REGISTRATION_DISABLED',
  // T170: ack celebration для ачивки, у которой ещё нет unlocked_at.
  'NOT_UNLOCKED',
  // ADR-0020 / T-IDN1: уникальный @handle.
  'HANDLE_TAKEN',
  'HANDLE_RESERVED',
  'HANDLE_CHANGE_COOLDOWN',
  // ADR-0020: админ-действие без step-up/TOTP (T-IDN3).
  'ADMIN_REAUTH_REQUIRED',
  // IDN-01 / ADR-0020 §5.1: role=admin без включённого TOTP → блок /v1/admin/*.
  'ADMIN_TOTP_REQUIRED',
]);
export type ErrorCode = z.output<typeof errorCodesSchema>;

export const problemFieldErrorSchema = z
  .object({
    path: z.string(),
    message: z.string(),
  })
  .strict();
export type ProblemFieldError = z.output<typeof problemFieldErrorSchema>;

/** RFC 7807 problem+json error envelope. */
export const problemDetailSchema = z
  .object({
    type: z.string().url(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    code: errorCodesSchema,
    detail: z.string().optional(),
    instance: z.string().optional(),
    trace_id: z.string().optional(),
    errors: z.array(problemFieldErrorSchema).optional(),
  })
  .strict();
export type ProblemDetail = z.output<typeof problemDetailSchema>;

export const paginationMetaSchema = z
  .object({
    next_cursor: z.string().nullish(),
    has_more: z.boolean(),
  })
  .strict();
export type PaginationMeta = z.output<typeof paginationMetaSchema>;

/** Generic success envelope factories (api.md §1.1). */
export function singleDataResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({ data: dataSchema }).strict();
}

export function collectionResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z
    .object({
      data: z.array(dataSchema),
      meta: paginationMetaSchema,
      links: z
        .object({
          self: z.string().url(),
          next: z.string().url().nullish(),
        })
        .strict(),
    })
    .strict();
}
