import { describe, expect, it } from 'vitest';

import { pairingView } from './pairing';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');

describe('pairingView (T-CLIENT2)', () => {
  it('auth_required → не привязано, показывает код', () => {
    const view = pairingView({
      status: {
        state: 'auth_required',
        userCode: 'WXYZ-1234',
        verificationUri: 'https://tdmoment.ru/device',
        userCodeExpiresAt: new Date(NOW + 600_000).toISOString(),
      },
      account: null,
      agentRunning: true,
      recording: false,
      agentError: false,
      now: NOW,
    });
    expect(view.linked).toBe(false);
    expect(view.showDeviceCode).toBe(true);
    expect(view.deviceCode).toBe('WXYZ-1234');
    expect(view.codeExpired).toBe(false);
    expect(view.accountLabel).toBeNull();
  });

  it('истёкший код помечается, но остаётся виден до нового', () => {
    const view = pairingView({
      status: {
        state: 'auth_required',
        userCode: 'WXYZ-1234',
        userCodeExpiresAt: new Date(NOW - 1_000).toISOString(),
      },
      account: null,
      agentRunning: true,
      recording: false,
      agentError: false,
      now: NOW,
    });
    expect(view.showDeviceCode).toBe(true);
    expect(view.codeExpired).toBe(true);
  });

  it('работающий агент без auth_required → привязано, код скрыт', () => {
    const view = pairingView({
      // `authorized` — транзиентное событие, UI-состояние = подключено.
      status: { state: 'authorized', deviceId: '123e4567-e89b-42d3-a456-426614174000' },
      account: { email: 'pilot@example.com', displayName: 'Pilot', planName: 'Pro' },
      agentRunning: true,
      recording: false,
      agentError: false,
      now: NOW,
    });
    expect(view.linked).toBe(true);
    expect(view.showDeviceCode).toBe(false);
    expect(view.accountLabel).toBe('Pilot');
  });

  it('sim_waiting без deviceId не считается привязкой (эмитится до входа)', () => {
    const view = pairingView({
      status: { state: 'sim_waiting', message: 'Ожидание данных симулятора' },
      account: null,
      agentRunning: true,
      recording: false,
      agentError: false,
      now: NOW,
    });
    expect(view.linked).toBe(false);
  });

  it('sim_waiting с deviceId (токен уже загружен) → привязано', () => {
    const view = pairingView({
      status: {
        state: 'sim_waiting',
        deviceId: '123e4567-e89b-42d3-a456-426614174000',
      },
      account: null,
      agentRunning: true,
      recording: false,
      agentError: false,
      now: NOW,
    });
    expect(view.linked).toBe(true);
  });

  it('sync_error fatal (устройство отозвано) → не привязано', () => {
    const view = pairingView({
      status: {
        state: 'sync_error',
        quality: 'fatal',
        deviceId: '123e4567-e89b-42d3-a456-426614174000',
      },
      account: null,
      agentRunning: true,
      recording: false,
      agentError: false,
      now: NOW,
    });
    expect(view.linked).toBe(false);
  });

  it('до первого статуса не считаем привязанным', () => {
    const view = pairingView({
      status: null,
      account: null,
      agentRunning: true,
      recording: false,
      agentError: false,
      now: NOW,
    });
    expect(view.linked).toBe(false);
    expect(view.showDeviceCode).toBe(false);
  });

  it('агент остановлен → не привязано', () => {
    const view = pairingView({
      status: { state: 'connected_idle' },
      account: { email: 'a@b.com', displayName: null, planName: null },
      agentRunning: false,
      recording: false,
      agentError: false,
      now: NOW,
    });
    expect(view.linked).toBe(false);
    expect(view.accountLabel).toBe('a@b.com');
  });
});
