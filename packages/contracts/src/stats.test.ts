import { describe, expect, it } from 'vitest';

import { mapStatsResponseSchema } from './stats.js';
import { publicFlightSchema } from './sharing.js';
import { schemas } from './index.js';

const NOW = '2026-09-29T12:00:00.000Z';
const UUID = '123e4567-e89b-42d3-a456-426614174000';

/** Минимальный валидный ответ (пустой аккаунт): нули/`null`/`[]`, не 404. */
function emptyResponse() {
  return {
    data: {
      totals: {
        flights: 0,
        hours_airborne: 0,
        hours_block: 0,
        distance_m: 0,
        distance_nm: 0,
        distance_km: 0,
        flights_with_track: 0,
        flights_with_airborne: 0,
        first_flight_at: null,
      },
      farthest_flight: null,
      countries_count: 0,
      airports_count: 0,
      countries: [],
      aircraft: [],
    },
    meta: {
      generated_at: NOW,
      top_aircraft: 8,
      aircraft_total: 0,
      truncated_aircraft: false,
      airports_per_country_limit: 20,
      truncated_countries: false,
    },
  };
}

function filledResponse() {
  return {
    data: {
      totals: {
        flights: 3,
        hours_airborne: 47.2,
        hours_block: 52.4,
        distance_m: 23_113_000,
        distance_nm: 12_480,
        distance_km: 23_113,
        flights_with_track: 2,
        flights_with_airborne: 2,
        first_flight_at: NOW,
      },
      farthest_flight: {
        flight_id: UUID,
        distance_m: 5_563_000,
        distance_nm: 3004,
        distance_km: 5563,
        origin_icao: 'EGLL',
        destination_icao: 'KJFK',
        aircraft_icao: 'B738',
        started_at: NOW,
      },
      countries_count: 1,
      airports_count: 1,
      countries: [
        {
          country_code: 'GB',
          airport_count: 1,
          first_visited_at: NOW,
          airports: [{ icao: 'EGLL', iata: 'LHR', name: 'London Heathrow' }],
        },
      ],
      aircraft: [
        { aircraft_icao: 'B738', flights: 2, hours: 47.2, distance_nm: 12_480 },
        { aircraft_icao: null, flights: 1, hours: 0, distance_nm: 0 },
      ],
    },
    meta: {
      generated_at: NOW,
      top_aircraft: 8,
      aircraft_total: 2,
      truncated_aircraft: false,
      airports_per_country_limit: 20,
      truncated_countries: false,
    },
  };
}

describe('contracts — map stats (ADR-0019 §4.1)', () => {
  it('принимает полный ответ и пустой аккаунт (нули/`null`/`[]`)', () => {
    expect(mapStatsResponseSchema.safeParse(filledResponse()).success).toBe(true);
    expect(mapStatsResponseSchema.safeParse(emptyResponse()).success).toBe(true);
  });

  it('пустой аккаунт: `farthest_flight=null`, `first_flight_at=null`, нулевые счётчики', () => {
    const parsed = mapStatsResponseSchema.parse(emptyResponse());
    expect(parsed.data.farthest_flight).toBeNull();
    expect(parsed.data.totals.first_flight_at).toBeNull();
    expect(parsed.data.countries_count).toBe(0);
    expect(parsed.data.airports_count).toBe(0);
    expect(parsed.data.countries).toEqual([]);
    expect(parsed.data.aircraft).toEqual([]);
  });

  it('strict: отклоняет неизвестные поля (в т.ч. приватные user_id/airborne_s)', () => {
    const base = filledResponse();
    expect(
      mapStatsResponseSchema.safeParse({ ...base, user_id: UUID }).success,
    ).toBe(false);
    expect(
      mapStatsResponseSchema.safeParse({
        ...base,
        data: { ...base.data, totals: { ...base.data.totals, airborne_s: 1 } },
      }).success,
    ).toBe(false);
    expect(
      mapStatsResponseSchema.safeParse({
        ...base,
        data: { ...base.data, countries: [{ ...base.data.countries[0]!, extra: 1 }] },
      }).success,
    ).toBe(false);
  });

  it('отклоняет некорректные значения (отрицательные, не-UTC дата, плохой ISO-код)', () => {
    const base = filledResponse();
    expect(
      mapStatsResponseSchema.safeParse({
        ...base,
        data: { ...base.data, totals: { ...base.data.totals, flights: -1 } },
      }).success,
    ).toBe(false);
    expect(
      mapStatsResponseSchema.safeParse({
        ...base,
        data: { ...base.data, countries_count: -2 },
      }).success,
    ).toBe(false);
    expect(
      mapStatsResponseSchema.safeParse({
        ...base,
        meta: { ...base.meta, generated_at: '2026-09-29T12:00:00+03:00' },
      }).success,
    ).toBe(false);
    expect(
      mapStatsResponseSchema.safeParse({
        ...base,
        data: {
          ...base.data,
          countries: [{ ...base.data.countries[0]!, country_code: 'gb' }],
        },
      }).success,
    ).toBe(false);
    expect(
      mapStatsResponseSchema.safeParse({
        ...base,
        data: {
          ...base.data,
          farthest_flight: { ...base.data.farthest_flight!, aircraft_icao: 'X' },
        },
      }).success,
    ).toBe(false);
  });

  it('схемы экспортированы из index (schemas namespace)', () => {
    expect(schemas.mapStatsResponseSchema).toBe(mapStatsResponseSchema);
  });

  it('ST-03: публичный whitelist не принимает новые приватные поля', () => {
    const publicFlight = {
      id: UUID,
      aircraft_icao: 'B738',
      aircraft: null,
      callsign: null,
      origin_icao: null,
      destination_icao: null,
      status: 'completed',
      started_at: NOW,
      ended_at: NOW,
      duration_s: 60,
      distance_m: 1000,
      max_altitude_ft: 2000,
      touchdown_at: NOW,
      score: null,
      quality: { is_partial: false, leaderboard_eligible: true, quality_flags: 0 },
    };
    expect(publicFlightSchema.safeParse(publicFlight).success).toBe(true);
    // `airborne_s` и агрегаты налёта не должны протекать в публичный ответ.
    expect(publicFlightSchema.safeParse({ ...publicFlight, airborne_s: 120 }).success).toBe(false);
    expect(publicFlightSchema.safeParse({ ...publicFlight, countries_count: 3 }).success).toBe(
      false,
    );
    expect(publicFlightSchema.safeParse({ ...publicFlight, user_id: UUID }).success).toBe(false);
  });
});
