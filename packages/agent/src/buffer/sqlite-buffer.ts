import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
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

type SqliteDatabase = InstanceType<typeof Database>;

interface FlightRow {
  client_flight_id: string;
  aircraft_icao: string;
  callsign: string | null;
  origin_icao: string | null;
  destination_icao: string | null;
  device_id: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  stats: string;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

interface PointRow {
  payload: string;
  synced_at: string | null;
}

interface EventRow {
  payload: string;
  synced_at: string | null;
}

interface CountRow {
  value: number;
}

interface LegacyPointRow {
  client_flight_id: string;
  seq: number;
  ts: string;
  payload: string;
  synced_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox_flights (
  client_flight_id TEXT PRIMARY KEY,
  aircraft_icao    TEXT NOT NULL,
  callsign         TEXT,
  origin_icao      TEXT,
  destination_icao TEXT,
  device_id        TEXT,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  status           TEXT NOT NULL DEFAULT 'in_progress',
  stats            TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  synced_at        TEXT
);

CREATE TABLE IF NOT EXISTS outbox_points (
  client_flight_id TEXT NOT NULL,
  client_point_id  TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  ts               TEXT NOT NULL,
  payload          TEXT NOT NULL,
  synced_at        TEXT,
  PRIMARY KEY (client_flight_id, client_point_id)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  client_flight_id TEXT NOT NULL,
  client_event_id  TEXT NOT NULL,
  type             TEXT NOT NULL,
  ts               TEXT NOT NULL,
  payload          TEXT NOT NULL,
  synced_at        TEXT,
  PRIMARY KEY (client_flight_id, client_event_id)
);

CREATE INDEX IF NOT EXISTS ix_outbox_points_pending
  ON outbox_points(client_flight_id, seq) WHERE synced_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_outbox_events_pending
  ON outbox_events(client_flight_id, ts) WHERE synced_at IS NULL;
`;

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

/**
 * Durable-буфер офлайн-синхронизации на SQLite (`better-sqlite3`, ADR-0007).
 * Точки и события append-only с идемпотентными первичными ключами, поэтому
 * повторная запись/дозаливка не создаёт дублей.
 */
export class SqliteOutboxBuffer implements OutboxBuffer {
  private readonly db: SqliteDatabase;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.migrateLegacyPointsTable();
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  upsertFlight(flight: OutboxFlight): void {
    this.db
      .prepare(
        `INSERT INTO outbox_flights (
           client_flight_id, aircraft_icao, callsign, origin_icao, destination_icao,
           device_id, started_at, ended_at, status, stats, created_at, updated_at, synced_at
         ) VALUES (
           @client_flight_id, @aircraft_icao, @callsign, @origin_icao, @destination_icao,
           @device_id, @started_at, @ended_at, @status, @stats, @created_at, @updated_at, @synced_at
         )
         ON CONFLICT(client_flight_id) DO UPDATE SET
           aircraft_icao    = excluded.aircraft_icao,
           callsign         = excluded.callsign,
           origin_icao      = excluded.origin_icao,
           destination_icao = excluded.destination_icao,
           device_id        = excluded.device_id,
           started_at       = excluded.started_at,
           updated_at       = excluded.updated_at`,
      )
      .run({
        ...flight,
        stats: JSON.stringify(flight.stats),
      });
  }

  finalizeFlight(
    clientFlightId: string,
    endedAt: string,
    status: OutboxFlightStatus,
    stats: Record<string, unknown>,
    updatedAt: string,
  ): void {
    this.db
      .prepare(
        `UPDATE outbox_flights
            SET ended_at = @ended_at, status = @status, stats = @stats, updated_at = @updated_at
          WHERE client_flight_id = @client_flight_id`,
      )
      .run({
        client_flight_id: clientFlightId,
        ended_at: endedAt,
        status,
        stats: JSON.stringify(stats),
        updated_at: updatedAt,
      });
  }

  appendPoints(clientFlightId: string, points: readonly TrackPoint[]): number {
    if (points.length === 0) return 0;
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO outbox_points
         (client_flight_id, client_point_id, seq, ts, payload, synced_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    );
    const insertMany = this.db.transaction((rows: readonly TrackPoint[]) => {
      let inserted = 0;
      for (const point of rows) {
        const result = statement.run(
          clientFlightId,
          point.client_point_id,
          point.seq,
          point.ts,
          JSON.stringify(point),
        );
        inserted += result.changes;
      }
      return inserted;
    });
    return insertMany(points);
  }

  appendEvents(clientFlightId: string, events: readonly FlightEvent[]): number {
    if (events.length === 0) return 0;
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO outbox_events (client_flight_id, client_event_id, type, ts, payload, synced_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    );
    const insertMany = this.db.transaction((rows: readonly FlightEvent[]) => {
      let inserted = 0;
      for (const event of rows) {
        const result = statement.run(
          clientFlightId,
          event.client_event_id,
          event.type,
          event.ts,
          JSON.stringify(event),
        );
        inserted += result.changes;
      }
      return inserted;
    });
    return insertMany(events);
  }

  getFlight(clientFlightId: string): OutboxFlight | null {
    const row = this.db
      .prepare('SELECT * FROM outbox_flights WHERE client_flight_id = ?')
      .get(clientFlightId) as FlightRow | undefined;
    return row ? toFlight(row) : null;
  }

  loadFlights(status?: OutboxFlightStatus): OutboxFlight[] {
    const rows = (
      status
        ? this.db
            .prepare('SELECT * FROM outbox_flights WHERE status = ? ORDER BY started_at')
            .all(status)
        : this.db.prepare('SELECT * FROM outbox_flights ORDER BY started_at').all()
    ) as FlightRow[];
    return rows.map(toFlight);
  }

  loadPoints(clientFlightId: string): OutboxPointRecord[] {
    const rows = this.db
      .prepare(
        'SELECT payload, synced_at FROM outbox_points WHERE client_flight_id = ? ORDER BY seq',
      )
      .all(clientFlightId) as PointRow[];
    return rows.map((row) => ({
      ...parseJson<TrackPoint>(row.payload),
      client_flight_id: clientFlightId,
      synced_at: row.synced_at,
    }));
  }

  loadEvents(clientFlightId: string): OutboxEventRecord[] {
    const rows = this.db
      .prepare(
        'SELECT payload, synced_at FROM outbox_events WHERE client_flight_id = ? ORDER BY ts',
      )
      .all(clientFlightId) as EventRow[];
    return rows.map((row) => ({
      ...parseJson<FlightEvent>(row.payload),
      client_flight_id: clientFlightId,
      synced_at: row.synced_at,
    }));
  }

  pendingCounts(): OutboxCounts {
    // SEC-SQL1: только статические SQL-строки; никаких интерполяций
    // идентификаторов/условий (таблицы — из фиксированного набора).
    return {
      flights: this.scalar('SELECT COUNT(*) AS value FROM outbox_flights'),
      points: this.scalar('SELECT COUNT(*) AS value FROM outbox_points'),
      events: this.scalar('SELECT COUNT(*) AS value FROM outbox_events'),
      pendingFlights: this.scalar(
        'SELECT COUNT(*) AS value FROM outbox_flights WHERE synced_at IS NULL',
      ),
      pendingPoints: this.scalar(
        'SELECT COUNT(*) AS value FROM outbox_points WHERE synced_at IS NULL',
      ),
      pendingEvents: this.scalar(
        'SELECT COUNT(*) AS value FROM outbox_events WHERE synced_at IS NULL',
      ),
    };
  }

  markFlightSynced(clientFlightId: string, syncedAt: string): void {
    this.db
      .prepare('UPDATE outbox_flights SET synced_at = ? WHERE client_flight_id = ?')
      .run(syncedAt, clientFlightId);
  }

  markPointsSynced(
    clientFlightId: string,
    clientPointIds: readonly string[],
    syncedAt: string,
  ): void {
    if (clientPointIds.length === 0) return;
    const statement = this.db.prepare(
      `UPDATE outbox_points SET synced_at = @synced_at
        WHERE client_flight_id = @client_flight_id
          AND client_point_id = @id AND synced_at IS NULL`,
    );
    const updateMany = this.db.transaction((ids: readonly string[]) => {
      for (const id of ids) {
        statement.run({ client_flight_id: clientFlightId, id, synced_at: syncedAt });
      }
    });
    updateMany(clientPointIds);
  }

  updatePointQuality(clientFlightId: string, updates: readonly PointQualityUpdate[]): number {
    if (updates.length === 0) return 0;
    const select = this.db.prepare(
      `SELECT payload FROM outbox_points
        WHERE client_flight_id = ? AND client_point_id = ?`,
    );
    const update = this.db.prepare(
      `UPDATE outbox_points SET payload = ?
        WHERE client_flight_id = ? AND client_point_id = ?`,
    );
    const updateMany = this.db.transaction((rows: readonly PointQualityUpdate[]) => {
      let changed = 0;
      for (const { client_point_id, quality } of rows) {
        const row = select.get(clientFlightId, client_point_id) as { payload: string } | undefined;
        if (!row) continue;
        const point = parseJson<TrackPoint>(row.payload);
        if (point.quality === quality) continue;
        point.quality = quality;
        changed += update.run(JSON.stringify(point), clientFlightId, client_point_id).changes;
      }
      return changed;
    });
    return updateMany(updates);
  }

  markEventsSynced(
    clientFlightId: string,
    clientEventIds: readonly string[],
    syncedAt: string,
  ): void {
    if (clientEventIds.length === 0) return;
    const statement = this.db.prepare(
      `UPDATE outbox_events SET synced_at = @synced_at
        WHERE client_flight_id = @client_flight_id AND client_event_id = @id AND synced_at IS NULL`,
    );
    const updateMany = this.db.transaction((ids: readonly string[]) => {
      for (const id of ids) {
        statement.run({ client_flight_id: clientFlightId, id, synced_at: syncedAt });
      }
    });
    updateMany(clientEventIds);
  }

  /**
   * CD-3.4: удаляет синхронизированные строки старше `cutoffIso` (ISO UTC).
   * Pending (`synced_at IS NULL`) не трогает; рейс удаляется, только если
   * завершён и у него не осталось pending-точек/событий.
   */
  pruneSyncedBefore(cutoffIso: string): OutboxPruneSummary {
    const run = this.db.transaction((cutoff: string): OutboxPruneSummary => {
      const points = this.db
        .prepare('DELETE FROM outbox_points WHERE synced_at IS NOT NULL AND synced_at < ?')
        .run(cutoff).changes;
      const events = this.db
        .prepare('DELETE FROM outbox_events WHERE synced_at IS NOT NULL AND synced_at < ?')
        .run(cutoff).changes;
      const flights = this.db
        .prepare(
          `DELETE FROM outbox_flights
             WHERE synced_at IS NOT NULL AND synced_at < @cutoff AND status = 'completed'
               AND NOT EXISTS (
                 SELECT 1 FROM outbox_points p
                  WHERE p.client_flight_id = outbox_flights.client_flight_id
                    AND p.synced_at IS NULL
               )
               AND NOT EXISTS (
                 SELECT 1 FROM outbox_events e
                  WHERE e.client_flight_id = outbox_flights.client_flight_id
                    AND e.synced_at IS NULL
               )`,
        )
        .run({ cutoff }).changes;
      return { flights, points, events };
    });
    return run(cutoffIso);
  }

  /** CD-3.4: `PRAGMA wal_checkpoint(TRUNCATE)` — усадка WAL после очистки. */
  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /**
   * Переход со старого PK `(client_flight_id, seq)` на `(client_flight_id,
   * client_point_id)` (ADR-0007) с сохранением уже записанных точек. Старым
   * строкам без `client_point_id` назначается новый UUID.
   */
  private migrateLegacyPointsTable(): void {
    const columns = this.db.prepare('PRAGMA table_info(outbox_points)').all() as Array<{
      name: string;
    }>;
    if (columns.length === 0) return;
    if (columns.some((column) => column.name === 'client_point_id')) return;

    const legacy = this.db
      .prepare('SELECT client_flight_id, seq, ts, payload, synced_at FROM outbox_points')
      .all() as LegacyPointRow[];

    this.db.exec('DROP TABLE outbox_points');
    this.db.exec(`
      CREATE TABLE outbox_points (
        client_flight_id TEXT NOT NULL,
        client_point_id  TEXT NOT NULL,
        seq              INTEGER NOT NULL,
        ts               TEXT NOT NULL,
        payload          TEXT NOT NULL,
        synced_at        TEXT,
        PRIMARY KEY (client_flight_id, client_point_id)
      );
    `);

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO outbox_points
         (client_flight_id, client_point_id, seq, ts, payload, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const migrate = this.db.transaction((rows: readonly LegacyPointRow[]) => {
      for (const row of rows) {
        const point = parseJson<TrackPoint>(row.payload);
        const clientPointId = point.client_point_id ?? randomUUID();
        const payload = JSON.stringify({ ...point, client_point_id: clientPointId });
        insert.run(row.client_flight_id, clientPointId, row.seq, row.ts, payload, row.synced_at);
      }
    });
    migrate(legacy);
  }

  /**
   * SEC-SQL1: исполняет статический COUNT-запрос. `sql` — только строковый
   * литерал места вызова (фиксированный набор таблиц), значение cutoff и любые
   * данные уходят bind-параметрами, а не интерполяцией.
   */
  private scalar(sql: string): number {
    const row = this.db.prepare(sql).get() as CountRow;
    return row.value;
  }
}

function toFlight(row: FlightRow): OutboxFlight {
  return {
    client_flight_id: row.client_flight_id,
    aircraft_icao: row.aircraft_icao,
    callsign: row.callsign,
    origin_icao: row.origin_icao,
    destination_icao: row.destination_icao,
    device_id: row.device_id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    status: row.status === 'completed' ? 'completed' : 'in_progress',
    stats: parseJson<Record<string, unknown>>(row.stats),
    created_at: row.created_at,
    updated_at: row.updated_at,
    synced_at: row.synced_at,
  };
}
