import { describe, expect, it } from 'vitest';

import { publicConfigSchema } from './config.js';

describe('publicConfigSchema (T-MAIL1)', () => {
  it('принимает оба флага', () => {
    expect(
      publicConfigSchema.safeParse({ email_verification_required: false, mail_enabled: false })
        .success,
    ).toBe(true);
    expect(
      publicConfigSchema.safeParse({ email_verification_required: true, mail_enabled: true })
        .success,
    ).toBe(true);
  });

  it('отклоняет отсутствующие поля и неизвестные ключи', () => {
    expect(publicConfigSchema.safeParse({ email_verification_required: false }).success).toBe(false);
    expect(
      publicConfigSchema.safeParse({
        email_verification_required: false,
        mail_enabled: false,
        smtp_host: 'smtp.example.com',
      }).success,
    ).toBe(false);
  });

  it('A-02: journal_summary_available необязателен (старый бандл без него валиден)', () => {
    const without = publicConfigSchema.safeParse({
      email_verification_required: false,
      mail_enabled: false,
    });
    expect(without.success).toBe(true);

    const withFlag = publicConfigSchema.safeParse({
      email_verification_required: false,
      mail_enabled: false,
      journal_summary_available: false,
    });
    expect(withFlag.success).toBe(true);
    if (withFlag.success) expect(withFlag.data.journal_summary_available).toBe(false);
  });
});
