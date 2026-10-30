import { z } from 'zod';

import { handleSchema } from './handle.js';
import { displayNameSchema, emailSchema, utcDateTimeSchema, uuidSchema } from './primitives.js';

export const passwordSchema = z.string().min(8).max(128);
export type Password = z.output<typeof passwordSchema>;

/**
 * Провайдер-агностичный токен капчи (SmartCaptcha/Turnstile), проверяется только
 * сервером (auth-abuse-protection.md §2.3). Никогда не логируется.
 */
export const captchaTokenSchema = z.string().trim().min(1).max(4096);
export type CaptchaToken = z.output<typeof captchaTokenSchema>;

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    display_name: displayNameSchema,
    /** Публичный `@handle` без префикса `@`. Уникален; по нему ищут друзей. */
    handle: handleSchema,
    captcha_token: captchaTokenSchema.optional(),
    /** Honeypot-поле (auth-abuse-protection.md §2.8): скрытое, люди не заполняют. */
    website: z.string().max(256).optional(),
  })
  .strict();
export type Register = z.output<typeof registerSchema>;

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(128),
    captcha_token: captchaTokenSchema.optional(),
  })
  .strict();
export type Login = z.output<typeof loginSchema>;

/** POST /v1/auth/password/forgot — запрос ссылки сброса (всегда 202). */
export const passwordForgotSchema = z
  .object({
    email: emailSchema,
    captcha_token: captchaTokenSchema.optional(),
    website: z.string().max(256).optional(),
  })
  .strict();
export type PasswordForgot = z.output<typeof passwordForgotSchema>;

/** POST /v1/auth/password/reset — одноразовый токен из письма + новый пароль. */
export const passwordResetSchema = z
  .object({ token: z.string().trim().min(20).max(256), password: passwordSchema })
  .strict();
export type PasswordReset = z.output<typeof passwordResetSchema>;

export const refreshRequestSchema = z.object({ refresh_token: z.string().min(1) }).strict();
export type RefreshRequest = z.output<typeof refreshRequestSchema>;

export const logoutRequestSchema = z.object({ refresh_token: z.string().min(1) }).strict();
export type LogoutRequest = z.output<typeof logoutRequestSchema>;

/**
 * Access JWT claims (documentation/typing only; not parsed by this package).
 * `iss`/`aud` обязательны к проверке на сервере (AUTH-2/AUTH-9); `kid` живёт
 * в заголовке токена и здесь не дублируется.
 */
export const jwtClaimsSchema = z
  .object({
    sub: uuidSchema,
    sid: uuidSchema.nullable(),
    plan: z.string(),
    scope: z.enum(['web', 'agent', 'va_api']),
    dev: uuidSchema.nullable(),
    iss: z.string().optional(),
    aud: z.union([z.string(), z.array(z.string())]).optional(),
    exp: z.number().int(),
    iat: z.number().int(),
    jti: uuidSchema,
  })
  .strict();
export type JwtClaims = z.output<typeof jwtClaimsSchema>;

export const tokenPairSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_in: z.number().int().positive(),
  })
  .strict();
export type TokenPair = z.output<typeof tokenPairSchema>;

/**
 * `machine_id` (ADR-0018 §5): случайный opaque-идентификатор машины, генерируется
 * локально (не аппаратный отпечаток). Передаётся заголовком `X-TD-Machine-Id` и/или
 * полем `machine_id?` в device-flow. Сервер хранит только `sha256` (`machine_hash`).
 * Алфавит ограничен URL-safe набором (UUID/hex/base64url) — мусор → 422.
 */
export const machineIdSchema = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/, 'machine_id must be an opaque url-safe identifier');
export type MachineId = z.output<typeof machineIdSchema>;

export const deviceCodeRequestSchema = z
  .object({
    client_name: z.string().trim().min(1).max(128),
    platform: z.string().trim().min(1).max(64),
    machine_id: machineIdSchema.optional(),
  })
  .strict();
