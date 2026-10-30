import type { FlightEvent, TrackPoint } from '@flightlog/contracts';

export type OutboxFlightStatus = 'in_progress' | 'completed';

/** Рейс в локальном outbox-буфере (ADR-0007 §1). */
export interface OutboxFlight {
  client_flight_id: string;
  aircraft_icao: string;
  callsign: string | null;
  origin_icao: string | null;
  destination_icao: string | null;
  device_id: string | null;
  started_at: string;
  ended_at: string | null;
  status: OutboxFlightStatus;
  stats: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export interface OutboxCounts {
  flights: number;
  points: number;
  events: number;
  pendingFlights: number;
  pendingPoints: number;
  pendingEvents: number;
}

export interface OutboxPointRecord extends TrackPoint {
  client_flight_id: string;
  synced_at: string | null;
}

export interface OutboxEventRecord extends FlightEvent {
  client_flight_id: string;
  synced_at: string | null;
}

/**
 * Локальный durable-буфер агента. Переживает рестарт процесса (SQLite).
 * Синхронизация с API (T10) в этой задаче НЕ реализуется — сетевой слой
 * зависит от device flow (T31). Интерфейс уже содержит `mark*Synced` для T10.
 */
export interface OutboxBuffer {
  upsertFlight(flight: OutboxFlight): void;
  finalizeFlight(
    clientFlightId: string,
    endedAt: string,
    status: OutboxFlightStatus,
    stats: Record<string, unknown>,
    updatedAt: string,
  ): void;
  appendPoints(clientFlightId: string, points: readonly TrackPoint[]): number;
  appendEvents(clientFlightId: string, events: readonly FlightEvent[]): number;
  getFlight(clientFlightId: string): OutboxFlight | null;
  loadFlights(status?: OutboxFlightStatus): OutboxFlight[];
  loadPoints(clientFlightId: string): OutboxPointRecord[];
  loadEvents(clientFlightId: string): OutboxEventRecord[];
  pendingCounts(): OutboxCounts;
  markFlightSynced(clientFlightId: string, syncedAt: string): void;
  /** Синхронизация помечается списком `client_point_id` (ADR-0007), а не `seq`. */
  markPointsSynced(
    clientFlightId: string,
    clientPointIds: readonly string[],
    syncedAt: string,
  ): void;
  markEventsSynced(
    clientFlightId: string,
    clientEventIds: readonly string[],
    syncedAt: string,
  ): void;
  /** Досыпать `quality`-биты уже материализованным точкам (оценка окна касания). */
  updatePointQuality(clientFlightId: string, updates: readonly PointQualityUpdate[]): number;
  /**
   * CD-3.4: удаляет синхронизированные строки старше `cutoffIso` (точки/события/
   * рейсы). **Pending не удаляются автоматически.** Опционально: in-memory
   * реализация может не поддерживать.
   */
  pruneSyncedBefore?(cutoffIso: string): OutboxPruneSummary;
  /** CD-3.4: `PRAGMA wal_checkpoint(TRUNCATE)` по политике (SQLite; no-op иначе). */
  checkpoint?(): void;
}

/** Сколько synced-строк удалено при очистке буфера (CD-3.4). */
export interface OutboxPruneSummary {
  flights: number;
  points: number;
  events: number;
}

export interface PointQualityUpdate {
  client_point_id: string;
  quality: number;
}
