import { describe, expect, it, vi } from 'vitest';

import { AccountResolver } from './account';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AccountResolver (T-CLIENT2)', () => {
  it('читает email/display_name/plan из ответа /v1/me', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: { email: 'pilot@example.com', display_name: 'Pilot One', plan: { name: 'Pro' } },
      }),
    );
    const resolver = new AccountResolver({
      apiUrl: 'https://api.test',
      loadAccessToken: async () => 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const account = await resolver.refresh();
    expect(account).toEqual({
      email: 'pilot@example.com',
      displayName: 'Pilot One',
      planName: 'Pro',
    });
    expect(resolver.value).toEqual(account);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.test/v1/me',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer token' }),
      }),
    );
  });

  it('null, если токена нет — сеть не трогаем', async () => {
    const fetchImpl = vi.fn();
    const resolver = new AccountResolver({
      apiUrl: 'https://api.test',
      loadAccessToken: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await resolver.refresh()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('сетевой сбой не роняет и сохраняет прошлый снимок', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { email: 'a@b.com' } }))
      .mockRejectedValueOnce(new Error('offline'));
    const resolver = new AccountResolver({
      apiUrl: 'https://api.test',
      loadAccessToken: async () => 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await resolver.refresh();
    expect(await resolver.refresh()).toEqual({ email: 'a@b.com', displayName: null, planName: null });
  });

  it('HTTP 401 не перетирает прошлый снимок', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { email: 'a@b.com' } }))
      .mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401));
    const resolver = new AccountResolver({
      apiUrl: 'https://api.test',
      loadAccessToken: async () => 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await resolver.refresh();
    expect(await resolver.refresh()).toEqual({ email: 'a@b.com', displayName: null, planName: null });
  });

  it('параллельные refresh не дублируют запрос', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { email: 'a@b.com' } }));
    const resolver = new AccountResolver({
      apiUrl: 'https://api.test',
      loadAccessToken: async () => 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await Promise.all([resolver.refresh(), resolver.refresh()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
