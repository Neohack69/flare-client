import { describe, expect, it } from 'vitest';

import type { AgentStatusEvent, DesktopOutboxCounts } from '@flightlog/contracts';

import { formatElapsed, NO_DATA_WARN_MS, statusGridView } from './status-view.js';

const NOW = Date.parse('2026-10-18T08:40:00.000Z');
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

function view(
  status: AgentStatusEvent | null,
  overrides: Partial<Parameters<typeof statusGridView>[0]> = {},
) {
  return statusGridView({
    locale: 'ru',
    kind: status?.state === 'recording' ? 'recording' : ((status?.state as never) ?? 'sim_waiting'),
    status,
    received: status !== null,
    outbox: null,
    nowMs: NOW,
    ...overrides,
  });
}

const PENDING: DesktopOutboxCounts = {
  flights: 2,
  points: 10,
  events: 1,
  pendingFlights: 2,
  pendingPoints: 10,
  pendingEvents: 1,
};

describe('statusGridView — SIM-STATUS-1 (RU)', () => {
  it('connected MSFS: конкретный сим + свежие данные', () => {
    const result = view({
      state: 'connected_idle',
      at: iso(-200),
      sim: 'msfs2024',
      simConnected: true,
      simPinned: false,
      simTransport: 'simconnect-sunrise',
      lastSampleAt: iso(-200),
    });
    expect(result.simulator).toBe('Синхронизация с MSFS 2024');
    expect(result.simulatorTone).toBe('ok');
    expect(result.data).toBe('данные: 0.2 с назад');
    expect(result.dataTone).toBe('ok');
    expect(result.degraded).toBeNull();
  });

  it('connected X-Plane: имя сима и отсутствие деградации для Web API', () => {
    const result = view({
      state: 'recording',
      sim: 'xplane12',
      simConnected: true,
      simTransport: 'xp-web-api-v1',
      lastSampleAt: iso(-400),
    });
    expect(result.simulator).toBe('Синхронизация с X-Plane 12');
    expect(result.degraded).toBeNull();
  });

  it('X-Plane на RREF: показывает «Web API недоступен → RREF»', () => {
    const result = view({
      state: 'recording',
      sim: 'xplane12',
      simConnected: true,
      simTransport: 'xp-udp-rref',
      simTransportDegraded: true,
      lastSampleAt: iso(-100),
    });
    expect(result.degraded).toBe('Web API недоступен → RREF');
  });

  it('W1b: сим не подключён — строки симулятора нет', () => {
    const result = view({
      state: 'sim_waiting',
      sim: 'msfs2024',
      simConnected: false,
      simPinned: false,
    });
    expect(result.simulator).toBe('');
    expect(result.simulatorTone).toBe('muted');
    expect(result.data).toBe('');
    expect(result.flight).toBe('Полёт не обнаружен');
  });

  it('W1b: источник запинен, но не подключён — строки симулятора нет', () => {
    const result = view({
      state: 'sim_waiting',
      sim: 'xplane12',
      simConnected: false,
      simPinned: true,
    });
    expect(result.simulator).toBe('');
  });

  it('W1b: подключён, но отсчёта ещё нет — строки данных нет', () => {
    const result = view({
      state: 'connected_idle',
      sim: 'msfs2024',
      simConnected: true,
    });
    expect(result.data).toBe('');
  });

  it('идёт запись: самолёт и время полёта', () => {
    const result = view({
      state: 'recording',
      sim: 'xplane12',
      simConnected: true,
      aircraftIcao: 'A320',
      flightStartedAt: iso(-754_000),
      lastSampleAt: iso(-100),
    });
    expect(result.flight).toBe('Полёт: идёт запись · A320 · 12:34');
    expect(result.flightTone).toBe('active');
  });

  it('нет данных > 10 с при живом соединении — предупреждение о паузе', () => {
    const result = view({
      state: 'connected_idle',
      sim: 'msfs2024',
      simConnected: true,
      lastSampleAt: iso(-(NO_DATA_WARN_MS + 2_400)),
    });
    expect(result.data).toBe('нет данных 12 с, проверьте, что сим не на паузе');
    expect(result.dataTone).toBe('warn');
  });

  it('ожидание переподключения: обратный отсчёт от retryInS', () => {
    const result = view({
      state: 'sim_waiting',
      sim: 'msfs2024',
      simConnected: false,
      retryInS: 20,
      at: iso(-5_000),
    });
    expect(result.data).toBe('попытка подключения через 15 с');
  });

  it('рейс завершён и загружается', () => {
    const result = view({
      state: 'syncing',
      sim: 'msfs2024',
      simConnected: true,
      syncReason: 'flight_ended',
    });
    expect(result.flight).toBe('Рейс завершён, загружается…');
  });

  it('T4: очередь — только рейсы; точки/события отдельным уточнением', () => {
    const result = view(
      { state: 'connected_idle', sim: 'msfs2024', simConnected: true },
      { outbox: PENDING },
    );
    expect(result.pending).toBe('В очереди: 2 рейса · 10 точек · 1 событие');
  });

  it('T4: pendingFlights = 0 — строки нет, даже если есть точки/события', () => {
    const result = view(
      { state: 'connected_idle', sim: 'msfs2024', simConnected: true },
      { outbox: { ...PENDING, pendingFlights: 0 } },
    );
    expect(result.pending).toBeNull();
  });

  it('T4: RU plural для 1/5 рейсов', () => {
    const one = view(
      { state: 'connected_idle', sim: 'msfs2024', simConnected: true },
      {
        outbox: {
          ...PENDING,
          pendingFlights: 1,
          pendingPoints: 1,
          pendingEvents: 0,
        },
      },
    );
    expect(one.pending).toBe('В очереди: 1 рейс · 1 точка');

    const many = view(
      { state: 'connected_idle', sim: 'msfs2024', simConnected: true },
      { outbox: { ...PENDING, pendingFlights: 5, pendingPoints: 21, pendingEvents: 0 } },
    );
    expect(many.pending).toBe('В очереди: 5 рейсов · 21 точка');
  });

  it('T4: EN очередь', () => {
    const result = view(
      { state: 'connected_idle', sim: 'msfs2024', simConnected: true },
      {
        outbox: { ...PENDING, pendingFlights: 2, pendingPoints: 141, pendingEvents: 0 },
        locale: 'en',
      },
    );
    expect(result.pending).toBe('Queued: 2 flights · 141 points');
  });

  it('EN: подключённый сим и свежесть данных', () => {
    const result = view(
      {
        state: 'connected_idle',
        sim: 'xplane12',
        simConnected: true,
        lastSampleAt: iso(-200),
      },
      { locale: 'en' },
    );
    expect(result.simulator).toBe('Syncing with X-Plane 12');
    expect(result.data).toBe('data: 0.2 s ago');
  });

  it('нет статуса — строки симулятора нет, остальные прочерки', () => {
    const result = view(null);
    expect(result.simulator).toBe('');
    expect(result.flight).toBe('-');
    expect(result.data).toBe('-');
  });
});

describe('formatElapsed', () => {
  it('mm:ss и h:mm:ss', () => {
    expect(formatElapsed(754)).toBe('12:34');
    expect(formatElapsed(3_725)).toBe('1:02:05');
    expect(formatElapsed(-5)).toBe('00:00');
  });
});
