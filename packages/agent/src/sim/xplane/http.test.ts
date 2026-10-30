import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { XPlaneRestClient, XPlaneWebApiError } from './http.js';

interface CapturedRequest {
  init: RequestInit | undefined;
}

/** Фейковый fetch, отдающий заданный JSON и запоминающий `init`. */
function capturingFetch(
  body: unknown = { data: [] },
  status = 200,
): { fetchImpl: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    calls.push({ init });
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('XPlaneRestClient connection handling (WS upgrade root cause)', () => {
  it('каждый GET несёт Connection: close (не оставляем пул сокетов web-серверу XP)', async () => {
    const { fetchImpl, calls } = capturingFetch();
    const client = new XPlaneRestClient({ baseUrl: 'http://127.0.0.1:8086', fetchImpl });
    await client.findDataref('sim/flightmodel/position/latitude');
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.connection).toBe('close');
    expect(headers.accept).toBe('application/json');
  });

  it('GET-only: HTTP-метод не задаётся вообще', async () => {
    const { fetchImpl, calls } = capturingFetch();
    const client = new XPlaneRestClient({ baseUrl: 'http://127.0.0.1:8086', fetchImpl });
    await client.getCapabilities();
    expect(calls[0]?.init?.method).toBeUndefined();
    expect(calls[0]?.init?.redirect).toBe('error');
  });

  it('403 → forbidden, таймаут-канал не течёт', async () => {
    const { fetchImpl } = capturingFetch('', 403);
    const client = new XPlaneRestClient({ baseUrl: 'http://127.0.0.1:8086', fetchImpl });
    await expect(client.getCapabilities()).rejects.toMatchObject({ reason: 'forbidden', status: 403 });
  });

  it('не-JSON тело → invalid-response', async () => {
    const fetchImpl = (async () => ({
      status: 200,
      ok: true,
      text: async () => 'not-json',
    })) as unknown as typeof fetch;
    const client = new XPlaneRestClient({ baseUrl: 'http://127.0.0.1:8086', fetchImpl });
    await expect(client.getDatarefValue(1)).rejects.toBeInstanceOf(XPlaneWebApiError);
  });
});

/**
 * Регрессия живого дефекта: встроенный web-сервер X-Plane держит ограниченный
 * пул HTTP-сокетов. После ~47 резолвов dataref пул исчерпан и последующий
 * WebSocket-upgrade отдаёт не-101. Мок-сервер это воспроизводит: разрешает
 * upgrade только если остались только его собственные сокеты.
 */
describe('WS upgrade after exhausting HTTP sockets (Connection: close)', () => {
  let server: Server | null = null;
  const sockets = new Set<Socket>();

  afterEach(async () => {
    const current = server;
    server = null;
    // Апгрейднутые WS-сокеты отсоединяются от трекинга сервера — рвём вручную.
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
  });

  async function startMockXPlane(): Promise<{ url: string; wsUrl: string; activeCount: () => number }> {
    let active = 0;
    const instance = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 1, name: 'x', value_type: 'float' }] }));
    });
    instance.on('connection', (socket) => {
      active += 1;
      sockets.add(socket);
      socket.on('close', () => {
        active -= 1;
        sockets.delete(socket);
      });
    });
    instance.on('upgrade', (req, socket) => {
      // Пул исчерпан, если открыт ещё какой-то сокет, кроме самого upgrade'а.
      if (active > 1) {
        socket.destroy();
        return;
      }
      const key = String(req.headers['sec-websocket-key'] ?? '');
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', () => resolve()));
    server = instance;
    const { port } = instance.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}/api/v3`,
      activeCount: () => active,
    };
  }

  function openWebSocket(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done(false), 3000);
      let socket: WebSocket | null = null;
      try {
        socket = new WebSocket(url);
      } catch {
        done(false);
        return;
      }
      socket.onopen = () => {
        try { socket?.close(); } catch { /* ignore */ }
        done(true);
      };
      socket.onerror = () => done(false);
      socket.onclose = () => done(false);
    });
  }

  it('после 47 GET’ов WS-open успешен (Connection: close освобождает пул)', async () => {
    const { url, wsUrl, activeCount } = await startMockXPlane();
    const client = new XPlaneRestClient({ baseUrl: url });
    for (let index = 0; index < 47; index += 1) {
      await client.findDataref(`sim/flightmodel/position/latitude_${index}`);
    }
    // Ждём, пока сервер закроет сокеты от Connection: close (пул не должен тёчь).
    for (let wait = 0; wait < 20 && activeCount() > 0; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(activeCount()).toBe(0);
    expect(await openWebSocket(wsUrl)).toBe(true);
  });

  it('без Connection: close пул тёчет → WS-upgrade отдаёт не-101 (корень дефекта)', async () => {
    const { url, wsUrl, activeCount } = await startMockXPlane();
    // Эмулируем прежнее поведение: тот же GET, но без Connection: close.
    const legacyFetch = (async (input: unknown, init?: RequestInit) => {
      const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
      delete headers.connection;
      return fetch(input as string, { ...init, headers });
    }) as unknown as typeof fetch;
    const client = new XPlaneRestClient({ baseUrl: url, fetchImpl: legacyFetch });
    for (let index = 0; index < 47; index += 1) {
      await client.findDataref(`sim/flightmodel/position/latitude_${index}`);
    }
    expect(activeCount()).toBeGreaterThan(0);
    expect(await openWebSocket(wsUrl)).toBe(false);
  });
});
