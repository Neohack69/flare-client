import { describe, expect, it } from 'vitest';

import { DEFAULT_USER_UNITS, meSchema, meUpdateSchema, userUnitsSchema } from './me.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = '2026-09-23T12:34:56Z';

function meFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: UUID,
    email: 'pilot@example.com',
    display_name: 'Ace',
    locale: 'ru',
    timezone: null,
    units: null,
    created_at: NOW,
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
      period_start: NOW,
      history_days_used: 0,
    },
    entitlements: {
      unlimited: false,
      ai_granted: false,
      ai_available: false,
      clubs_enabled: false,
      exports_enabled: false,
    },
    email_verified: true,
    pending_email: null,
    handle: null,
    role: 'user',
    handle_changed_at: null,
    handle_can_change_at: null,
    leaderboard_visible: true,
    leaderboard_name_mode: 'tag',
    ...overrides,
  };
}

describe('meSchema — identity fields (ADR-0020 / T-IDN1)', () => {
  it('принимает handle=null (существующие пользователи без тега)', () => {
    expect(meSchema.safeParse(meFixture()).success).toBe(true);
  });

  it('принимает нормализованный handle и cooldown-поля', () => {
    const parsed = meSchema.safeParse(
      meFixture({
        handle: 'neohack',
        role: 'admin',
        handle_changed_at: NOW,
        handle_can_change_at: '2026-10-23T12:34:56Z',
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.handle).toBe('neohack');
      expect(parsed.data.role).toBe('admin');
    }
  });

  it('нормализует регистр handle в ответе', () => {
    expect(meSchema.parse(meFixture({ handle: 'NeoHack' })).handle).toBe('neohack');
  });

  it('отклоняет невалидный handle', () => {
    expect(meSchema.safeParse(meFixture({ handle: '1bad' })).success).toBe(false);
  });
});

describe('meUpdateSchema — PATCH /v1/me (T41 кр.9 / ADR-0020)', () => {
  it('принимает display_name и locale (ru|en)', () => {
    expect(meUpdateSchema.safeParse({ display_name: 'Ace Pilot' }).success).toBe(true);
    expect(meUpdateSchema.safeParse({ locale: 'en' }).success).toBe(true);
    expect(meUpdateSchema.safeParse({ display_name: 'Ace', locale: 'ru' }).success).toBe(true);
    // whitespace collapse + trim (ADR-0020 §2.1)
    expect(meUpdateSchema.parse({ display_name: '  Ace  ' }).display_name).toBe('Ace');
    expect(meUpdateSchema.parse({ display_name: 'Ace   Pilot' }).display_name).toBe('Ace Pilot');
  });

  it('принимает handle (нормализация регистра)', () => {
    expect(meUpdateSchema.safeParse({ handle: 'neohack' }).success).toBe(true);
    expect(meUpdateSchema.parse({ handle: 'NeoHack' }).handle).toBe('neohack');
    expect(meUpdateSchema.safeParse({ handle: 'neohack', display_name: 'Ace' }).success).toBe(true);
  });

  it('отклоняет невалидный handle и резерв не проверяет на уровне Zod', () => {
    expect(meUpdateSchema.safeParse({ handle: '1bad' }).success).toBe(false);
    // reserved — бизнес-правило сервиса (422 HANDLE_RESERVED), Zod принимает формат
    expect(meUpdateSchema.safeParse({ handle: 'admin' }).success).toBe(true);
  });

  it('пустое тело → 422-ошибка', () => {
    expect(meUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('неизвестное поле отклоняется (strict, без mass-assignment)', () => {
    const parsed = meUpdateSchema.safeParse({ display_name: 'Ace', plan_code: 'unlimited' });
    expect(parsed.success).toBe(false);
    expect(meUpdateSchema.safeParse({ display_name: 'Ace', role: 'admin' }).success).toBe(false);
  });

  it('locale — только ru|en', () => {
    expect(meUpdateSchema.safeParse({ locale: 'de' }).success).toBe(false);
  });

  it('принимает timezone (IANA) и null (сброс на UTC)', () => {
    expect(meUpdateSchema.safeParse({ timezone: 'Europe/Moscow' }).success).toBe(true);
    expect(meUpdateSchema.parse({ timezone: 'Europe/Moscow' }).timezone).toBe('Europe/Moscow');
    expect(meUpdateSchema.safeParse({ timezone: null }).success).toBe(true);
    // Реальность зоны — серверная проверка (`Intl`), здесь только формат.
    expect(meUpdateSchema.safeParse({ timezone: 'Not/AZone' }).success).toBe(true);
    expect(meUpdateSchema.safeParse({ timezone: '' }).success).toBe(false);
    expect(meUpdateSchema.safeParse({ timezone: 'a'.repeat(65) }).success).toBe(false);
  });

  it('display_name не пустой и ≤64 символов', () => {
    expect(meUpdateSchema.safeParse({ display_name: '   ' }).success).toBe(false);
    expect(meUpdateSchema.safeParse({ display_name: 'a'.repeat(65) }).success).toBe(false);
    expect(meUpdateSchema.safeParse({ display_name: 'a'.repeat(64) }).success).toBe(true);
  });

  it('настройки лидерборда: boolean и tag|name, прочее — 422', () => {
    expect(meUpdateSchema.safeParse({ leaderboard_visible: false }).success).toBe(true);
    expect(meUpdateSchema.safeParse({ leaderboard_name_mode: 'name' }).success).toBe(true);
    expect(meUpdateSchema.safeParse({ leaderboard_name_mode: 'tag' }).success).toBe(true);
    expect(meUpdateSchema.safeParse({ leaderboard_name_mode: 'other' }).success).toBe(false);
    expect(meUpdateSchema.safeParse({ leaderboard_visible: 'yes' }).success).toBe(false);
  });
});

describe('meSchema — настройки лидерборда (L1)', () => {
  it('обязательные поля: visible и режим имени', () => {
    expect(meSchema.safeParse(meFixture()).success).toBe(true);
    const withoutVisible: Record<string, unknown> = meFixture();
    delete withoutVisible.leaderboard_visible;
    expect(meSchema.safeParse(withoutVisible).success).toBe(false);
  });
});

describe('meSchema — units (WAVE 3a)', () => {
  it('DEFAULT_USER_UNITS = metric (явный дефолт для NULL/свежего пользователя)', () => {
    expect(DEFAULT_USER_UNITS).toBe('metric');
    expect(userUnitsSchema.parse(DEFAULT_USER_UNITS)).toBe('metric');
  });

  it('принимает null (не задано, поведение по умолчанию metric)', () => {
    expect(meSchema.safeParse(meFixture({ units: null })).success).toBe(true);
  });

  it('принимает metric/imperial и отклоняет прочие значения', () => {
    expect(meSchema.parse(meFixture({ units: 'metric' })).units).toBe('metric');
    expect(meSchema.parse(meFixture({ units: 'imperial' })).units).toBe('imperial');
    expect(meSchema.safeParse(meFixture({ units: 'si' })).success).toBe(false);
    expect(meSchema.safeParse(meFixture({ units: 'METRIC' })).success).toBe(false);
  });
});

describe('meUpdateSchema — units (WAVE 3a)', () => {
  it('принимает metric/imperial в PATCH', () => {
    expect(meUpdateSchema.safeParse({ units: 'metric' }).success).toBe(true);
    expect(meUpdateSchema.parse({ units: 'imperial' }).units).toBe('imperial');
  });

  it('невалидный enum → ошибка (сервер отдаёт 422)', () => {
    expect(meUpdateSchema.safeParse({ units: 'si' }).success).toBe(false);
    expect(meUpdateSchema.safeParse({ units: 'imperial', plan_code: 'pro' }).success).toBe(false);
  });

  it('userUnitsSchema содержит ровно metric и imperial', () => {
    expect(userUnitsSchema.options).toEqual(['metric', 'imperial']);
  });
});

describe('agentMeSchema (iter77, additive)', () => {
  it('принимает Pro и trial', async () => {
    const { agentMeSchema } = await import('./me.js');
    const parsed = agentMeSchema.parse({
      plan: {
        code: 'pro',
        name: 'Pro',
        trial: {
          active: true,
          ends_at: '2026-10-20T12:00:00.000Z',
          days_left: 3,
          ai_reports_remaining: 2,
        },
      },
    });
    expect(parsed.plan.trial?.days_left).toBe(3);
  });

  it('trial аддитивен: без него тоже валиден; PII не входит', async () => {
    const { agentMeSchema } = await import('./me.js');
    expect(agentMeSchema.parse({ plan: { code: 'free', name: 'Free' } })).toEqual({
      plan: { code: 'free', name: 'Free' },
    });
    expect(
      agentMeSchema.safeParse({
        plan: { code: 'pro', name: 'Pro', email: 'pilot@example.com' },
      }).success,
    ).toBe(false);
  });
});
