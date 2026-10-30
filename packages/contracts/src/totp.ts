import { z } from 'zod';

/**
 * Self-service TOTP enroll / confirm / disable (IDN-01 / ADR-0020 §5.1).
 * Секрет и recovery-коды — одноразовые в ответах; наружу после confirm секрет
 * не возвращаем. Step-up для admin-мутаций — `adminStepUpSchema` (`totp_code`).
 */

export const totpEnrollBeginResponseSchema = z
  .object({
    /** Base32 secret — только на begin; после confirm не отдаём. */
    secret: z.string().min(16).max(128),
    otpauth_uri: z.string().startsWith('otpauth://').max(512),
    totp_enabled: z.literal(false),
  })
  .strict();
export type TotpEnrollBeginResponse = z.output<typeof totpEnrollBeginResponseSchema>;

export const totpConfirmBodySchema = z
  .object({
    code: z.string().trim().regex(/^\d{6}$/, 'TOTP code must be 6 digits'),
  })
  .strict();
export type TotpConfirmBody = z.output<typeof totpConfirmBodySchema>;

export const totpConfirmResponseSchema = z
  .object({
    totp_enabled: z.literal(true),
    /** Plaintext recovery codes — только в этом ответе, один раз. */
    recovery_codes: z.array(z.string().min(8).max(32)).min(1).max(20),
  })
  .strict();
export type TotpConfirmResponse = z.output<typeof totpConfirmResponseSchema>;

export const totpDisableBodySchema = z
  .object({
    totp_code: z.string().trim().regex(/^\d{6}$/).optional(),
    recovery_code: z.string().trim().min(8).max(32).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.totp_code || v.recovery_code), {
    message: 'totp_code or recovery_code required',
  });
export type TotpDisableBody = z.output<typeof totpDisableBodySchema>;

export const totpStatusSchema = z
  .object({
    totp_enabled: z.boolean(),
  })
  .strict();
export type TotpStatus = z.output<typeof totpStatusSchema>;
