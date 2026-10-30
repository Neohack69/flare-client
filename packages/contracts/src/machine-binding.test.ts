import { describe, expect, it } from 'vitest';

import {
  deviceCodeRequestSchema,
  deviceRefreshRequestSchema,
  deviceTokenRequestSchema,
  errorCodesSchema,
  machineIdSchema,
} from './index';

const MACHINE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('machineIdSchema (ADR-0018 §5/§8.2)', () => {
  it('принимает opaque url-safe id 16..128 и тримит', () => {
    expect(machineIdSchema.parse(MACHINE)).toBe(MACHINE);
    expect(machineIdSchema.parse(`  ${MACHINE}  `)).toBe(MACHINE);
    expect(machineIdSchema.safeParse('a'.repeat(16)).success).toBe(true);
    expect(machineIdSchema.safeParse('a'.repeat(128)).success).toBe(true);
    expect(machineIdSchema.safeParse('A1._~-abcdefghij').success).toBe(true);
  });

  it('отклоняет короткие/длинные/недопустимые символы', () => {
    expect(machineIdSchema.safeParse('a'.repeat(15)).success).toBe(false);
    expect(machineIdSchema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(machineIdSchema.safeParse('has space here!!').success).toBe(false);
    expect(machineIdSchema.safeParse('has/slash/here!!').success).toBe(false);
    expect(machineIdSchema.safeParse('').success).toBe(false);
  });
});

describe('device flow принимает опциональный machine_id (ADR-0018 §8.2)', () => {
  it('device/code: без machine_id (legacy) и с ним', () => {
    expect(
      deviceCodeRequestSchema.safeParse({ client_name: 'PC', platform: 'win32' }).success,
    ).toBe(true);
    expect(
      deviceCodeRequestSchema.safeParse({
        client_name: 'PC',
        platform: 'win32',
        machine_id: MACHINE,
      }).success,
    ).toBe(true);
    expect(
      deviceCodeRequestSchema.safeParse({
        client_name: 'PC',
        platform: 'win32',
        machine_id: 'bad',
      }).success,
    ).toBe(false);
  });

  it('device/token и device/refresh: machine_id опционален, strict сохранён', () => {
    expect(deviceTokenRequestSchema.safeParse({ device_code: 'x' }).success).toBe(true);
    expect(
      deviceTokenRequestSchema.safeParse({ device_code: 'x', machine_id: MACHINE }).success,
    ).toBe(true);
    expect(deviceRefreshRequestSchema.safeParse({ device_token: 'x' }).success).toBe(true);
    expect(
      deviceRefreshRequestSchema.safeParse({ device_token: 'x', machine_id: MACHINE }).success,
    ).toBe(true);
    // лишнее поле по-прежнему отклоняется (mass-assignment)
    expect(deviceTokenRequestSchema.safeParse({ device_code: 'x', extra: 1 }).success).toBe(false);
  });
});

describe('MACHINE_MISMATCH в errorCodesSchema', () => {
  it('код присутствует и принимается problem detail', () => {
    expect(errorCodesSchema.options).toContain('MACHINE_MISMATCH');
    expect(errorCodesSchema.safeParse('MACHINE_MISMATCH').success).toBe(true);
  });
});
