import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HeartbeatClient,
  HeartbeatError,
  HeartbeatScheduler,
  type HeartbeatClientOptions,
} from './heartbeat.js';
import type { HttpClient } from './http.js';
import { MemoryTokenStore, type StoredTokens } from './token-store.js';

const TOKENS: StoredTokens = {
  access_token: 'access-1',
  device_token: 'device-1',
  device_id: '99999999-9999-4999-8999-999999999999',
};

function makeLogger() {
  return { warn: vi.fn() };
}

function makeHttp(response: Awaited<ReturnType<HttpClient['request']>>) {
  const request = vi.fn(async () => response);
  return { request };
}

describe('HeartbeatScheduler — пока агент запущен, устройство видно в сети', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('шлёт heartbeat каждый интервал и не логирует успех', async () => {
    const send = vi.fn(async () => true);
    const logger = makeLogger();
    const scheduler = new HeartbeatScheduler({
      client: { send },
      logger,
      intervalMs: 1_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(send).toHaveBeenCalledTimes(3);
    expect(logger.warn).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('stop() очищает таймер — после остановки вызовов нет', async () => {
    const send = vi.fn(async () => true);
    const scheduler = new HeartbeatScheduler({
      client: { send },
      logger: makeLogger(),
      intervalMs: 1_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('не бросает на сетевых ошибках и предупреждает один раз подряд', async () => {
    const send = vi.fn(async () => {
      throw new Error('network down');
    });
    const logger = makeLogger();
    const scheduler = new HeartbeatScheduler({
      client: { send },
      logger,
      intervalMs: 1_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(send).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'heartbeat unavailable',
      expect.objectContaining({ consecutive_failures: 3, error: 'network down' }),
    );

    await vi.advanceTimersByTimeAsync(3_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('после успеха счётчик неудач и предупреждение сбрасываются', async () => {
    const send = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(true)
      .mockRejectedValue(new Error('offline'));
    const logger = makeLogger();
    const scheduler = new HeartbeatScheduler({
      client: { send },
      logger,
      intervalMs: 1_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});

describe('HeartbeatClient — device-token запрос', () => {
  const options = (overrides: Partial<HeartbeatClientOptions> = {}): HeartbeatClientOptions => ({
    apiBaseUrl: 'https://api.test',
    http: makeHttp({ status: 204, headers: {}, body: null }),
    tokenStore: new MemoryTokenStore(TOKENS),
    ...overrides,
  });

  it('без сохранённого токена ничего не отправляет (не спарен)', async () => {
    const http = makeHttp({ status: 204, headers: {}, body: null });
    const client = new HeartbeatClient(options({ http, tokenStore: new MemoryTokenStore(null) }));

    await expect(client.send()).resolves.toBe(false);
    expect(http.request).not.toHaveBeenCalled();
  });

  it('шлёт POST /v1/agent/heartbeat с bearer и machine-id', async () => {
    const http = makeHttp({ status: 204, headers: {}, body: null });
    const client = new HeartbeatClient(options({ http, machineId: 'machine-1' }));

    await expect(client.send()).resolves.toBe(true);
    expect(http.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://api.test/v1/agent/heartbeat',
        headers: { authorization: 'Bearer access-1', 'x-td-machine-id': 'machine-1' },
      }),
    );
  });

  it('на 401 обновляет токен и повторяет один раз', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, headers: {}, body: null })
      .mockResolvedValueOnce({ status: 204, headers: {}, body: null });
    const refresh = vi.fn(async () => ({ ...TOKENS, access_token: 'access-2' }));
    const client = new HeartbeatClient(options({ http: { request }, auth: { refresh } }));

    await expect(client.send()).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { authorization: 'Bearer access-2' } }),
    );
  });

  it('повторный 401 после refresh → HeartbeatError (один тихий retry)', async () => {
    const request = vi.fn().mockResolvedValue({ status: 401, headers: {}, body: null });
    const refresh = vi.fn(async () => ({ ...TOKENS, access_token: 'access-2' }));
    const client = new HeartbeatClient(options({ http: { request }, auth: { refresh } }));

    await expect(client.send()).rejects.toMatchObject({ status: 401 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('не-2xx (кроме 401) → HeartbeatError', async () => {
    const client = new HeartbeatClient(
      options({ http: makeHttp({ status: 503, headers: {}, body: null }) }),
    );

    await expect(client.send()).rejects.toBeInstanceOf(HeartbeatError);
  });
});
