import { describe, expect, it, vi } from 'vitest';

import type { TouchdownPreviewRequest, TouchdownPreviewResponse } from '@flightlog/contracts';

import type { HttpClient, HttpRequest, HttpResponse } from './http.js';
import { MemoryTokenStore, type StoredTokens } from './token-store.js';
import {
  PreviewAbortedError,
  PreviewUnavailableError,
  TouchdownPreviewClient,
} from './touchdown-preview.js';

const DEVICE_ID = '99999999-9999-4999-8999-999999999999';
const SERVER_FLIGHT_ID = '11111111-1111-4111-8111-111111111111';
const TOKENS: StoredTokens = {
  access_token: 'access-1',
  device_token: 'device-1',
  device_id: DEVICE_ID,
};

function request(overrides: Partial<TouchdownPreviewRequest> = {}): TouchdownPreviewRequest {
  return {
    seq: 1,
    touchdown_at: '2026-10-15T12:00:00.000Z',
    lat: 59.800936,
    lon: 30.259455,
    heading_deg: 280,
    vs_fpm: -135,
    g_force: 1.24,
    pitch_deg: 5.5,
    bank_deg: -1.2,
    bounce_count: 0,
    ...overrides,
  };
}

function response(resolved = true): TouchdownPreviewResponse {
  return {
    data: {
      seq: 1,
      score: 84,
      grade: 'good',
      components: { vertical_speed: 95 },
      score_version: '1.0.0',
      segmentation_version: '1.1.0',
      preliminary: true,
      resolved,
      runway: resolved
        ? {
            airport_icao: 'ULLI',
            designator: '28R',
            length_m: 3780,
            width_m: 60,
            heading_deg: 280,
            source: 'ourairports',
          }
        : null,
      metrics: {
        vs_fpm: -135,
        g_force: 1.24,
        bounce_count: 0,
        bounced: false,
        ...(resolved ? { centreline_offset_m: 1.2, touchdown_zone: 'TDZ' as const } : {}),
      },
    },
  };
}

function makeClient(
  handler: (request: HttpRequest) => HttpResponse,
): {
  client: TouchdownPreviewClient;
  calls: HttpRequest[];
  refresh: ReturnType<typeof vi.fn>;
} {
  const calls: HttpRequest[] = [];
  const http: HttpClient = {
    request: async (req) => {
      calls.push(req);
      return handler(req);
    },
  };
  const refresh = vi.fn(async () => ({ ...TOKENS, access_token: 'access-2' }));
  const client = new TouchdownPreviewClient({
    apiBaseUrl: 'https://api.test',
    http,
    tokenStore: new MemoryTokenStore(TOKENS),
    auth: { refresh },
  });
  return { client, calls, refresh };
}

describe('TouchdownPreviewClient', () => {
  it('POST на flight-scoped endpoint с bearer и machine-independent телом', async () => {
    const { client, calls } = makeClient(() => ({ status: 200, headers: {}, body: response() }));
    const result = await client.request(SERVER_FLIGHT_ID, request());
    expect(result.data.score).toBe(84);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(
      `https://api.test/v1/flights/${SERVER_FLIGHT_ID}/touchdown-preview`,
    );
    expect(calls[0]?.headers?.authorization).toBe('Bearer access-1');
  });

  it('retry один раз после 401 через refresh', async () => {
    let attempts = 0;
    const { client, calls, refresh } = makeClient(() => {
      attempts += 1;
      if (attempts === 1) return { status: 401, headers: {}, body: { code: 'UNAUTHORIZED' } };
      return { status: 200, headers: {}, body: response() };
    });
    const result = await client.request(SERVER_FLIGHT_ID, request());
    expect(result.data.score).toBe(84);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls[1]?.headers?.authorization).toBe('Bearer access-2');
  });

  it('404 → PreviewUnavailableError (старый сервер, fallback клиента)', async () => {
    const { client } = makeClient(() => ({
      status: 404,
      headers: {},
      body: { code: 'NOT_FOUND' },
    }));
    await expect(client.request(SERVER_FLIGHT_ID, request())).rejects.toBeInstanceOf(
      PreviewUnavailableError,
    );
  });

  it('malformed body → PreviewUnavailableError, без throw наверх', async () => {
    const { client } = makeClient(() => ({ status: 200, headers: {}, body: { data: {} } }));
    await expect(client.request(SERVER_FLIGHT_ID, request())).rejects.toBeInstanceOf(
      PreviewUnavailableError,
    );
  });

  it('нет сохранённых токенов → PreviewUnavailableError', async () => {
    const http: HttpClient = {
      request: async () => ({ status: 200, headers: {}, body: response() }),
    };
    const client = new TouchdownPreviewClient({
      apiBaseUrl: 'https://api.test',
      http,
      tokenStore: new MemoryTokenStore(null),
      auth: { refresh: vi.fn(async () => TOKENS) },
    });
    await expect(client.request(SERVER_FLIGHT_ID, request())).rejects.toBeInstanceOf(
      PreviewUnavailableError,
    );
  });

  it('resolved=false принимается (клиент сам решает fallback)', async () => {
    const { client } = makeClient(() => ({
      status: 200,
      headers: {},
      body: response(false),
    }));
    const result = await client.request(SERVER_FLIGHT_ID, request());
    expect(result.data.resolved).toBe(false);
    expect(result.data.runway).toBeNull();
  });

  it('abort signal отменяет незавершённый запрос (новое касание побеждает)', async () => {
    const http: HttpClient = { request: () => new Promise<HttpResponse>(() => undefined) };
    const client = new TouchdownPreviewClient({
      apiBaseUrl: 'https://api.test',
      http,
      tokenStore: new MemoryTokenStore(TOKENS),
      auth: { refresh: vi.fn(async () => TOKENS) },
    });
    const controller = new AbortController();
    const promise = client.request(SERVER_FLIGHT_ID, request(), { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(PreviewAbortedError);
  });
});
