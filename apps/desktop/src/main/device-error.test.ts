import { describe, expect, it } from 'vitest';

import { classifyDeviceIssue } from './device-error';

describe('classifyDeviceIssue (CD-4.3)', () => {
  it('распознаёт 409 DEVICE_LIMIT_REACHED', () => {
    expect(classifyDeviceIssue('409 DEVICE_LIMIT_REACHED: limit 2, revoke an old device')).toBe(
      'device-limit',
    );
    expect(classifyDeviceIssue('device_limit_reached')).toBe('device-limit');
  });

  it('распознаёт MACHINE_MISMATCH', () => {
    expect(classifyDeviceIssue('403 MACHINE_MISMATCH')).toBe('machine-mismatch');
  });

  it('прочие/пустые сообщения — null', () => {
    expect(classifyDeviceIssue('network error')).toBeNull();
    expect(classifyDeviceIssue('')).toBeNull();
    expect(classifyDeviceIssue(null)).toBeNull();
    expect(classifyDeviceIssue(undefined)).toBeNull();
  });
});
