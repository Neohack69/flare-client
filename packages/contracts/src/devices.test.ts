import { describe, expect, it } from 'vitest';

import { errorCodesSchema } from './errors.js';
import {
  meDeviceSchema,
  meDeviceUpdateSchema,
  meDevicesDataSchema,
  meDevicesIncludeSchema,
} from './devices.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

function device(overrides: Record<string, unknown> = {}) {
  return {
    id: UUID,
    name: 'Home PC',
    platform: 'win32',
    source: 'msfs-plugin',
    agent_version: '0.1.13',
    status: 'active',
    machine_bound: false,
    is_current: false,
    created_at: '2026-09-01T10:00:00.000Z',
    approved_at: '2026-09-01T10:00:01.000Z',
    last_seen_at: '2026-09-29T08:00:00.000Z',
    revoked_at: null,
    device_token_expires_at: '2026-12-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('meDeviceSchema (ADR-0018 §8.2)', () => {
  it('принимает полный ответ устройства', () => {
    expect(meDeviceSchema.safeParse(device()).success).toBe(true);
  });

  it('никогда не отдаёт наружу секреты/хэши (strict whitelist)', () => {
    for (const leak of ['token_hash', 'device_code_hash', 'machine_hash', 'user_code', 'ip']) {
      expect(meDeviceSchema.safeParse(device({ [leak]: 'secret' })).success).toBe(false);
    }
  });

  it('статус — только из фиксированного набора', () => {
    for (const status of ['active', 'stale', 'archived', 'revoked']) {
      expect(meDeviceSchema.safeParse(device({ status })).success).toBe(true);
    }
    expect(meDeviceSchema.safeParse(device({ status: 'pending' })).success).toBe(false);
    expect(meDeviceSchema.safeParse(device({ status: 'denied' })).success).toBe(false);
  });
});

describe('meDevicesDataSchema', () => {
  it('limit=null означает безлимит', () => {
    const parsed = meDevicesDataSchema.parse({ limit: null, active: 7, items: [device()] });
    expect(parsed.limit).toBeNull();
  });

  it('активные устройства считаются в active', () => {
    expect(meDevicesDataSchema.safeParse({ limit: 2, active: 2, items: [] }).success).toBe(true);
  });
});

describe('meDevicesIncludeSchema', () => {
  it('по умолчанию active, чужие значения — 422', () => {
    expect(meDevicesIncludeSchema.parse(undefined)).toBe('active');
    expect(meDevicesIncludeSchema.safeParse('all').success).toBe(true);
    expect(meDevicesIncludeSchema.safeParse('revoked').success).toBe(true);
    expect(meDevicesIncludeSchema.safeParse('pending').success).toBe(false);
  });
});

describe('meDeviceUpdateSchema', () => {
  it('trim и границы 1..64', () => {
    expect(meDeviceUpdateSchema.parse({ name: '  Home PC  ' }).name).toBe('Home PC');
    expect(meDeviceUpdateSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(meDeviceUpdateSchema.safeParse({ name: 'a'.repeat(65) }).success).toBe(false);
    expect(meDeviceUpdateSchema.safeParse({ name: 'a'.repeat(64) }).success).toBe(true);
  });

  it('запрещает управляющие символы', () => {
    expect(meDeviceUpdateSchema.safeParse({ name: 'Home\u0000PC' }).success).toBe(false);
    expect(meDeviceUpdateSchema.safeParse({ name: 'Home\nPC' }).success).toBe(false);
  });

  it('strict: лишние поля → ошибка (без mass-assignment)', () => {
    expect(meDeviceUpdateSchema.safeParse({ name: 'Home PC', user_id: UUID }).success).toBe(false);
  });
});

describe('DEVICE_CODE_ALREADY_USED в errorCodesSchema (T-PAIRUX2)', () => {
  it('код присутствует и принимается problem detail', () => {
    expect(errorCodesSchema.options).toContain('DEVICE_CODE_ALREADY_USED');
    expect(errorCodesSchema.safeParse('DEVICE_CODE_ALREADY_USED').success).toBe(true);
  });
});
