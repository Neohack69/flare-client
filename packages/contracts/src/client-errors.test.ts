import { describe, expect, it } from 'vitest';

import {
  CLIENT_ERROR_CONTEXT_KEYS_MAX,
  CLIENT_ERROR_FINGERPRINT_LENGTH,
  clientErrorFingerprint,
  clientErrorIngestSchema,
  clientErrorPath,
  firstClientErrorStackFrame,
} from './client-errors';

const STACK = [
  'Error: cannot read properties of undefined',
  '    at LandingCard.render (https://flyflare.ru/_next/static/chunks/app.js:10:42)',
  '    at div',
].join('\n');

describe('clientErrorIngestSchema', () => {
  it('принимает минимальное тело и плоский контекст', () => {
    const parsed = clientErrorIngestSchema.safeParse({
      message: 'boom',
      source: 'web',
      context: { route: '/ru/flights', retry: 2, ok: false, empty: null },
    });
    expect(parsed.success).toBe(true);
  });

  it('требует message/source и отклоняет неизвестные поля', () => {
    expect(clientErrorIngestSchema.safeParse({ message: 'boom' }).success).toBe(false);
    expect(clientErrorIngestSchema.safeParse({ source: 'desktop' }).success).toBe(false);
    expect(clientErrorIngestSchema.safeParse({ message: 'x', source: 'cli' }).success).toBe(false);
    expect(
      clientErrorIngestSchema.safeParse({ message: 'x', source: 'web', user_id: 'secret' })
        .success,
    ).toBe(false);
  });

  it('не пропускает вложенный контекст и слишком много ключей', () => {
    expect(
      clientErrorIngestSchema.safeParse({
        message: 'x',
        source: 'web',
        context: { nested: { token: 'raw' } },
      }).success,
    ).toBe(false);

    const tooMany = Object.fromEntries(
      Array.from({ length: CLIENT_ERROR_CONTEXT_KEYS_MAX + 1 }, (_, index) => [
        `k${index}`,
        index,
      ]),
    );
    expect(
      clientErrorIngestSchema.safeParse({ message: 'x', source: 'web', context: tooMany }).success,
    ).toBe(false);
  });
});

describe('clientErrorFingerprint', () => {
  it('стабилен для одинаковой ошибки и не зависит от query-string', () => {
    const first = clientErrorFingerprint({
      message: 'boom',
      stack: STACK,
      url: 'https://flyflare.ru/ru/flights?token=secret',
    });
    const second = clientErrorFingerprint({
      message: 'boom',
      stack: STACK,
      url: 'https://flyflare.ru/ru/flights?token=other',
    });
    expect(first).toBe(second);
    expect(first).toHaveLength(CLIENT_ERROR_FINGERPRINT_LENGTH);
    expect(first).toMatch(/^[0-9a-f]+$/);
  });

  it('различает сообщение, первый кадр и путь', () => {
    const base = { message: 'boom', stack: STACK, url: 'https://flyflare.ru/ru/flights' };
    const baseFingerprint = clientErrorFingerprint(base);
    expect(clientErrorFingerprint({ ...base, message: 'bang' })).not.toBe(baseFingerprint);
    expect(
      clientErrorFingerprint({
        ...base,
        stack: clientErrorStack('at other (https://flyflare.ru/a.js:1:1)'),
      }),
    ).not.toBe(baseFingerprint);
    expect(clientErrorFingerprint({ ...base, url: 'https://flyflare.ru/ru/dashboard' })).not.toBe(
      baseFingerprint,
    );
  });

  it('игнорирует query и hash в пути', () => {
    expect(clientErrorPath('https://x.test/a/b?email=a@b.co#token')).toBe('/a/b');
    expect(clientErrorPath('/relative?x=1')).toBe('/relative');
    expect(clientErrorPath('not a url')).toBe('');
  });
});

describe('firstClientErrorStackFrame', () => {
  it('возвращает первый кадр и нормализует пробелы', () => {
    expect(firstClientErrorStackFrame(STACK)).toBe(
      'at LandingCard.render (https://flyflare.ru/_next/static/chunks/app.js:10:42)',
    );
    expect(firstClientErrorStackFrame('Error: x')).toBe('');
    expect(firstClientErrorStackFrame(undefined)).toBe('');
  });

  it('понимает Safari-формат frame@url', () => {
    expect(firstClientErrorStackFrame('boom@https://x.test/app.js:1:2')).toBe(
      'boom@https://x.test/app.js:1:2',
    );
  });
});

function clientErrorStack(frame: string): string {
  return `Error: boom\n    ${frame}`;
}
