import type { DeviceCodeResponse } from '@flightlog/contracts';
import { describe, expect, it, vi } from 'vitest';

import { BASE_MS } from '../testing/telemetry-fixture.js';
import { DeviceAuthClient, DeviceAuthError } from './device-auth.js';
import type { HttpClient, HttpRequest, HttpResponse } from './http.js';
import { MemoryTokenStore, type StoredTokens } from './token-store.js';

const DEVICE_ID = '99999999-9999-4999-8999-999999999999';

function scriptedClient(responses: HttpResponse[]): HttpClient {
  let index = 0;
  return {
    request: (_request: HttpRequest) => {
      const response = responses[index] ?? responses[responses.length - 1];
      index += 1;
      return Promise.resolve(response ?? { status: 500, headers: {}, body: null });
    },
  };
}

function tokensResponse(accessToken: string): HttpResponse {
  return {
    status: 200,
    headers: {},
    body: {
      data: {
        access_token: accessToken,
        device_token: 'device-1',
        device_id: DEVICE_ID,
        expires_in: 900,
      },
    },
  };
}

function capturingClient(responses: HttpResponse[]): {
  http: HttpClient;
  requests: HttpRequest[];
} {
  let index = 0;
  const requests: HttpRequest[] = [];
  return {
    requests,
    http: {
      request: (request: HttpRequest) => {
        requests.push(request);
        const response = responses[index] ?? responses[responses.length - 1];
        index += 1;
        return Promise.resolve(response ?? { status: 500, headers: {}, body: null });
      },
    },
  };
}

