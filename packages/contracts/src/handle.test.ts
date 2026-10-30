import { describe, expect, it } from 'vitest';

import { errorCodesSchema } from './errors.js';
import {
  HANDLE_MAX,
  HANDLE_MIN,
  handleAvailabilityQuerySchema,
  handleAvailabilityReasonSchema,
  handleSchema,
  isReservedHandle,
  RESERVED_HANDLES,
  userRoleSchema,
} from './handle.js';

describe('handleSchema (ADR-0020 §3 / T-IDN1)', () => {
  it('принимает валидный формат 3–20: [a-z][a-z0-9_]*', () => {
    expect(handleSchema.parse('abc')).toBe('abc');
    expect(handleSchema.parse('neohack')).toBe('neohack');
    expect(handleSchema.parse('a1_')).toBe('a1_');
    expect(handleSchema.parse('a'.repeat(HANDLE_MAX))).toBe('a'.repeat(HANDLE_MAX));
    expect(handleSchema.parse(`pilot_${'x'.repeat(13)}`)).toBe(`pilot_${'x'.repeat(13)}`);
  });

  it('нормализует регистр и trim', () => {
    expect(handleSchema.parse('NeoHack')).toBe('neohack');
    expect(handleSchema.parse('  Ace_01  ')).toBe('ace_01');
    expect(handleSchema.parse('ADMIN')).toBe('admin');
  });

  it('отклоняет слишком короткий / длинный / пустой', () => {
    expect(handleSchema.safeParse('ab').success).toBe(false);
    expect(handleSchema.safeParse('a'.repeat(HANDLE_MIN - 1)).success).toBe(false);
    expect(handleSchema.safeParse('a'.repeat(HANDLE_MAX + 1)).success).toBe(false);
    expect(handleSchema.safeParse('').success).toBe(false);
    expect(handleSchema.safeParse('   ').success).toBe(false);
  });

  it('отклоняет неверный формат (цифры в начале, кириллица, @, пробел, дефис)', () => {
    expect(handleSchema.safeParse('1abc').success).toBe(false);
    expect(handleSchema.safeParse('_abc').success).toBe(false);
    expect(handleSchema.safeParse('неохак').success).toBe(false);
    expect(handleSchema.safeParse('@neohack').success).toBe(false);
    expect(handleSchema.safeParse('neo hack').success).toBe(false);
    expect(handleSchema.safeParse('neo-hack').success).toBe(false);
    expect(handleSchema.safeParse('neo.hack').success).toBe(false);
  });
});

describe('RESERVED_HANDLES / isReservedHandle', () => {
  it('содержит минимум из ADR-0020 §3.2', () => {
    for (const name of [
      'admin',
      'support',
      'tdmoment',
      'touchdown',
      'touchdownmoment',
      'flightlog',
      'avsim',
      'me',
      'null',
      'undefined',
      'root',
      'api',
      'login',
      'register',
    ]) {
      expect(RESERVED_HANDLES.has(name)).toBe(true);
      expect(isReservedHandle(name)).toBe(true);
    }
  });

  it('проверка регистронезависима', () => {
    expect(isReservedHandle('Admin')).toBe(true);
    expect(isReservedHandle('  SUPPORT  ')).toBe(true);
    expect(isReservedHandle('NeoHack')).toBe(false);
  });

  it('обычные пилотские теги не в резерве', () => {
    expect(isReservedHandle('neohack')).toBe(false);
    expect(isReservedHandle('pilot_01')).toBe(false);
  });
});

describe('userRoleSchema / handleAvailabilityReasonSchema', () => {
  it('роль — только user|admin', () => {
    expect(userRoleSchema.safeParse('user').success).toBe(true);
    expect(userRoleSchema.safeParse('admin').success).toBe(true);
    expect(userRoleSchema.safeParse('moderator').success).toBe(false);
  });

  it('причины недоступности — фиксированный набор', () => {
    for (const reason of ['taken', 'reserved', 'recently_released', 'invalid']) {
      expect(handleAvailabilityReasonSchema.safeParse(reason).success).toBe(true);
    }
    expect(handleAvailabilityReasonSchema.safeParse('cooldown').success).toBe(false);
  });
});

describe('handleAvailabilityQuerySchema', () => {
  it('требует строку handle (сырую; формат проверяет сервис)', () => {
    expect(handleAvailabilityQuerySchema.parse({ handle: 'NeoHack' })).toEqual({
      handle: 'NeoHack',
    });
    expect(handleAvailabilityQuerySchema.parse({ handle: '1bad' })).toEqual({ handle: '1bad' });
    expect(handleAvailabilityQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe('handle error codes в errorCodesSchema (ADR-0020 §10.3)', () => {
  it('включает HANDLE_* и ADMIN_REAUTH_REQUIRED / ADMIN_TOTP_REQUIRED', () => {
    for (const code of [
      'HANDLE_TAKEN',
      'HANDLE_RESERVED',
      'HANDLE_CHANGE_COOLDOWN',
      'ADMIN_REAUTH_REQUIRED',
      'ADMIN_TOTP_REQUIRED',
    ]) {
      expect(errorCodesSchema.options).toContain(code);
      expect(errorCodesSchema.safeParse(code).success).toBe(true);
    }
  });
});
