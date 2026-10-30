import { afterEach, describe, expect, it, vi } from 'vitest';

import { FetchHttpClient, backoffDelayMs, isOkStatus, isRetryableStatus } from './http.js';

/**
 * Двойник native `fetch`: бросает `Illegal invocation`, если вызван с `this`,
 * не равным `undefined`/`globalThis` (в Node `fetch` не привязан к экземпляру клиента).
 */
function strictFetch(handler: () => Response): typeof fetch {
  return function (this: unknown): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError('Illegal invocation');
    }
    return Promise.resolve(handler());
  } as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FetchHttpClient', () => {
  it('дефолтный fetch вызывается без привязки this (регрессия Illegal invocation)', async () => {
    const fetchMock = vi.fn(
      strictFetch(
        () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new FetchHttpClient();
    const response = await client.request({ method: 'GET', url: 'https://api.test/v1/healthz' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('внешний fetchImpl вызывается без привязки this', async () => {
    const strict = strictFetch(() => new Response('ok', { status: 200 }));
    const client = new FetchHttpClient({ fetchImpl: strict });

    const response = await client.request({ method: 'GET', url: 'https://api.test/v1/x' });

    expect(response.body).toBe('ok');
  });

  it('сетевую ошибку пробрасывает (с abort по таймауту)', async () => {
    vi.stubGlobal(
      'fetch',
      strictFetch(() => {
        throw new Error('ECONNRESET');
      }),
    );
    const client = new FetchHttpClient({ timeoutMs: 50 });

    await expect(
      client.request({ method: 'GET', url: 'https://api.test/v1/x' }),
    ).rejects.toThrow('ECONNRESET');
  });
});

describe('isRetryableStatus / isOkStatus / backoffDelayMs', () => {
  it('ретраятся 408/425/429 и 5xx, но не 4xx', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });

  it('2xx — успех', () => {
    expect(isOkStatus(200)).toBe(true);
    expect(isOkStatus(204)).toBe(true);
    expect(isOkStatus(302)).toBe(false);
  });

  it('backoff ограничен cap и детерминирован при фиксированном random', () => {
    const delay = backoffDelayMs(10, { baseDelayMs: 1000, maxDelayMs: 5000, random: () => 1 });
    expect(delay).toBe(5000);
  });
});
