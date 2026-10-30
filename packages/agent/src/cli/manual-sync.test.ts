import { describe, expect, it } from 'vitest';

import { MemoryOutboxBuffer } from '../buffer/memory-buffer.js';
import { FakeApiServer } from '../testing/fake-api-server.js';
import { seedCompletedFlight } from '../testing/seed-flight.js';
import { MemoryTokenStore, type StoredTokens } from '../sync/token-store.js';
import type { Logger } from './logger.js';
import { runManualSync } from './manual-sync.js';

const TOKENS: StoredTokens = {
  access_token: 'access-1',
  device_token: 'device-1',
  device_id: '99999999-9999-4999-8999-999999999999',
};

function makeLogger(): Logger & {
  entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }>;
} {
  const entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  const push = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    entries.push({ level, message, meta });
  };
  return { entries, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

let counter = 0;
function idGenerator(): string {
  counter += 1;
  return `11111111-1111-4111-8111-${counter.toString(16).padStart(12, '0')}`;
}

describe('runManualSync (CLI sync/flush)', () => {
  it('одноразово выгружает зависший outbox и сообщает статус', async () => {
    const buffer = new MemoryOutboxBuffer();
    const server = new FakeApiServer();
    const tokenStore = new MemoryTokenStore(TOKENS);
    const logger = makeLogger();
    seedCompletedFlight(buffer, { idGenerator, points: 4, events: 1 });

    const outcome = await runManualSync({
      env: { API_URL: 'https://api.test', AGENT_LOG_LEVEL: 'silent' },
      logger,
      buffer,
      tokenStore,
      http: server.asHttpClient(),
      random: () => 1,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.result?.reason).toBe('manual');
    expect(server.flights.size).toBe(1);
    expect(server.completed.size).toBe(1);
    expect(server.points.size).toBe(4);
    expect(server.events.size).toBe(1);
    expect(outcome.result?.pending_after.pendingPoints).toBe(0);
    expect(outcome.result?.pending_after.pendingFlights).toBe(0);
    expect(
      logger.entries.some(
        (entry) => entry.message === 'sync completed' && entry.meta?.reason === 'manual',
      ),
    ).toBe(true);
  });

  it('повторный manual-sync идемпотентен: нулевые дубли и нулевые новые батчи', async () => {
    const buffer = new MemoryOutboxBuffer();
    const server = new FakeApiServer();
    const tokenStore = new MemoryTokenStore(TOKENS);
    seedCompletedFlight(buffer, { idGenerator, points: 5, events: 1 });

    const first = await runManualSync({
      env: { API_URL: 'https://api.test', AGENT_LOG_LEVEL: 'silent' },
      buffer,
      tokenStore,
      http: server.asHttpClient(),
      random: () => 1,
    });
    expect(first.ok).toBe(true);

    const callsBefore = server.calls.length;
    const second = await runManualSync({
      env: { API_URL: 'https://api.test', AGENT_LOG_LEVEL: 'silent' },
      buffer,
      tokenStore,
      http: server.asHttpClient(),
      random: () => 1,
    });

    expect(second.ok).toBe(true);
    expect(server.flights.size).toBe(1);
    expect(server.points.size).toBe(5);
    expect(server.events.size).toBe(1);
    expect(server.duplicatePoints).toBe(0);
    expect(server.duplicateEvents).toBe(0);
    expect(server.calls.slice(callsBefore)).toHaveLength(0);
  });

  it('падает с понятной ошибкой без сохранённого токена', async () => {
    const buffer = new MemoryOutboxBuffer();
    const server = new FakeApiServer();
    seedCompletedFlight(buffer, { idGenerator, points: 1, events: 0 });

    const outcome = await runManualSync({
      env: { API_URL: 'https://api.test', AGENT_LOG_LEVEL: 'silent' },
      buffer,
      tokenStore: new MemoryTokenStore(null),
      http: server.asHttpClient(),
      random: () => 1,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
    expect(server.calls).toHaveLength(0);
  });
});
