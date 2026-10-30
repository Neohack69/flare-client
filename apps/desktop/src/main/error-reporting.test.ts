import { describe, expect, it, vi } from 'vitest';

import { clientErrorIngestSchema } from '@flightlog/contracts';

import {
  buildClientErrorPayload,
  buildDiagnosticsReport,
  DIAGNOSTICS_LOG_TAIL_MAX,
  initErrorReporting,
  redactDiagnosticsText,
  resolveErrorReporting,
  sendClientErrorReport,
} from './error-reporting';

describe('resolveErrorReporting (T118)', () => {
  it('без DSN — не настроено, ничего не отправляем даже с согласием', () => {
    expect(resolveErrorReporting(null, true)).toEqual({ configured: false, enabled: false });
    expect(resolveErrorReporting('   ', true)).toEqual({ configured: false, enabled: false });
  });

  it('DSN есть, но согласия нет — выключено (opt-in по умолчанию)', () => {
    expect(resolveErrorReporting('https://key@glitchtip.test/1', false)).toEqual({
      configured: true,
      enabled: false,
    });
  });

  it('DSN есть и согласие дано — подключено', () => {
    expect(resolveErrorReporting('https://key@glitchtip.test/1', true)).toEqual({
      configured: true,
      enabled: true,
    });
  });
});

describe('initErrorReporting — каркас', () => {
  it('без DSN молчит', () => {
    const log = vi.fn();
    initErrorReporting(resolveErrorReporting(null, true), log);
    expect(log).not.toHaveBeenCalled();
  });

  it('с DSN логирует состояние, но не отправляет ПД', () => {
    const log = vi.fn();
    initErrorReporting(resolveErrorReporting('https://key@glitchtip.test/1', true), log);
    expect(log).toHaveBeenCalledWith('error reporting enabled (scaffold)');
  });
});

describe('W1b: диагностика для POST /v1/client-errors', () => {
  const input = {
    appVersion: '0.3.22',
    agentVersion: '0.1.4',
    os: 'win32 10.0.22631 x64',
    locale: 'ru',
    logs: [
      '2026-10-20T10:00:00.000Z INFO agent starting',
      'token=super-secret-value',
      'user pilot@example.com',
      'file=C:\\Users\\Igor\\AppData\\Roaming\\Flare\\agent\\client.log',
      'posix=/home/igor/flare/client.log',
      'Bearer abcdefghijklmnop',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123',
    ],
  };

  it('вырезает e-mail, токены и пути из отчёта', () => {
    const report = buildDiagnosticsReport(input);
    expect(report).toContain('app=0.3.22');
    expect(report).toContain('core=0.1.4');
    expect(report).toContain('os=win32 10.0.22631 x64');
    expect(report).toContain('locale=ru');
    expect(report).not.toContain('pilot@example.com');
    expect(report).not.toContain('super-secret-value');
    expect(report).not.toContain('C:\\Users');
    expect(report).not.toContain('/home/igor');
    expect(report).not.toContain('eyJhbGci');
    expect(report).toContain('[email]');
    expect(report).toContain('[path]');
  });

  it('payload: desktop + версии, хвост лога ≤16 КБ, без ПДн', () => {
    const longLogs = Array.from({ length: 400 }, (_, index) => `line ${index} ${'x'.repeat(120)}`);
    const payload = buildClientErrorPayload({ ...input, logs: longLogs });
    expect(payload.source).toBe('desktop');
    expect(payload.release).toBe('0.3.22');
    expect(payload.context).toMatchObject({
      app_version: '0.3.22',
      agent_version: '0.1.4',
      os: 'win32 10.0.22631 x64',
      locale: 'ru',
    });
    expect((payload.stack ?? '').length).toBeLessThanOrEqual(16 * 1024);
    expect(payload.message.length).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(payload)).not.toContain('pilot@example.com');
    expect(clientErrorIngestSchema.safeParse(payload).success).toBe(true);
  });

  it('хвост лога ограничен 16 КБ', () => {
    const logs = ['HEAD', ...Array.from({ length: 500 }, () => 'y'.repeat(100))];
    const report = buildDiagnosticsReport({ ...input, logs });
    expect(report).not.toContain('HEAD');
    expect(report.length).toBeLessThanOrEqual(DIAGNOSTICS_LOG_TAIL_MAX + 200);
  });

  it('redact не трогает обычные URL и версии', () => {
    expect(redactDiagnosticsText('api=https://api.flyflare.ru/v1/healthz')).toBe(
      'api=https://api.flyflare.ru/v1/healthz',
    );
  });

  it('send: 204 → true, сетевой сбой → false', async () => {
    const ok = vi.fn(async () => ({ ok: true }) as Response);
    await expect(
      sendClientErrorReport({
        endpoint: 'https://api.test/v1/client-errors',
        payload: buildClientErrorPayload(input),
        fetchImpl: ok as unknown as typeof fetch,
      }),
    ).resolves.toBe(true);
    expect(ok).toHaveBeenCalledWith(
      'https://api.test/v1/client-errors',
      expect.objectContaining({ method: 'POST' }),
    );

    const fail = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(
      sendClientErrorReport({
        endpoint: 'https://api.test/v1/client-errors',
        payload: buildClientErrorPayload(input),
        fetchImpl: fail as unknown as typeof fetch,
      }),
    ).resolves.toBe(false);
  });
});
