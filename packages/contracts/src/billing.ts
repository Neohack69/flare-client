import { z } from 'zod';
import { utcDateTimeSchema, uuidSchema } from './primitives.js';

/**
 * Коды тарифов (brief iter27/T49): Free / Pro (подписка) / Lifetime (разово).
 * Бывшие `premium_monthly`/`premium_yearly` заменены на `pro`/`lifetime`;
 * строки `plans` засеяны миграцией 0015.
 *
 * `unlimited` — ручной безлимит, выдаваемый владельцем (миграция 0026):
 * безлимит истории/рейсов; AI управляется отдельным флагом `users.ai_enabled`.
 */
export const planCodeSchema = z.enum(['free', 'pro', 'lifetime', 'unlimited']);
export type PlanCode = z.output<typeof planCodeSchema>;

export const planSchema = z
  .object({
    code: planCodeSchema,
    name: z.string().min(1),
    price_rub: z.number().int().nonnegative(),
    period_days: z.number().int().positive().nullish(),
    /**
     * Входит ли AI в тариф (доступ), отдельно от квоты (T145/BUG-AI-02).
     */
    includes_ai: z.boolean(),
    /**
     * Месячная квота отчётов (D-AI10): `null` — безлимит, `> 0` — лимит,
     * `0` — квота не выделена (доступ только по `includes_ai` → 429 на вызов).
     */
    ai_reports_per_month: z.number().int().nonnegative().nullish(),
    history_days: z.number().int().nonnegative().nullish(),
    max_flights: z.number().int().nonnegative().nullish(),
    /** Лимит устройств тарифа (ADR-0018 §8.1); `null`/отсутствие — безлимит. */
    max_devices: z.number().int().nonnegative().nullish(),
    features: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type Plan = z.output<typeof planSchema>;

export const subscriptionStatusSchema = z.enum([
  'active',
  'past_due',
  'canceled',
  'expired',
  'pending',
]);
export type SubscriptionStatus = z.output<typeof subscriptionStatusSchema>;

export const subscriptionSchema = z
  .object({
    id: uuidSchema,
    user_id: uuidSchema,
    plan_code: planCodeSchema,
    status: subscriptionStatusSchema,
    provider: z.string().default('yookassa'),
    current_period_start: utcDateTimeSchema.nullable(),
    current_period_end: utcDateTimeSchema.nullable(),
    cancel_at_period_end: z.boolean().default(false),
    created_at: utcDateTimeSchema,
    updated_at: utcDateTimeSchema,
  })
  .strict();
export type Subscription = z.output<typeof subscriptionSchema>;

export const checkoutRequestSchema = z.object({ plan_code: planCodeSchema }).strict();
export type CheckoutRequest = z.output<typeof checkoutRequestSchema>;

export const checkoutResponseSchema = z.object({ confirmation_url: z.string().url() }).strict();
export type CheckoutResponse = z.output<typeof checkoutResponseSchema>;
