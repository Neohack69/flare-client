import { describe, expect, it } from 'vitest';

import {
  DEVICE_CODE_COOLDOWN_MS,
  DEVICE_CODE_MAX_REQUESTS,
  DEVICE_CODE_WINDOW_MS,
  DeviceCodeRequestGuard,
} from './device-code-guard';

function withClock() {
  let now = 1_000_000;
  const guard = new DeviceCodeRequestGuard({ now: () => now });
  return {
    guard,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const NO_CODE = { hasPendingCode: false, codeExpired: false };
const ACTIVE_CODE = { hasPendingCode: true, codeExpired: false };
const EXPIRED_CODE = { hasPendingCode: true, codeExpired: true };

describe('DeviceCodeRequestGuard (F-101)', () => {
  it('разрешает запрос, когда кода нет', () => {
    const { guard } = withClock();
    expect(guard.tryRequest(NO_CODE)).toBe(true);
  });

  it('запрещает, пока кодpending и не истёк (рестарт бессмыслен)', () => {
    const { guard } = withClock();
    expect(guard.tryRequest(ACTIVE_CODE)).toBe(false);
  });

  it('разрешает, если код истёк', () => {
    const { guard } = withClock();
    expect(guard.tryRequest(EXPIRED_CODE)).toBe(true);
  });

  it('держит cooldown между запросами', () => {
    const { guard, advance } = withClock();
    expect(guard.tryRequest(NO_CODE)).toBe(true);
    advance(DEVICE_CODE_COOLDOWN_MS - 1);
    expect(guard.tryRequest(NO_CODE)).toBe(false);
    advance(1);
    expect(guard.tryRequest(NO_CODE)).toBe(true);
  });

  it('ограничивает число запросов за окно', () => {
    const { guard, advance } = withClock();
    for (let i = 0; i < DEVICE_CODE_MAX_REQUESTS; i += 1) {
      expect(guard.tryRequest(NO_CODE)).toBe(true);
      advance(DEVICE_CODE_COOLDOWN_MS);
    }
    // Лимит исчерпан, даже если cooldown прошёл.
    expect(guard.tryRequest(NO_CODE)).toBe(false);
    // Через окно лимит сбрасывается.
    advance(DEVICE_CODE_WINDOW_MS);
    expect(guard.tryRequest(NO_CODE)).toBe(true);
  });

  it('не тратит лимит на отказ из-за активного кода', () => {
    const { guard, advance } = withClock();
    for (let i = 0; i < 10; i += 1) {
      expect(guard.tryRequest(ACTIVE_CODE)).toBe(false);
      advance(1_000);
    }
    expect(guard.tryRequest(NO_CODE)).toBe(true);
  });
});
