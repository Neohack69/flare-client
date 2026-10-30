import { describe, expect, it } from 'vitest';

import {
  PRIVACY_POLICY_VERSION,
  meConsentAcceptSchema,
  meConsentSchema,
  meDeleteSchema,
  meExportSchema,
} from './privacy.js';

describe('privacy contracts (T73)', () => {
  it('PRIVACY_POLICY_VERSION matches YYYY-MM-DD', () => {
    expect(PRIVACY_POLICY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('meConsentSchema: accepted current version', () => {
    const parsed = meConsentSchema.parse({
      current_version: PRIVACY_POLICY_VERSION,
      accepted_version: PRIVACY_POLICY_VERSION,
      accepted_at: '2026-10-01T12:00:00.000Z',
      accepted: true,
      policy_url: null,
    });
    expect(parsed.accepted).toBe(true);
  });

  it('meConsentSchema: no consent yet', () => {
    const parsed = meConsentSchema.parse({
      current_version: PRIVACY_POLICY_VERSION,
      accepted_version: null,
      accepted_at: null,
      accepted: false,
      policy_url: null,
    });
    expect(parsed.accepted).toBe(false);
  });

  it('meConsentAcceptSchema rejects non-date version', () => {
    expect(() => meConsentAcceptSchema.parse({ version: 'v1' })).toThrow();
  });

  it('meDeleteSchema requires email confirm', () => {
    expect(meDeleteSchema.parse({ confirm: 'pilot@example.com' }).confirm).toBe(
      'pilot@example.com',
    );
    expect(() => meDeleteSchema.parse({ confirm: 'not-an-email' })).toThrow();
    expect(() => meDeleteSchema.parse({})).toThrow();
  });

  it('meExportSchema rejects secrets-shaped extras and accepts track_points/policy_url', () => {
    const base = {
      schema_version: 1 as const,
      exported_at: '2026-10-01T12:00:00.000Z',
      user: {
        id: '123e4567-e89b-42d3-a456-426614174000',
        email: 'pilot@example.com',
        display_name: 'Pilot',
        locale: 'ru',
        handle: null,
        role: 'user' as const,
        plan_code: 'free',
        ai_enabled: false,
        email_verified: true,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      consent: {
        current_version: PRIVACY_POLICY_VERSION,
        accepted_version: null,
        accepted_at: null,
        accepted: false,
        policy_url: null,
      },
      devices: [],
      flights: [],
      ai_reports: [],
      share_links: [],
    };
    // Дефолты backward-compat: старый потребитель без новых полей парсится.
    const legacy = meExportSchema.parse(base);
    expect(legacy.track_points_included).toBe(false);
    expect(legacy.track_points).toEqual([]);
    expect(legacy.policy_url).toBeNull();

    const full = meExportSchema.parse({
      ...base,
      policy_url: 'https://example.com/privacy',
      track_points_included: true,
      track_points: [
        {
          flight_id: '223e4567-e89b-42d3-a456-426614174000',
          ts: '2026-09-01T10:00:00.000Z',
          lat: 55.972,
          lon: 37.414,
          altitude_ft: 850,
          on_ground: false,
          groundspeed_kt: 145,
        },
      ],
    });
    expect(full.track_points_included).toBe(true);
    expect(full.track_points).toHaveLength(1);
    expect(full.policy_url).toBe('https://example.com/privacy');

    expect(() =>
      meExportSchema.parse({
        ...base,
        user: { ...base.user, password_hash: 'x' },
      }),
    ).toThrow();
    expect(() =>
      meExportSchema.parse({
        ...base,
        track_points: [{ flight_id: 'not-a-uuid', ts: 'x' }],
      }),
    ).toThrow();
  });
});
