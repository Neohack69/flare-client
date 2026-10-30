import { describe, expect, it } from 'vitest';

import { createConsoleLogger, parseLogLevel, redactRecord } from './logger.js';

class CapturingWriter {
  public readonly chunks: string[] = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  get text(): string {
    return this.chunks.join('');
  }
}

describe('redactRecord', () => {
  it('вырезает значения секретных ключей (рекурсивно)', () => {
    const redacted = redactRecord({
      access_token: 'secret-access',
      nested: { device_token: 'secret-device', ok: 1 },
      user_code: 'WXYZ-1234',
      items: [{ refresh_token: 'secret-refresh' }],
      token_store_path: 'C:\\tokens\\agent.json',
      api_key: 'secret-key',
    });

    expect(redacted.access_token).toBe('[redacted]');
    expect(redacted.nested).toEqual({ device_token: '[redacted]', ok: 1 });
    // user_code — не секрет, но и не должен попадать в логи (T116).
    expect(redacted.user_code).toBe('[redacted]');
    expect(redacted.items).toEqual([{ refresh_token: '[redacted]' }]);
    // Диагностические ключи (пути) не считаются секретами.
    expect(redacted.token_store_path).toBe('C:\\tokens\\agent.json');
    expect(redacted.api_key).toBe('[redacted]');
  });
});

describe('createConsoleLogger', () => {
  it('фильтрует по уровню и разделяет потоки stdout/stderr', () => {
    const out = new CapturingWriter();
    const err = new CapturingWriter();
    const logger = createConsoleLogger({
      level: 'warn',
      out,
      err,
      now: () => new Date('2026-09-24T00:00:00.000Z'),
    });

    logger.info('hidden');
    logger.warn('visible', { access_token: 'leak' });
    logger.error('failure');

    expect(out.text).toBe('');
    expect(err.text).toContain('visible');
    expect(err.text).toContain('[redacted]');
    expect(err.text).not.toContain('leak');
    expect(err.text).toContain('failure');
  });

  it('silent не пишет ничего', () => {
    const out = new CapturingWriter();
    const err = new CapturingWriter();
    const logger = createConsoleLogger({ level: 'silent', out, err });
    logger.error('nope');
    expect(out.text).toBe('');
    expect(err.text).toBe('');
  });
});

describe('parseLogLevel', () => {
  it('нормализует и подставляет fallback', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('bogus')).toBe('info');
    expect(parseLogLevel('bogus', 'warn')).toBe('warn');
  });
});