export type DeviceCodeRequest = z.output<typeof deviceCodeRequestSchema>;

export const deviceCodeResponseSchema = z
  .object({
    device_code: z.string().min(1),
    user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i, 'must look like "WXYZ-1234"'),
    verification_uri: z.string().url(),
    interval: z.number().int().positive(),
    expires_in: z.number().int().positive(),
  })
  .strict();
export type DeviceCodeResponse = z.output<typeof deviceCodeResponseSchema>;

export const deviceTokenRequestSchema = z
  .object({ device_code: z.string().min(1), machine_id: machineIdSchema.optional() })
  .strict();
export type DeviceTokenRequest = z.output<typeof deviceTokenRequestSchema>;

export const deviceTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    device_token: z.string().min(1),
    device_id: uuidSchema,
    expires_in: z.number().int().positive(),
  })
  .strict();
export type DeviceTokenResponse = z.output<typeof deviceTokenResponseSchema>;

export const deviceRefreshRequestSchema = z
  .object({ device_token: z.string().min(1), machine_id: machineIdSchema.optional() })
  .strict();
export type DeviceRefreshRequest = z.output<typeof deviceRefreshRequestSchema>;

export const deviceApproveRequestSchema = z
  .object({
    user_code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i, 'must look like "WXYZ-1234"'),
  })
  .strict();
export type DeviceApproveRequest = z.output<typeof deviceApproveRequestSchema>;

export const deviceApproveResponseSchema = z
  .object({
    approved: z.literal(true),
    device_id: uuidSchema,
  })
  .strict();
export type DeviceApproveResponse = z.output<typeof deviceApproveResponseSchema>;

/**
 * Preview подтверждаемого устройства (F-103): consent-экран `/device` должен
 * показать, какое устройство подключается, **до** approve. `device_code` не
 * возвращается (никогда не покидает сервер).
 */
export const devicePreviewRequestSchema = z
  .object({
    user_code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i, 'must look like "WXYZ-1234"'),
  })
  .strict();
export type DevicePreviewRequest = z.output<typeof devicePreviewRequestSchema>;

export const devicePreviewResponseSchema = z
  .object({
    client_name: z.string().trim().min(1).max(128),
    platform: z.string().trim().min(1).max(64).nullable(),
    expires_at: utcDateTimeSchema.nullable(),
    status: z.enum(['pending', 'expired']),
  })
  .strict();
export type DevicePreviewResponse = z.output<typeof devicePreviewResponseSchema>;

/** POST /v1/auth/email/verify (T-AUTH1): одноразовый токен из письма. */
export const emailVerifyRequestSchema = z
  .object({ token: z.string().trim().min(1).max(512) })
  .strict();
export type EmailVerifyRequest = z.output<typeof emailVerifyRequestSchema>;

export const emailVerifyResponseSchema = z.object({ email_verified: z.literal(true) }).strict();
export type EmailVerifyResponse = z.output<typeof emailVerifyResponseSchema>;

/** POST /v1/auth/email/resend: повторная отправка письма (no enumeration). */
export const emailResendRequestSchema = z
  .object({
    email: emailSchema,
    captcha_token: captchaTokenSchema.optional(),
  })
  .strict();
export type EmailResendRequest = z.output<typeof emailResendRequestSchema>;

/** POST /v1/auth/email/change: смена адреса до подтверждения (web-сессия + пароль). */
export const emailChangeRequestSchema = z
  .object({
    new_email: emailSchema,
    password: z.string().min(1).max(128),
    captcha_token: captchaTokenSchema.optional(),
  })
  .strict();
export type EmailChangeRequest = z.output<typeof emailChangeRequestSchema>;

/** Общий нейтральный ответ `resend`/`change` — `{ status: 'accepted' }`. */
export const emailStatusResponseSchema = z.object({ status: z.literal('accepted') }).strict();
export type EmailStatusResponse = z.output<typeof emailStatusResponseSchema>;
