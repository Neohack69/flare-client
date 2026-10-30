import type { FlightEvent, TrackPoint } from '@flightlog/contracts';

import type { OutboxBuffer } from '../buffer/types.js';
import { toFlightEvent, toTrackPoint } from '../flight/build.js';
import { BASE_MS, isoAt, makeSample } from './telemetry-fixture.js';

export interface SeedCompletedFlightOptions {
  idGenerator: () => string;
  points?: number;
  events?: number;
  aircraftIcao?: string;
}

/**
 * Кладёт в outbox завершённый рейс с несинхронизированными точками/событиями —
 * имитация сессии, которая оборвалась до финального синка (баг `sim_disconnected`).
 */
export function seedCompletedFlight(
  buffer: OutboxBuffer,
  options: SeedCompletedFlightOptions,
): { flightId: string; points: TrackPoint[]; events: FlightEvent[] } {
  const { idGenerator: ids } = options;
  const flightId = ids();
  buffer.upsertFlight({
    client_flight_id: flightId,
    aircraft_icao: options.aircraftIcao ?? 'B738',
    callsign: null,
    origin_icao: null,
    destination_icao: null,
    device_id: null,
    started_at: isoAt(BASE_MS, 0),
    ended_at: null,
    status: 'in_progress',
    stats: {},
    created_at: isoAt(BASE_MS, 0),
    updated_at: isoAt(BASE_MS, 0),
    synced_at: null,
  });

  const points: TrackPoint[] = [];
  for (let i = 0; i < (options.points ?? 3); i += 1) {
    points.push(
      toTrackPoint(makeSample(isoAt(BASE_MS, i * 1000)), i + 1, { clientPointId: ids() }),
    );
  }
  buffer.appendPoints(flightId, points);

  const events: FlightEvent[] = [];
  for (let i = 0; i < (options.events ?? 1); i += 1) {
    events.push(
      toFlightEvent(
        'touchdown',
        makeSample(isoAt(BASE_MS, (i + 1) * 1000)),
        { vs_fpm: -150 },
        ids(),
      ),
    );
  }
  buffer.appendEvents(flightId, events);

  buffer.finalizeFlight(
    flightId,
    isoAt(BASE_MS, 60_000),
    'completed',
    { is_partial: false, paused_total_s: 0, quality_flags: 0 },
    isoAt(BASE_MS, 60_000),
  );

  return { flightId, points, events };
}
