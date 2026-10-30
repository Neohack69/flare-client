import { describe, expect, it } from 'vitest';

import {
  agentStatusEventSchema,
  agentStatusStateSchema,
  desktopAccountSchema,
  desktopIpcHostToMainSchema,
  desktopIpcMainToHostSchema,
  desktopRendererCommandSchema,
  desktopRuntimeInfoSchema,
  outboxCountsSchema,
  storedTokensSchema,
} from './index';

const DEVICE_ID = '123e4567-e89b-42d3-a456-426614174000';
const FLIGHT_ID = '223e4567-e89b-42d3-a456-426614174000';
const NOW = '2026-09-24T10:12:03.000Z';

const counts = {
  flights: 1,
  points: 120,
  events: 4,
  pendingFlights: 1,
  pendingPoints: 120,
  pendingEvents: 4,
};

describe('contracts — desktop (ADR-0011)', () => {
  it('agentStatusStateSchema — закрытый набор состояний трея', () => {
    expect(agentStatusStateSchema.options).toEqual([
      'auth_required',
      'authorized',
      'sim_waiting',
      'connected_idle',
      'recording',
      'touchdown',
      'syncing',
      'sync_ok',
      'sync_error',
    ]);
    expect(agentStatusStateSchema.safeParse('starting').success).toBe(false);
  });

  it('auth:userCode — границы expires_in и https-only verification_uri (F-105)', () => {
    const base = {
      type: 'auth:userCode',
      user_code: 'WXYZ-1234',
      verification_uri: 'https://app.test/device',
      expires_in: 600,
    };
    expect(desktopIpcHostToMainSchema.safeParse(base).success).toBe(true);
    // dev-loopback http допускается, любой другой http — нет.
    expect(
      desktopIpcHostToMainSchema.safeParse({
        ...base,
        verification_uri: 'http://localhost:3001/device',
      }).success,
    ).toBe(true);
    expect(
      desktopIpcHostToMainSchema.safeParse({
        ...base,
        verification_uri: 'http://evil.example/device',
      }).success,
    ).toBe(false);
    expect(
      desktopIpcHostToMainSchema.safeParse({ ...base, verification_uri: 'javascript:alert(1)' })
        .success,
    ).toBe(false);
    expect(
      desktopIpcHostToMainSchema.safeParse({ ...base, verification_uri: 'file:///etc/passwd' })
        .success,
    ).toBe(false);
    // expires_in вне [30, 3600] отвергается.
    expect(desktopIpcHostToMainSchema.safeParse({ ...base, expires_in: 29 }).success).toBe(false);
    expect(desktopIpcHostToMainSchema.safeParse({ ...base, expires_in: 3_601 }).success).toBe(
      false,
    );
    expect(desktopIpcHostToMainSchema.safeParse({ ...base, expires_in: 0 }).success).toBe(false);
  });

  it('agentStatusEventSchema принимает полезные поля и отклоняет лишние', () => {
    const event = {
      state: 'touchdown',
      at: NOW,
      deviceId: DEVICE_ID,
      flightId: FLIGHT_ID,
      aircraftIcao: 'B738',
      pendingCounts: counts,
      lastSyncAt: NOW,
      message: 'Посадка: 84 · -180 fpm',
    };
    expect(agentStatusEventSchema.safeParse(event).success).toBe(true);
    // Явное транзиентное событие авторизации (F-102) несёт только deviceId.
    expect(
      agentStatusEventSchema.safeParse({ state: 'authorized', deviceId: DEVICE_ID }).success,
    ).toBe(true);
    expect(agentStatusEventSchema.safeParse({ ...event, token: 'secret' }).success).toBe(false);
    expect(agentStatusEventSchema.safeParse({ state: 'unknown' }).success).toBe(false);
    expect(
      agentStatusEventSchema.safeParse({ state: 'sim_waiting', message: 'x'.repeat(501) }).success,
    ).toBe(false);
  });

  it('agentStatusEventSchema принимает фактические счётчики синка (T125)', () => {
    const event = {
      state: 'sync_ok',
      at: NOW,
      pendingCounts: { ...counts, pendingFlights: 0, pendingPoints: 0, pendingEvents: 0 },
      uploadedFlights: 1,
      uploadedPoints: 12_480,
      uploadedEvents: 3,
      lastSyncAt: NOW,
    };
    expect(agentStatusEventSchema.safeParse(event).success).toBe(true);
    // Пустой интервал — нули допустимы, но отрицательные/дробные — нет.
    expect(
      agentStatusEventSchema.safeParse({
        state: 'sync_ok',
        uploadedFlights: 0,
        uploadedPoints: 0,
        uploadedEvents: 0,
      }).success,
    ).toBe(true);
    expect(agentStatusEventSchema.safeParse({ state: 'sync_ok', uploadedPoints: -1 }).success).toBe(
      false,
    );
    expect(
      agentStatusEventSchema.safeParse({ state: 'sync_ok', uploadedEvents: 1.5 }).success,
    ).toBe(false);
  });

  it('agentStatusEventSchema принимает причину синка, только из закрытого набора (T126)', () => {
    expect(
      agentStatusEventSchema.safeParse({ state: 'sync_ok', syncReason: 'manual' }).success,
    ).toBe(true);
    expect(
      agentStatusEventSchema.safeParse({ state: 'sync_ok', syncReason: 'interval' }).success,
    ).toBe(true);
    expect(
      agentStatusEventSchema.safeParse({ state: 'sync_ok', syncReason: 'desktop' }).success,
    ).toBe(false);
    expect(agentStatusEventSchema.safeParse({ state: 'sync_ok', syncReason: 1 }).success).toBe(
      false,
    );
  });

  it('agentStatusEventSchema принимает flightDiscarded (CLIENT-FLIGHT-END-FIX)', () => {
    expect(
      agentStatusEventSchema.safeParse({
        state: 'sync_ok',
        syncReason: 'other',
        flightDiscarded: true,
      }).success,
    ).toBe(true);
    // Обратная совместимость: старое событие без флага остаётся валидным.
    expect(
      agentStatusEventSchema.safeParse({ state: 'sync_ok', syncReason: 'flight_ended' }).success,
    ).toBe(true);
    expect(
      agentStatusEventSchema.safeParse({ state: 'sync_ok', flightDiscarded: 'yes' }).success,
    ).toBe(false);
  });

  it('outboxCountsSchema требует неотрицательные целые', () => {
    expect(outboxCountsSchema.safeParse(counts).success).toBe(true);
    expect(outboxCountsSchema.safeParse({ ...counts, pendingFlights: -1 }).success).toBe(false);
    expect(outboxCountsSchema.safeParse({ ...counts, pendingFlights: 1.5 }).success).toBe(false);
  });

  it('desktopIpcMainToHostSchema различает каналы старта/стопа/синка', () => {
    expect(
      desktopIpcMainToHostSchema.safeParse({
        type: 'agent:start',
        config: {
          apiUrl: 'https://api.test',
          outboxPath: 'C:/data/outbox.sqlite',
          clientName: 'Touchdown Moment Agent',
          platform: 'win32',
          protocol: 'sunrise',
          maxSampleHz: 10,
        },
      }).success,
    ).toBe(true);
    expect(desktopIpcMainToHostSchema.safeParse({ type: 'agent:stop' }).success).toBe(true);
    expect(desktopIpcMainToHostSchema.safeParse({ type: 'agent:sync' }).success).toBe(true);
    expect(desktopIpcMainToHostSchema.safeParse({ type: 'unknown' }).success).toBe(false);
  });

  it('desktopIpcHostToMainSchema валидирует status/log/auth/token', () => {
    expect(
      desktopIpcHostToMainSchema.safeParse({
        type: 'status',
        event: { state: 'recording', flightId: FLIGHT_ID, pendingCounts: counts },
      }).success,
    ).toBe(true);
    expect(
      desktopIpcHostToMainSchema.safeParse({
        type: 'auth:userCode',
        user_code: 'WXYZ-1234',
        verification_uri: 'https://app.test/device',
        expires_in: 600,
      }).success,
    ).toBe(true);
    expect(
      desktopIpcHostToMainSchema.safeParse({
        type: 'token:save',
        reqId: 1,
        tokens: {
          access_token: 'a',
          device_token: 'd',
          device_id: DEVICE_ID,
        },
      }).success,
    ).toBe(true);
    expect(
      desktopIpcHostToMainSchema.safeParse({
        type: 'log',
        level: 'info',
        message: 'hello',
        token: 'secret',
      }).success,
    ).toBe(false);
  });

  it('storedTokensSchema принимает optional access_expires_at', () => {
    expect(
      storedTokensSchema.safeParse({
        access_token: 'a',
        device_token: 'd',
        device_id: DEVICE_ID,
        access_expires_at: NOW,
      }).success,
    ).toBe(true);
    expect(
      storedTokensSchema.safeParse({ access_token: 'a', device_token: 'd', device_id: 'nope' })
        .success,
    ).toBe(false);
  });

  it('desktopRendererCommandSchema — allowlist preload-команд', () => {
    for (const command of [
      'start-agent',
      'stop-agent',
      'sync-now',
      'open-about',
      'open-site',
      'open-logs',
      'copy-diagnostics',
      'check-updates',
      'open-device-browser',
      'copy-user-code',
      'request-device-code',
      'enable-error-reporting',
      'disable-error-reporting',
    ]) {
      expect(desktopRendererCommandSchema.safeParse(command).success).toBe(true);
    }
    expect(desktopRendererCommandSchema.safeParse('eval').success).toBe(false);
    expect(desktopRendererCommandSchema.safeParse('shell').success).toBe(false);
    expect(desktopRendererCommandSchema.safeParse('open-device').success).toBe(false);
  });

  it('desktopAccountSchema — аккаунт привязки без токенов', () => {
    expect(
      desktopAccountSchema.safeParse({
        email: 'pilot@example.com',
        displayName: 'Pilot',
        planName: 'Pro',
      }).success,
    ).toBe(true);
    expect(
      desktopAccountSchema.safeParse({ email: null, displayName: null, planName: null }).success,
    ).toBe(true);
    expect(
      desktopAccountSchema.safeParse({
        email: 'pilot@example.com',
        displayName: null,
        planName: null,
        token: 'x',
      }).success,
    ).toBe(false);
    expect(
      desktopAccountSchema.safeParse({ email: 'not-an-email', displayName: null, planName: null })
        .success,
    ).toBe(false);
  });

  it('agentStatusEventSchema принимает аддитивные поля touchdown/устройства', () => {
    const event = {
      state: 'touchdown',
      aircraftIcao: 'B738',
      clientFlightId: FLIGHT_ID,
      score: 87,
      grade: 'good',
      vsFpm: -142.4,
      bounceCount: 0,
      touchAndGo: false,
      deviceName: 'HOME-PC',
      agentVersion: '0.1.0',
      protocol: 'sunrise',
      quality: 'retryable',
    };
    expect(agentStatusEventSchema.safeParse(event).success).toBe(true);
    expect(agentStatusEventSchema.safeParse({ ...event, score: 101 }).success).toBe(false);
    expect(agentStatusEventSchema.safeParse({ ...event, grade: 'epic' }).success).toBe(false);
    expect(agentStatusEventSchema.safeParse({ ...event, quality: 'weird' }).success).toBe(false);
    expect(agentStatusEventSchema.safeParse({ ...event, protocol: 'fs2024' }).success).toBe(false);
  });

  it('agentStatusEventSchema принимает last-landing поля (T115)', () => {
    const event = {
      state: 'connected_idle',
      aircraftIcao: 'B738',
      clientFlightId: FLIGHT_ID,
      landingSeq: 2,
      lastLandingAt: NOW,
      score: 91,
      grade: 'butter',
      vsFpm: -98.5,
      bounceCount: 0,
      touchAndGo: false,
    };
    expect(agentStatusEventSchema.safeParse(event).success).toBe(true);
    // Старое событие без полей последней посадки остаётся валидным.
    expect(agentStatusEventSchema.safeParse({ state: 'sim_waiting' }).success).toBe(true);
    expect(agentStatusEventSchema.safeParse({ ...event, landingSeq: 0 }).success).toBe(false);
    expect(agentStatusEventSchema.safeParse({ ...event, landingSeq: 1.5 }).success).toBe(false);
    expect(agentStatusEventSchema.safeParse({ ...event, lastLandingAt: 'yesterday' }).success).toBe(
      false,
    );
  });

  it('agentStatusEventSchema принимает sim-статус и heartbeat (SIM-STATUS-1)', () => {
    const event = {
      state: 'recording',
      sim: 'xplane12',
      simConnected: true,
      simPinned: false,
      simVersion: '12.1.4',
      simTransport: 'xp-udp-rref',
      simTransportDegraded: true,
      simSearching: false,
      lastSampleAt: NOW,
      retryInS: 30,
      flightStartedAt: NOW,
      heartbeat: true,
    };
    expect(agentStatusEventSchema.safeParse(event).success).toBe(true);
    // Старые события без этих полей остаются валидными (аддитивность).
    expect(agentStatusEventSchema.safeParse({ state: 'sim_waiting' }).success).toBe(true);
    expect(agentStatusEventSchema.safeParse({ ...event, sim: 'p3d' }).success).toBe(false);
    expect(agentStatusEventSchema.safeParse({ ...event, retryInS: 0 }).success).toBe(false);
    expect(agentStatusEventSchema.safeParse({ ...event, retryInS: 1.5 }).success).toBe(false);
    expect(agentStatusEventSchema.safeParse({ ...event, lastSampleAt: 'yesterday' }).success).toBe(
      false,
    );
    expect(agentStatusEventSchema.safeParse({ ...event, heartbeat: 'yes' }).success).toBe(false);
  });

  it('agentStatusEventSchema принимает device-flow поля (T116)', () => {
    const event = {
      state: 'auth_required',
      userCode: 'WXYZ-1234',
      verificationUri: 'https://app.test/device',
      expiresIn: 600,
      userCodeExpiresAt: NOW,
    };
    expect(agentStatusEventSchema.safeParse(event).success).toBe(true);
    expect(agentStatusEventSchema.safeParse({ ...event, userCode: 'nope' }).success).toBe(false);
    expect(agentStatusEventSchema.safeParse({ ...event, expiresIn: 0 }).success).toBe(false);
    expect(
      agentStatusEventSchema.safeParse({ ...event, verificationUri: 'not-a-url' }).success,
    ).toBe(false);
  });

  it('desktopIpcMainToHostSchema принимает agent:restart', () => {
    expect(
      desktopIpcMainToHostSchema.safeParse({
        type: 'agent:restart',
        config: {
          apiUrl: 'https://api.test',
          outboxPath: 'C:/data/outbox.sqlite',
          clientName: 'Touchdown Moment Agent',
          platform: 'win32',
          protocol: 'sunrise',
          maxSampleHz: 10,
        },
      }).success,
    ).toBe(true);
  });

  it('desktopRuntimeInfoSchema — версии/устройство без токенов', () => {
    const info = {
      appVersion: '0.1.0',
      agentVersion: '0.1.0',
      electron: '33.0.0',
      node: '22.0.0',
      chromium: '130.0.0',
      protocol: 'sunrise',
      channel: 'latest',
      deviceId: DEVICE_ID,
      deviceName: 'HOME-PC',
      agentRunning: true,
      locale: 'ru',
      openStatusHotkey: 'Ctrl+Alt+T',
      errorReporting: { configured: false, enabled: false },
    };
    expect(desktopRuntimeInfoSchema.safeParse(info).success).toBe(true);
    expect(desktopRuntimeInfoSchema.safeParse({ ...info, token: 'secret' }).success).toBe(false);
    expect(desktopRuntimeInfoSchema.safeParse({ ...info, locale: 'de' }).success).toBe(false);
    expect(
      desktopRuntimeInfoSchema.safeParse({
        ...info,
        errorReporting: { configured: true },
      }).success,
    ).toBe(false);
  });
});