describe('DeviceAuthClient (OAuth device flow, api.md §2.3)', () => {
  it('authorize: code → поллинг pending → сохранение токенов', async () => {
    const store = new MemoryTokenStore();
    const sleeps: number[] = [];
    const codes: DeviceCodeResponse[] = [];
    const client = new DeviceAuthClient({
      http: scriptedClient([
        {
          status: 200,
          headers: {},
          body: {
            data: {
              device_code: 'device-code',
              user_code: 'WXYZ-1234',
              verification_uri: 'https://app.flightlog.test/device',
              interval: 5,
              expires_in: 600,
            },
          },
        },
        { status: 428, headers: {}, body: { code: 'AUTHORIZATION_PENDING' } },
        { status: 428, headers: {}, body: { code: 'AUTHORIZATION_PENDING' } },
        tokensResponse('access-1'),
      ]),
      apiBaseUrl: 'https://api.test',
      tokenStore: store,
      clientName: 'Домашний ПК',
      platform: 'win32',
      now: () => BASE_MS,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onUserCode: (info) => codes.push(info),
    });

    const tokens = await client.authorize();

    expect(codes[0]?.user_code).toBe('WXYZ-1234');
    expect(sleeps).toEqual([5000, 5000]);
    expect(tokens).toMatchObject({ access_token: 'access-1', device_token: 'device-1' });
    const saved = await store.load();
    expect(saved?.access_token).toBe('access-1');
    expect(saved?.access_expires_at).toBeDefined();
  });

  it('истёкший device code → EXPIRED_TOKEN', async () => {
    let now = BASE_MS;
    const client = new DeviceAuthClient({
      http: scriptedClient([{ status: 428, headers: {}, body: { code: 'AUTHORIZATION_PENDING' } }]),
      apiBaseUrl: 'https://api.test',
      tokenStore: new MemoryTokenStore(),
      clientName: 'PC',
      platform: 'win32',
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    await expect(client.pollToken('device-code', 5, 10)).rejects.toMatchObject({
      code: 'EXPIRED_TOKEN',
    });
  });

  it('refresh ротирует токены и сохраняет их', async () => {
    const store = new MemoryTokenStore({
      access_token: 'old',
      device_token: 'device-1',
      device_id: DEVICE_ID,
    });
    const client = new DeviceAuthClient({
      http: scriptedClient([tokensResponse('access-2')]),
      apiBaseUrl: 'https://api.test',
      tokenStore: store,
      clientName: 'PC',
      platform: 'win32',
      now: () => BASE_MS,
    });

    const refreshed = await client.refresh();
    expect(refreshed.access_token).toBe('access-2');
    expect((await store.load())?.access_token).toBe('access-2');
  });

  it('single-flight: N параллельных refresh → один HTTP-запрос', async () => {
    const store = new MemoryTokenStore({
      access_token: 'old',
      device_token: 'device-1',
      device_id: DEVICE_ID,
    });
    let calls = 0;
    const client = new DeviceAuthClient({
      http: {
        request: async () => {
          calls += 1;
          return tokensResponse('access-2');
        },
      },
      apiBaseUrl: 'https://api.test',
      tokenStore: store,
      clientName: 'PC',
      platform: 'win32',
      now: () => BASE_MS,
    });

    const results = await Promise.all(Array.from({ length: 6 }, () => client.refresh()));

    expect(calls).toBe(1);
    expect(results.every((tokens) => tokens.access_token === 'access-2')).toBe(true);
  });

  it('первый 401 не чистит токены: повтор через 1 с и успех', async () => {
    const store = new MemoryTokenStore({
      access_token: 'old',
      device_token: 'device-1',
      device_id: DEVICE_ID,
    });
    const clear = vi.spyOn(store, 'clear');
    const sleeps: number[] = [];
    const client = new DeviceAuthClient({
      http: scriptedClient([
        { status: 401, headers: {}, body: { code: 'UNAUTHORIZED' } },
        tokensResponse('access-2'),
      ]),
      apiBaseUrl: 'https://api.test',
      tokenStore: store,
      clientName: 'PC',
      platform: 'win32',
      now: () => BASE_MS,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const refreshed = await client.refresh();

    expect(refreshed.access_token).toBe('access-2');
    expect(sleeps).toEqual([1_000]);
    expect(clear).not.toHaveBeenCalled();
    expect((await store.load())?.device_token).toBe('device-1');
  });

  it('повторный 401 очищает хранилище и отдаёт DeviceAuthError', async () => {
    const store = new MemoryTokenStore({
      access_token: 'old',
      device_token: 'device-1',
      device_id: DEVICE_ID,
    });
    const client = new DeviceAuthClient({
      http: scriptedClient([{ status: 401, headers: {}, body: { code: 'UNAUTHORIZED' } }]),
      apiBaseUrl: 'https://api.test',
      tokenStore: store,
      clientName: 'PC',
      platform: 'win32',
      now: () => BASE_MS,
      sleep: async () => undefined,
    });

    await expect(client.refresh()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await store.load()).toBeNull();
  });

  it('не-401 ошибка не чистит токены (транзиентный сбой)', async () => {
    const store = new MemoryTokenStore({
      access_token: 'old',
      device_token: 'device-1',
      device_id: DEVICE_ID,
    });
    const client = new DeviceAuthClient({
      http: scriptedClient([{ status: 503, headers: {}, body: null }]),
      apiBaseUrl: 'https://api.test',
      tokenStore: store,
      clientName: 'PC',
      platform: 'win32',
      now: () => BASE_MS,
    });

    await expect(client.refresh()).rejects.toBeInstanceOf(DeviceAuthError);
    expect(await store.load()).not.toBeNull();
  });

  it('без сохранённого токена refresh падает', async () => {
    const client = new DeviceAuthClient({
      http: scriptedClient([]),
      apiBaseUrl: 'https://api.test',
      tokenStore: new MemoryTokenStore(null),
      clientName: 'PC',
      platform: 'win32',
    });
    await expect(client.refresh()).rejects.toBeInstanceOf(DeviceAuthError);
  });

  it('CD-6.2: machine_id уходит в device/code и device/token', async () => {
    const store = new MemoryTokenStore();
    const { http, requests } = capturingClient([
      {
        status: 200,
        headers: {},
        body: {
          data: {
            device_code: 'device-code',
            user_code: 'WXYZ-1234',
            verification_uri: 'https://app.flightlog.test/device',
            interval: 5,
            expires_in: 600,
          },
        },
      },
      tokensResponse('access-1'),
    ]);
    const client = new DeviceAuthClient({
      http,
      apiBaseUrl: 'https://api.test',
      tokenStore: store,
      clientName: 'PC',
      platform: 'win32',
      machineId: 'machine-abcdefghijkl',
      now: () => BASE_MS,
      sleep: async () => undefined,
    });

    const code = await client.requestCode();
    await client.pollToken(code.device_code, code.interval, code.expires_in);

    expect((requests[0]?.body as { machine_id?: string }).machine_id).toBe('machine-abcdefghijkl');
    expect((requests[1]?.body as { machine_id?: string }).machine_id).toBe('machine-abcdefghijkl');
  });

  it('CD-6.2: MACHINE_MISMATCH при refresh не чистит токены (NeedsRepair)', async () => {
    const store = new MemoryTokenStore({
      access_token: 'old',
      device_token: 'device-1',
      device_id: DEVICE_ID,
    });
    const { http, requests } = capturingClient([
      { status: 403, headers: {}, body: { code: 'MACHINE_MISMATCH' } },
    ]);
    const client = new DeviceAuthClient({
      http,
      apiBaseUrl: 'https://api.test',
      tokenStore: store,
      clientName: 'PC',
      platform: 'win32',
      machineId: 'machine-abcdefghijkl',
    });

    await expect(client.refresh()).rejects.toMatchObject({ code: 'MACHINE_MISMATCH' });
    expect((requests[0]?.body as { machine_id?: string }).machine_id).toBe('machine-abcdefghijkl');
    expect(await store.load()).not.toBeNull();
  });
});

describe('MemoryTokenStore', () => {
  it('сохраняет и очищает токены', async () => {
    const store = new MemoryTokenStore();
    const tokens: StoredTokens = {
      access_token: 'a',
      device_token: 'd',
      device_id: DEVICE_ID,
    };
    await store.save(tokens);
    expect(await store.load()).toEqual(tokens);
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});
