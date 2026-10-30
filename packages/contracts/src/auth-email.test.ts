import { describe, expect, it } from 'vitest';

import {
  emailChangeRequestSchema,
  emailResendRequestSchema,
  emailStatusResponseSchema,
  emailVerifyRequestSchema,
  emailVerifyResponseSchema,
  loginSchema,
  registerSchema,
} from './auth.js';
import { meSchema } from './me.js';

describe('auth: captcha_token / honeypot (T-AUTH1)', () => {
  it('register принимает captcha_token и website', () => {
    const parsed = registerSchema.safeParse({
      handle: 'pilot',
      email: 'pilot@example.com',
      password: 'supersecret',
      display_name: 'Ace',
      captcha_token: 'tok_123',
      website: '',
    });
    expect(parsed.success).toBe(true);
  });

  it('register без необязательных полей валиден (provider=none)', () => {
    expect(
      registerSchema.safeParse({
        email: 'pilot@example.com',
        password: 'supersecret',
        display_name: 'Ace',
        handle: 'ace',
      }).success,
    ).toBe(true);
    expect(
      registerSchema.safeParse({
        email: 'pilot@example.com',
        password: 'supersecret',
        display_name: 'Ace',
      }).success,
    ).toBe(false);
  });

  it('login принимает captcha_token', () => {
    expect(
      loginSchema.safeParse({
        email: 'pilot@example.com',
        password: 'x',
        captcha_token: 'tok_123',
      }).success,
    ).toBe(true);
    expect(loginSchema.safeParse({ email: 'pilot@example.com', password: 'x' }).success).toBe(true);
  });

  it('пустой captcha_token невалиден', () => {
    expect(
      loginSchema.safeParse({ email: 'pilot@example.com', password: 'x', captcha_token: ' ' })
        .success,
    ).toBe(false);
  });
});

describe('auth: email verify/resend/change (T-AUTH1)', () => {
  it('verify request требует непустой token', () => {
    expect(emailVerifyRequestSchema.safeParse({ token: 'abc' }).success).toBe(true);
    expect(emailVerifyRequestSchema.safeParse({ token: '' }).success).toBe(false);
    expect(emailVerifyRequestSchema.safeParse({}).success).toBe(false);
  });

  it('verify response — email_verified: true', () => {
    expect(emailVerifyResponseSchema.safeParse({ email_verified: true }).success).toBe(true);
    expect(emailVerifyResponseSchema.safeParse({ email_verified: false }).success).toBe(false);
  });

  it('resend требует email, captcha_token опционален', () => {
    expect(emailResendRequestSchema.safeParse({ email: 'a@b.ru' }).success).toBe(true);
    expect(
      emailResendRequestSchema.safeParse({ email: 'a@b.ru', captcha_token: 't' }).success,
    ).toBe(true);
    expect(emailResendRequestSchema.safeParse({ captcha_token: 't' }).success).toBe(false);
  });

  it('change требует new_email и password', () => {
    expect(
      emailChangeRequestSchema.safeParse({ new_email: 'a@b.ru', password: 'secret' }).success,
    ).toBe(true);
    expect(emailChangeRequestSchema.safeParse({ new_email: 'a@b.ru' }).success).toBe(false);
  });

  it('статус-ответ — только accepted', () => {
    expect(emailStatusResponseSchema.safeParse({ status: 'accepted' }).success).toBe(true);
    expect(emailStatusResponseSchema.safeParse({ status: 'sent' }).success).toBe(false);
  });
});

describe('meSchema: email_verified / pending_email (T-AUTH1)', () => {
  const base = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    email: 'pilot@example.com',
    display_name: 'Ace',
    locale: 'ru',
    timezone: null,
    units: null,
    created_at: '2026-09-28T00:00:00Z',
    plan: {
      code: 'free',
      name: 'Free',
      includes_ai: false,
      ai_reports_per_month: 0,
      history_days: 30,
      max_flights: 20,
      max_devices: 2,
    },
    usage: {
      flights_total: 0,
      flights_this_period: 0,
      period_start: '2026-09-01T00:00:00Z',
      history_days_used: 0,
    },
    entitlements: {
      unlimited: false,
      ai_granted: false,
      ai_available: false,
      clubs_enabled: false,
      exports_enabled: false,
    },
    handle: null,
    role: 'user',
    handle_changed_at: null,
    handle_can_change_at: null,
    leaderboard_visible: true,
    leaderboard_name_mode: 'tag',
  };

  it('принимает email_verified и pending_email=null', () => {
    expect(meSchema.safeParse({ ...base, email_verified: true, pending_email: null }).success).toBe(
      true,
    );
  });

  it('принимает pending_email как адрес', () => {
    expect(
      meSchema.safeParse({ ...base, email_verified: false, pending_email: 'new@example.com' })
        .success,
    ).toBe(true);
  });

  it('требует оба поля (strict)', () => {
    expect(meSchema.safeParse(base).success).toBe(false);
  });
});
