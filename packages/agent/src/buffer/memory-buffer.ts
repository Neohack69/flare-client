import type { FlightEvent, TrackPoint } from '@flightlog/contracts';

import type {
  OutboxBuffer,
  OutboxCounts,
  OutboxEventRecord,
  OutboxFlight,
  OutboxFlightStatus,
  OutboxPointRecord,
  OutboxPruneSummary,
  PointQualityUpdate,
} from './types.js';

interface PointRow {
  clientFlightId: string;
  point: TrackPoint;
  syncedAt: string | null;
}

interface EventRow {
  clientFlightId: string;
  event: FlightEvent;
  syncedAt: string | null;
}

/**
 * Недолговечный in-memory буфер. Используется в тестах и как fallback, когда
 * SQLite недоступен. Для реального офлайн-режима — `SqliteOutboxBuffer`.
 */
export class MemoryOutboxBuffer implements OutboxBuffer {
  private readonly flights = new Map<string, OutboxFlight>();
  private readonly points = new Map<string, Map<string, PointRow>>();
  private readonly events = new Map<string, Map<string, EventRow>>();

  upsertFlight(flight: OutboxFlight): void {
    const existing = this.flights.get(flight.client_flight_id);
    if (existing) {
      this.flights.set(flight.client_flight_id, {
        ...existing,
        ...flight,
        ended_at: flight.ended_at ?? existing.ended_at,
        synced_at: existing.synced_at,
      });
      return;
    }
    this.flights.set(flight.client_flight_id, flight);
  }

  finalizeFlight(
    clientFlightId: string,
    endedAt: string,
    status: OutboxFlightStatus,
    stats: Record<string, unknown>,
    updatedAt: string,
  ): void {
    const existing = this.flights.get(clientFlightId);
    if (!existing) return;
    this.flights.set(clientFlightId, {
      ...existing,
      ended_at: endedAt,
      status,
      stats,
      updated_at: updatedAt,
    });
  }

  appendPoints(clientFlightId: string, points: readonly TrackPoint[]): number {
    let inserted = 0;
    let bucket = this.points.get(clientFlightId);
    if (!bucket) {
      bucket = new Map<string, PointRow>();
      this.points.set(clientFlightId, bucket);
    }
    for (const point of points) {
      if (bucket.has(point.client_point_id)) continue;
      bucket.set(point.client_point_id, { clientFlightId, point, syncedAt: null });
      inserted += 1;
    }
    return inserted;
  }

  appendEvents(clientFlightId: string, events: readonly FlightEvent[]): number {
    let inserted = 0;
    let bucket = this.events.get(clientFlightId);
    if (!bucket) {
      bucket = new Map<string, EventRow>();
      this.events.set(clientFlightId, bucket);
    }
    for (const event of events) {
      if (bucket.has(event.client_event_id)) continue;
      bucket.set(event.client_event_id, { clientFlightId, event, syncedAt: null });
      inserted += 1;
    }
    return inserted;
  }

  getFlight(clientFlightId: string): OutboxFlight | null {
    return this.flights.get(clientFlightId) ?? null;
  }

  loadFlights(status?: OutboxFlightStatus): OutboxFlight[] {
    const all = [...this.flights.values()];
    return status ? all.filter((flight) => flight.status === status) : all;
  }

  loadPoints(clientFlightId: string): OutboxPointRecord[] {
    const bucket = this.points.get(clientFlightId);
    if (!bucket) return [];
    return [...bucket.values()]
      .sort((a, b) => a.point.seq - b.point.seq)
      .map((row) => ({
        ...row.point,
        client_flight_id: row.clientFlightId,
        synced_at: row.syncedAt,
      }));
  }

  loadEvents(clientFlightId: string): OutboxEventRecord[] {
    const bucket = this.events.get(clientFlightId);
    if (!bucket) return [];
    return [...bucket.values()]
      .sort((a, b) => a.event.ts.localeCompare(b.event.ts))
      .map((row) => ({
        ...row.event,
        client_flight_id: row.clientFlightId,
        synced_at: row.syncedAt,
      }));
  }

  pendingCounts(): OutboxCounts {
    const points = [...this.points.values()].flatMap((bucket) => [...bucket.values()]);
    const events = [...this.events.values()].flatMap((bucket) => [...bucket.values()]);
    const flights = [...this.flights.values()];
    return {
      flights: flights.length,
      points: points.length,
      events: events.length,
      pendingFlights: flights.filter((flight) => flight.synced_at === null).length,
      pendingPoints: points.filter((row) => row.syncedAt === null).length,
      pendingEvents: events.filter((row) => row.syncedAt === null).length,
    };
  }

  markFlightSynced(clientFlightId: string, syncedAt: string): void {
    const existing = this.flights.get(clientFlightId);
    if (existing) this.flights.set(clientFlightId, { ...existing, synced_at: syncedAt });
  }

  markPointsSynced(
    clientFlightId: string,
    clientPointIds: readonly string[],
    syncedAt: string,
  ): void {
    const bucket = this.points.get(clientFlightId);
    if (!bucket) return;
    for (const id of clientPointIds) {
      const row = bucket.get(id);
      if (row && row.syncedAt === null) bucket.set(id, { ...row, syncedAt });
    }
  }

  updatePointQuality(clientFlightId: string, updates: readonly PointQualityUpdate[]): number {
    const bucket = this.points.get(clientFlightId);
    if (!bucket) return 0;
    let changed = 0;
    for (const { client_point_id, quality } of updates) {
      const row = bucket.get(client_point_id);
      if (!row || row.point.quality === quality) continue;
      bucket.set(client_point_id, { ...row, point: { ...row.point, quality } });
      changed += 1;
    }
    return changed;
  }

  markEventsSynced(
    clientFlightId: string,
    clientEventIds: readonly string[],
    syncedAt: string,
  ): void {
    const bucket = this.events.get(clientFlightId);
    if (!bucket) return;
    for (const id of clientEventIds) {
      const row = bucket.get(id);
      if (row && row.syncedAt === null) bucket.set(id, { ...row, syncedAt });
    }
  }

  /** CD-3.4: паритет с SQLite-буфером (тесты/fallback). Pending не трогает. */
  pruneSyncedBefore(cutoffIso: string): OutboxPruneSummary {
    let points = 0;
    for (const bucket of this.points.values()) {
      for (const [id, row] of [...bucket.entries()]) {
        if (row.syncedAt !== null && row.syncedAt < cutoffIso) {
          bucket.delete(id);
          points += 1;
        }
      }
    }

    let events = 0;
    for (const bucket of this.events.values()) {
      for (const [id, row] of [...bucket.entries()]) {
        if (row.syncedAt !== null && row.syncedAt < cutoffIso) {
          bucket.delete(id);
          events += 1;
        }
      }
    }

    let flights = 0;
    for (const [id, flight] of [...this.flights.entries()]) {
      if (flight.synced_at === null || flight.synced_at >= cutoffIso) continue;
      if (flight.status !== 'completed') continue;
      const pointBucket = this.points.get(id);
      const eventBucket = this.events.get(id);
      const pendingPoint = pointBucket
        ? [...pointBucket.values()].some((row) => row.syncedAt === null)
        : false;
      const pendingEvent = eventBucket
        ? [...eventBucket.values()].some((row) => row.syncedAt === null)
        : false;
      if (pendingPoint || pendingEvent) continue;
      this.flights.delete(id);
      flights += 1;
    }

    return { flights, points, events };
  }

  checkpoint(): void {
    // In-memory: WAL-политика неприменима.
  }
}
