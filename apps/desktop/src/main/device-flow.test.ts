import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceFlow, type DeviceFlowOptions } from './device-flow';

function makeFlow(overrides: Partial<DeviceFlowOptions> = {}) {
  const callbacks = {
    showWindow: vi.fn(),
    setTrayUserCode: vi.fn(),
    publishStatus: vi.fn(),
    notifyPending: vi.fn(),
    onAuthorized: vi.fn(),
    locale: () => 'ru' as const,
    isWindowVisible: () => true,
  };
  const flow = new DeviceFlow({ ...callbacks, ...overrides });
  return { flow, callbacks };
}

const INPUT = {
  user_code: 'WXYZ-1234',
  verification_uri: 'https://app.test/device',
  expires_in: 600,
};

describe('DeviceFlow — код показывается в окне, браузер открывает пользователь (T-CLIENT2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('фокусирует окно, публикует код и запускает таймер (браузер не открывает)', () => {
    const { flow, callbacks } = makeFlow();
    flow.handleUserCode(INPUT);

    expect(callbacks.showWindow).toHaveBeenCalledTimes(1);
    expect(callbacks.setTrayUserCode).toHaveBeenCalledWith('WXYZ-1234', expect.any(Number));
    const event = callbacks.publishStatus.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      state: 'auth_required',
      userCode: 'WXYZ-1234',
      verificationUri: 'https://app.test/device',
      expiresIn: 600,
    });
    expect(event.userCodeExpiresAt).toBe('2026-09-25T12:10:00.000Z');
    expect(flow.isPending()).toBe(true);
    expect(flow.state).not.toHaveProperty('inAppUrl');
  });

  it('истечение кода публикует expired и сбрасывает pending', () => {
    const { flow, callbacks } = makeFlow();
    flow.handleUserCode(INPUT);

    vi.advanceTimersByTime(600_000);

    expect(flow.isPending()).toBe(false);
    const event = callbacks.publishStatus.mock.calls.at(-1)?.[0];
    expect(event.state).toBe('auth_required');
    expect(event.message).toContain('истёк');
    expect(callbacks.setTrayUserCode).toHaveBeenLastCalledWith(
      'WXYZ-1234',
      Date.parse('2026-09-25T12:10:00.000Z'),
    );
  });

  it('isExpired отражает срок кода до срабатывания таймера (F-101)', () => {
    let now = Date.parse('2026-09-25T12:00:00.000Z');
    const { flow } = makeFlow({ now: () => now });
    expect(flow.isExpired()).toBe(false);
    flow.handleUserCode(INPUT);
    expect(flow.isExpired()).toBe(false);
    now += 600_000;
    expect(flow.isExpired()).toBe(true);
    expect(flow.isPending()).toBe(true);
  });

  it('T-CLIENT3: republish переводит активный код после смены языка', () => {
    let locale: 'ru' | 'en' = 'ru';
    const { flow, callbacks } = makeFlow({ locale: () => locale });
    flow.handleUserCode(INPUT);
    expect(callbacks.publishStatus.mock.calls.at(-1)?.[0].message).toContain('Введите код');

    locale = 'en';
    flow.republish();
    expect(callbacks.publishStatus.mock.calls.at(-1)?.[0].message).toContain('Enter code');

    flow.markAuthorized();
    const count = callbacks.publishStatus.mock.calls.length;
    flow.republish();
    expect(callbacks.publishStatus.mock.calls.length).toBe(count);
  });

  it('markAuthorized сбрасывает код и переводит окно в «привязано»', () => {
    const { flow, callbacks } = makeFlow();
    flow.handleUserCode(INPUT);
    flow.markAuthorized();

    expect(flow.isPending()).toBe(false);
    expect(callbacks.onAuthorized).toHaveBeenCalledTimes(1);
    expect(callbacks.setTrayUserCode).toHaveBeenLastCalledWith(null, null);
    // Таймер отменён: после исходного срока событий больше нет.
    const published = callbacks.publishStatus.mock.calls.length;
    vi.advanceTimersByTime(600_000);
    expect(callbacks.publishStatus.mock.calls.length).toBe(published);
  });

  it('не уведомляет, когда окно видимо; уведомляет, когда скрыто', () => {
    const visible = makeFlow({ isWindowVisible: () => true });
    visible.flow.handleUserCode(INPUT);
    expect(visible.callbacks.notifyPending).not.toHaveBeenCalled();

    const hidden = makeFlow({ isWindowVisible: () => false });
    hidden.flow.handleUserCode(INPUT);
    expect(hidden.callbacks.notifyPending).toHaveBeenCalledTimes(1);
    hidden.flow.notifyIfHidden(false);
    expect(hidden.callbacks.notifyPending).toHaveBeenCalledTimes(1);
  });
});
