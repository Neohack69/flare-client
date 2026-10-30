/**
 * Просмотр локального outbox-буфера агента (read-only, для диагностики синка).
 *
 * Запуск (после `pnpm --filter @flightlog/agent build`):
 *   pnpm --filter @flightlog/agent buffer:stats
 *
 * Путь берётся из `AGENT_OUTBOX_PATH`, иначе `AGENT_DATA_DIR`/agent-outbox.sqlite,
 * иначе `~/.flightlog/agent-outbox.sqlite`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

const dataDir = process.env.AGENT_DATA_DIR ?? join(homedir(), '.flightlog');
const outboxPath = process.env.AGENT_OUTBOX_PATH ?? join(dataDir, 'agent-outbox.sqlite');

let db;
try {
  db = new Database(outboxPath, { readonly: true, fileMustExist: true });
} catch (error) {
  console.error(`[buffer] cannot open ${outboxPath}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

try {
  const counts = {
    flights: db.prepare('SELECT COUNT(*) AS value FROM outbox_flights').get().value,
    pending_flights: db
      .prepare('SELECT COUNT(*) AS value FROM outbox_flights WHERE synced_at IS NULL')
      .get().value,
    points: db.prepare('SELECT COUNT(*) AS value FROM outbox_points').get().value,
    pending_points: db
      .prepare('SELECT COUNT(*) AS value FROM outbox_points WHERE synced_at IS NULL')
      .get().value,
    events: db.prepare('SELECT COUNT(*) AS value FROM outbox_events').get().value,
    pending_events: db
      .prepare('SELECT COUNT(*) AS value FROM outbox_events WHERE synced_at IS NULL')
      .get().value,
  };

  const flights = db
    .prepare(
      `SELECT client_flight_id, aircraft_icao, status, started_at, ended_at, synced_at
         FROM outbox_flights ORDER BY started_at DESC LIMIT 10`,
    )
    .all();

  console.log(JSON.stringify({ path: outboxPath, counts, recent_flights: flights }, null, 2));
} finally {
  db.close();
}
