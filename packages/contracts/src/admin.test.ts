import { describe, expect, it } from 'vitest';

import {
  adminAuditEntrySchema,
  adminDeviceLimitUpdateSchema,
  adminEntitlementsUpdateSchema,
  adminStepUpSchema,
  adminUserDeleteSchema,
  adminUserDetailSchema,
  adminUserSummarySchema,
  adminUsersQuerySchema,
} from './admin.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = '2026-09-23T12:34:56Z';

describe('adminStepUpSchema (ADR-0020 §5.1)', () => {
  it('принимает current_password или totp_code', () => {
    expect(adminStepUpSchema.safeParse({ current_password: 'secret' }).success).toBe(true);
    expect(adminStepUpSchema.safeParse({ totp_code: '123456' }).success).toBe(true);
  });

  it('пустое step_up → ошибка', () => {
    expect(adminStepUpSchema.safeParse({}).success).toBe(false);
  });
});

describe('adminUsersQuerySchema', () => {
  it('требует query ≥ 2 и limit ≤ 100', () => {
    expect(adminUsersQuerySchema.safeParse({ query: 'ab' }).success).toBe(true);
    expect(adminUsersQuerySchema.safeParse({ query: 'a' }).success).toBe(false);
    expect(adminUsersQuerySchema.parse({ query: 'ace', limit: '50' }).limit).toBe(50);
    expect(adminUsersQuerySchema.safeParse({ query: 'ace', limit: 101 }).success).toBe(false);
  });
});

describe('adminUserSummary/Detail — без секретов', () => {
  const summary = {
    id: UUID,
    email: 'pilot@example.com',
    display_name: 'Ace',
    handle: 'neohack',
    role: 'user',
    plan_code: 'free',
    ai_enabled: false,
    email_verified: true,
    created_at: NOW,
  };

  it('принимает summary и отклоняет password_hash', () => {
    expect(adminUserSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      adminUserSummarySchema.safeParse({ ...summary, password_hash: 'x' }).success,
    ).toBe(false);
  });

  it('detail отклоняет machine_hash / totp_secret', () => {
    const detail = {
      ...summary,
      locale: 'ru',
      pending_email: null,
      device_limit_override: null,
      devices_active: 1,
      devices_limit: 2,
      flights_total: 3,
      handle_changed_at: null,
      updated_at: NOW,
    };
    expect(adminUserDetailSchema.safeParse(detail).success).toBe(true);
    expect(
      adminUserDetailSchema.safeParse({ ...detail, machine_hash: 'abc' }).success,
    ).toBe(false);
    expect(
      adminUserDetailSchema.safeParse({ ...detail, totp_secret: 'abc' }).success,
    ).toBe(false);
  });
});

describe('adminEntitlementsUpdateSchema', () => {
  it('требует step_up и хотя бы одно поле плана/AI', () => {
    expect(
      adminEntitlementsUpdateSchema.safeParse({
        plan_code: 'pro',
        step_up: { current_password: 'x' },
      }).success,
    ).toBe(true);
    expect(
      adminEntitlementsUpdateSchema.safeParse({
        step_up: { current_password: 'x' },
      }).success,
    ).toBe(false);
    expect(adminEntitlementsUpdateSchema.safeParse({ plan_code: 'pro' }).success).toBe(false);
  });
});

describe('adminDeviceLimitUpdateSchema / adminUserDeleteSchema', () => {
  it('device_limit_override допускает null и требует step_up (IDN-06)', () => {
    const step_up = { current_password: 'x' };
    expect(
      adminDeviceLimitUpdateSchema.safeParse({ device_limit_override: null, step_up }).success,
    ).toBe(true);
    expect(
      adminDeviceLimitUpdateSchema.safeParse({ device_limit_override: 0, step_up }).success,
    ).toBe(true);
    expect(
      adminDeviceLimitUpdateSchema.safeParse({ device_limit_override: -1, step_up }).success,
    ).toBe(false);
    expect(
      adminDeviceLimitUpdateSchema.safeParse({ device_limit_override: 7 }).success,
    ).toBe(false);
  });

  it('delete требует confirm + step_up', () => {
    expect(
      adminUserDeleteSchema.safeParse({
        confirm: 'pilot@example.com',
        step_up: { current_password: 'x' },
      }).success,
    ).toBe(true);
    expect(adminUserDeleteSchema.safeParse({ confirm: 'pilot@example.com' }).success).toBe(
      false,
    );
  });
});

describe('adminAuditEntrySchema', () => {
  it('принимает запись без PII-полей (strict)', () => {
    const entry = {
      id: UUID,
      actor_user_id: UUID,
      actor_label: null,
      action: 'admin.user_read',
      target_type: 'user',
      target_id: UUID,
      metadata: { reason: 'card' },
      ip_hash: 'abc',
      created_at: NOW,
    };
    expect(adminAuditEntrySchema.safeParse(entry).success).toBe(true);
    expect(adminAuditEntrySchema.safeParse({ ...entry, email: 'x@y.z' }).success).toBe(false);
  });
});
