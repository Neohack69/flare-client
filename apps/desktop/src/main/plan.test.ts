import { describe, expect, it, vi } from 'vitest';

import { PlanResolver } from './plan';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const pro = { code: 'pro', name: 'Pro' } as const;

describe('PlanResolver (iter77 premium skin)', () => {
  it('читает план из agent-scope /v1/agent/me', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { plan: pro } }));
    const resolver = new PlanResolver({
      apiUrl: 'https://api.test',
      loadAccessToken: async () => 'device-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await resolver.refresh()).toEqual(pro);
    expect(resolver.value).toEqual(pro);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.test/v1/agent/me',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer device-token' }),
      }),
    );
  });

  it('нет токена → null, сеть не трогаем', async () => {
    const fetchImpl = vi.fn();
    const resolver = new PlanResolver({
      apiUrl: 'https://api.test',
      loadAccessToken: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await resolver.refresh()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('сбой сети не стирает последний известный план', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { plan: pro } }))
      .mockRejectedValueOnce(new Error('offline'));
    const resolver = new PlanResolver({
      apiUrl: 'https://api.test',
      loadAccessToken: async () => 'device-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await resolver.refresh();
    expect(await resolver.refresh()).toEqual(pro);
  });

  it('HTTP 403/401 не перетирает кэш (fail-safe)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { plan: pro } }))
      .mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, 403));
    const resolver = new PlanResolver({
      apiUrl: 'https://api.test',
      loadAccessToken: async () => 'device-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await resolver.refresh();
    expect(await resolver.refresh()).toEqual(pro);
  });

  it('trial принимается аддитивно, неизвестные поля ответа игнорируются', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          plan: {
            code: pro.code,
            name: pro.name,
            trial: {
              active: true,
              ends_at: '2026-10-20T12:00:00.000Z',
              days_left: 3,
              ai_reports_remaining: 10,
            },
          },
          extra: 1,
        },
      }),
    );
    const resolver = new PlanResolver({
      apiUrl: 'https://api.test',
      loadAccessToken: async () => 'device-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const plan = await resolver.refresh();
    expect(plan?.trial?.days_left).toBe(3);
    expect(resolver.value).toEqual(plan);
  });
});
