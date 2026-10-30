import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { toFlightEvent, toTrackPoint } from '../flight/build.js';
import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';
import { SqliteOutboxBuffer } from './sqlite-buffer.js';

const FLIGHT_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const POINT_ID_1 = '33333333-3333-4333-8333-333333333331';
const POINT_ID_2 = '33333333-3333-4333-8333-333333333332';
const T0 = isoAt(BASE_MS, 0);

const dirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flightlog-agent-'));
  dirs.push(dir);
  return join(dir, 'outbox.sqlite');
}

function flightRecord() {
  return {
    client_flight_id: FLIGHT_ID,
    aircraft_icao: 'B738',
    callsign: 'SU123',
    origin_icao: 'UUEE',
    destination_icao: 'ULLI',
    device_id: null,
    started_at: T0,
    ended_at: null,
    status: 'in_progress' as const,
    stats: {},
    created_at: T0,
    updated_at: T0,
    synced_at: null,
  };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('SqliteOutboxBuffer', () => {
  it('персистит рейс, точки и события идемпотентно', () => {
    const db = new SqliteOutboxBuffer(tempDbPath());
    db.upsertFlight(flightRecord());

    const points = [
      toTrackPoint(makeSample(T0), 1, { clientPointId: POINT_ID_1 }),
      toTrackPoint(makeSample(isoAt(BASE_MS, 1000)), 2, { clientPointId: POINT_ID_2 }),
    ];
    expect(db.appendPoints(FLIGHT_ID, points)).toBe(2);
    expect(db.appendPoints(FLIGHT_ID, points)).toBe(0);

    const event = toFlightEvent('touchdown', makeSample(T0), { vs_fpm: -150 }, EVENT_ID);
    expect(db.appendEvents(FLIGHT_ID, [event])).toBe(1);
    expect(db.appendEvents(FLIGHT_ID, [event])).toBe(0);

    expect(db.pendingCounts()).toEqual({
      flights: 1,
      points: 2,
      events: 1,
      pendingFlights: 1,
      pendingPoints: 2,
      pendingEvents: 1,
    });

    db.close();
  });

  it('переживает рестарт процесса', () => {
    const path = tempDbPath();

    const first = new SqliteOutboxBuffer(path);
    first.upsertFlight(flightRecord());
    first.appendPoints(FLIGHT_ID, [toTrackPoint(makeSample(T0), 1, { clientPointId: POINT_ID_1 })]);
    first.appendEvents(FLIGHT_ID, [
      toFlightEvent('touchdown', makeSample(T0), { vs_fpm: -150 }, EVENT_ID),
    ]);
    first.finalizeFlight(FLIGHT_ID, isoAt(BASE_MS, 60_000), 'completed', { duration_s: 60 }, T0);
    first.close();

    const second = new SqliteOutboxBuffer(path);
    const flight = second.getFlight(FLIGHT_ID);
    expect(flight?.status).toBe('completed');
    expect(flight?.ended_at).toBe(isoAt(BASE_MS, 60_000));
    expect(flight?.stats).toEqual({ duration_s: 60 });
    expect(second.loadPoints(FLIGHT_ID)).toHaveLength(1);
    expect(second.loadEvents(FLIGHT_ID)).toHaveLength(1);
    second.close();
  });

  it('отслеживает синхронизацию и уменьшает pending', () => {
    const db = new SqliteOutboxBuffer(tempDbPath());
    db.upsertFlight(flightRecord());
    db.appendPoints(FLIGHT_ID, [
      toTrackPoint(makeSample(T0), 1, { clientPointId: POINT_ID_1 }),
      toTrackPoint(makeSample(isoAt(BASE_MS, 1000)), 2, { clientPointId: POINT_ID_2 }),
    ]);
    db.appendEvents(FLIGHT_ID, [toFlightEvent('touchdown', makeSample(T0), {}, EVENT_ID)]);

    db.markPointsSynced(FLIGHT_ID, [POINT_ID_1], T0);
    expect(db.pendingCounts().pendingPoints).toBe(1);

    db.markEventsSynced(FLIGHT_ID, [EVENT_ID], T0);
    expect(db.pendingCounts().pendingEvents).toBe(0);

    db.markFlightSynced(FLIGHT_ID, T0);
    expect(db.pendingCounts().pendingFlights).toBe(0);
    expect(db.getFlight(FLIGHT_ID)?.synced_at).toBe(T0);
    db.close();
  });

  it('upsert не затирает завершение рейса', () => {
    const db = new SqliteOutboxBuffer(tempDbPath());
    db.upsertFlight(flightRecord());
    db.finalizeFlight(FLIGHT_ID, isoAt(BASE_MS, 60_000), 'completed', { duration_s: 60 }, T0);
    db.upsertFlight({ ...flightRecord(), aircraft_icao: 'A320' });
    const flight = db.getFlight(FLIGHT_ID);
    expect(flight?.aircraft_icao).toBe('A320');
    expect(flight?.status).toBe('completed');
    db.close();
  });

  it('дедуп точек по client_point_id и досыпка quality', () => {
    const db = new SqliteOutboxBuffer(tempDbPath());
    db.upsertFlight(flightRecord());
    const point = toTrackPoint(makeSample(T0), 1, { clientPointId: POINT_ID_1 });
    expect(db.appendPoints(FLIGHT_ID, [point])).toBe(1);
    // Повторная материализация того же id (backfill/retry) — без дубля.
    expect(db.appendPoints(FLIGHT_ID, [{ ...point, seq: 99 }])).toBe(0);

    expect(db.updatePointQuality(FLIGHT_ID, [{ client_point_id: POINT_ID_1, quality: 8 }])).toBe(1);
    const [stored] = db.loadPoints(FLIGHT_ID);
    expect(stored?.quality).toBe(8);
    // Идемпотентно.
    expect(db.updatePointQuality(FLIGHT_ID, [{ client_point_id: POINT_ID_1, quality: 8 }])).toBe(0);
    db.close();
  });

  it('loadFlights фильтрует по статусу', () => {
    const db = new SqliteOutboxBuffer(tempDbPath());
    db.upsertFlight(flightRecord());
    expect(db.loadFlights('in_progress')).toHaveLength(1);
    expect(db.loadFlights('completed')).toHaveLength(0);
    db.close();
  });

  it('CD-3.4: pruneSyncedBefore удаляет старые synced, pending не трогает', () => {
    const db = new SqliteOutboxBuffer(tempDbPath());
    db.upsertFlight(flightRecord());
    const old = isoAt(BASE_MS, -10 * 86_400_000);
    const cutoff = isoAt(BASE_MS, -7 * 86_400_000);

    db.appendPoints(FLIGHT_ID, [
      toTrackPoint(makeSample(T0), 1, { clientPointId: POINT_ID_1 }),
      toTrackPoint(makeSample(isoAt(BASE_MS, 1000)), 2, { clientPointId: POINT_ID_2 }),
    ]);
    db.appendEvents(FLIGHT_ID, [
      toFlightEvent('touchdown', makeSample(T0), { vs_fpm: -150 }, EVENT_ID),
    ]);
    db.markPointsSynced(FLIGHT_ID, [POINT_ID_1], old);
    db.markEventsSynced(FLIGHT_ID, [EVENT_ID], old);

    const pruned = db.pruneSyncedBefore(cutoff);
    expect(pruned).toEqual({ flights: 0, points: 1, events: 1 });
    expect(db.loadPoints(FLIGHT_ID).map((point) => point.client_point_id)).toEqual([POINT_ID_2]);
    expect(db.loadEvents(FLIGHT_ID)).toHaveLength(0);
    expect(db.pendingCounts().pendingPoints).toBe(1);
    expect(() => db.checkpoint()).not.toThrow();
    db.close();
  });

  it('CD-3.4: завершённый рейс без pending удаляется, с pending — нет', () => {
    const path = tempDbPath();
    const old = isoAt(BASE_MS, -10 * 86_400_000);
    const cutoff = isoAt(BASE_MS, -7 * 86_400_000);

    const empty = new SqliteOutboxBuffer(path);
    empty.upsertFlight(flightRecord());
    empty.finalizeFlight(FLIGHT_ID, isoAt(BASE_MS, 60_000), 'completed', {}, T0);
    empty.markFlightSynced(FLIGHT_ID, old);
    expect(empty.pruneSyncedBefore(cutoff).flights).toBe(1);
    expect(empty.getFlight(FLIGHT_ID)).toBeNull();
    empty.close();

    const withPending = new SqliteOutboxBuffer(tempDbPath());
    withPending.upsertFlight(flightRecord());
    withPending.appendPoints(FLIGHT_ID, [
      toTrackPoint(makeSample(T0), 1, { clientPointId: POINT_ID_1 }),
    ]);
    withPending.finalizeFlight(FLIGHT_ID, isoAt(BASE_MS, 60_000), 'completed', {}, T0);
    withPending.markFlightSynced(FLIGHT_ID, old);
    expect(withPending.pruneSyncedBefore(cutoff).flights).toBe(0);
    expect(withPending.getFlight(FLIGHT_ID)).not.toBeNull();
    withPending.close();
  });
});
