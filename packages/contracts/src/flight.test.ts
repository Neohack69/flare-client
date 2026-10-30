import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FLIGHT_SIM,
  flightCompleteSchema,
  flightCreateSchema,
  flightNoLandingKind,
  flightSchema,
  flightSimSchema,
  hasFlightLanding,
  simRunwaySchema,
} from './flight.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const STARTED_AT = '2026-01-01T10:00:00.000Z';
const ENDED_AT = '2026-01-01T11:00:00.000Z';

const base = {
  status: 'completed' as const,
  landings_count: 0,
  is_partial: false,
  touchdown_at: null,
};

describe('flightNoLandingKind', () => {
  it('посадка есть (landings_count) → none', () => {
    expect(flightNoLandingKind({ ...base, landings_count: 1 })).toBe('none');
  });

  it('посадка есть (touchdown_at) → none', () => {
    expect(
      flightNoLandingKind({ ...base, touchdown_at: '2026-01-01T11:00:00.000Z' }),
    ).toBe('none');
  });

  it('идущий рейс без касания — не «без посадки»', () => {
    expect(flightNoLandingKind({ ...base, status: 'in_progress' })).toBe('none');
  });

  it('отозванная запись (abandoned) — не рейс, «none»', () => {
    expect(flightNoLandingKind({ ...base, status: 'abandoned' })).toBe('none');
  });

  it('завершён без касания и без данных (is_partial) → interrupted', () => {
    expect(flightNoLandingKind({ ...base, is_partial: true })).toBe('interrupted');
  });

  it('завершён без касания, данные были → no_landing', () => {
    expect(flightNoLandingKind(base)).toBe('no_landing');
  });

  it('failed без касания → no_landing', () => {
    expect(flightNoLandingKind({ ...base, status: 'failed' })).toBe('no_landing');
  });
});

describe('hasFlightLanding', () => {
  it('ложь при нуле касаний и отсутствии времени касания', () => {
    expect(hasFlightLanding(base)).toBe(false);
  });

  it('истина при ненулевом числе касаний', () => {
    expect(hasFlightLanding({ ...base, landings_count: 2 })).toBe(true);
  });
});

describe('flight sim source (ADR-0023)', () => {
  const createBase = {
    client_flight_id: UUID,
    aircraft_icao: 'B738',
    started_at: STARTED_AT,
  };

  it('create/complete без sim валидны и поле остаётся отсутствующим (дефолт резолвит сервер)', () => {
    const created = flightCreateSchema.parse(createBase);
    expect(created.sim).toBeUndefined();

    const completed = flightCompleteSchema.parse({
      client_flight_id: UUID,
      ended_at: ENDED_AT,
    });
    expect(completed.sim).toBeUndefined();
  });

  it('принимает sim=xplane12 на create и complete (сим optional/additive)', () => {
    expect(flightCreateSchema.parse({ ...createBase, sim: 'xplane12' }).sim).toBe('xplane12');
    expect(flightCreateSchema.parse({ ...createBase, sim: 'msfs2024' }).sim).toBe('msfs2024');
    expect(
      flightCompleteSchema.parse({
        client_flight_id: UUID,
        ended_at: ENDED_AT,
        sim: 'xplane12',
      }).sim,
    ).toBe('xplane12');
  });

  it('отклоняет неизвестный sim (forward-compat только через явное расширение enum)', () => {
    expect(flightCreateSchema.safeParse({ ...createBase, sim: 'p3d' }).success).toBe(false);
    expect(
      flightCompleteSchema.safeParse({
        client_flight_id: UUID,
        ended_at: ENDED_AT,
        sim: 'fsx',
      }).success,
    ).toBe(false);
    expect(flightSimSchema.safeParse('xplane12').success).toBe(true);
    expect(flightSimSchema.safeParse('p3d').success).toBe(false);
  });

  it('flightSchema (ответ): при отсутствии sim подставляет msfs2024 — обратная совместимость', () => {
    const minimal = {
      id: UUID,
      user_id: UUID,
      device_id: null,
      client_flight_id: UUID,
      aircraft_icao: null,
      callsign: null,
      origin_icao: null,
      destination_icao: null,
      started_at: STARTED_AT,
      server_received_at: STARTED_AT,
      ended_at: null,
      duration_s: null,
      distance_m: null,
      max_altitude_ft: null,
      touchdown_at: null,
      created_at: STARTED_AT,
      updated_at: STARTED_AT,
    };

    const parsed = flightSchema.parse(minimal);
    expect(parsed.sim).toBe(DEFAULT_FLIGHT_SIM);
    expect(parsed.sim).toBe('msfs2024');

    expect(flightSchema.parse({ ...minimal, sim: 'xplane12' }).sim).toBe('xplane12');
    expect(flightSchema.safeParse({ ...minimal, sim: 'p3d' }).success).toBe(false);
  });
});

const SIM_RUNWAY = {
  ident: '03R',
  threshold: { lat: 40.10036, lon: 32.98973, elev_ft: 3125 },
  end: { lat: 40.12762, lon: 33.01571, elev_ft: 3125 },
  width_m: 45,
  length_m: 3755.3,
  heading_deg: 36.1,
  surface_code: 1,
};

describe('sim_runway (R1)', () => {
  it('принимает геометрию ВПП от симулятора в /complete', () => {
    const parsed = flightCompleteSchema.parse({
      client_flight_id: UUID,
      ended_at: ENDED_AT,
      sim_runway: SIM_RUNWAY,
    });
    expect(parsed.sim_runway?.ident).toBe('03R');
    expect(parsed.sim_runway?.length_m).toBeCloseTo(3755.3, 1);
    expect(simRunwaySchema.safeParse(SIM_RUNWAY).success).toBe(true);
  });

  it('отклоняет невалидные payload-ы (габариты/курс/координаты/ident)', () => {
    expect(simRunwaySchema.safeParse({ ...SIM_RUNWAY, width_m: 10 }).success).toBe(false);
    expect(simRunwaySchema.safeParse({ ...SIM_RUNWAY, width_m: 101 }).success).toBe(false);
    expect(simRunwaySchema.safeParse({ ...SIM_RUNWAY, length_m: 100 }).success).toBe(false);
    expect(simRunwaySchema.safeParse({ ...SIM_RUNWAY, length_m: 6001 }).success).toBe(false);
    expect(simRunwaySchema.safeParse({ ...SIM_RUNWAY, heading_deg: 361 }).success).toBe(false);
    expect(simRunwaySchema.safeParse({ ...SIM_RUNWAY, ident: '' }).success).toBe(false);
    expect(simRunwaySchema.safeParse({ ...SIM_RUNWAY, ident: '123456789' }).success).toBe(false);
    expect(
      simRunwaySchema.safeParse({
        ...SIM_RUNWAY,
        threshold: { lat: 91, lon: 32.98 },
      }).success,
    ).toBe(false);
    expect(
      flightCompleteSchema.safeParse({
        client_flight_id: UUID,
        ended_at: ENDED_AT,
        sim_runway: { ...SIM_RUNWAY, width_m: 0 },
      }).success,
    ).toBe(false);
  });
});

