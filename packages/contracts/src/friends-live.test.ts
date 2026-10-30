import { describe, expect, it } from 'vitest';

import {
  FRIENDS_LIVE_DEFAULT_LIMIT,
  FRIENDS_LIVE_MAX_LIMIT,
  FRIENDS_LIVE_SHOW_LIVE_DEFAULT,
  friendLiveDestinationSourceSchema,
  friendLiveFlightSchema,
  friendLivePhaseSchema,
  friendLivePhaseSourceSchema,
  friendLiveSchema,
  friendsLiveQuerySchema,
  friendsLiveResponseSchema,
} from './friends.js';
import { profileVisibilityUpdateSchema } from './gamification.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = '2026-10-16T09:41:10.000Z';

function live(overrides: Record<string, unknown> = {}) {
  return {
    origin_icao: 'UUEE',
    destination_icao: 'ULLI',
    destination_source: 'planned',
    route_known: true,
    aircraft_icao: 'B738',
    callsign: 'AFL123',
    started_at: '2026-10-16T08:12:00.000Z',
    elapsed_s: 5340,
    phase: 'airborne',
    phase_source: 'derived',
    last_update_at: NOW,
    stale: false,
    ...overrides,
  };
}

describe('contracts — friends live (friends-live.md)', () => {
  it('phase/phase_source/destination_source — закрытые наборы', () => {
    expect(friendLivePhaseSchema.options).toEqual([
      'on_ground',
      'taxi',
      'takeoff',
      'airborne',
      'landing',
    ]);
    expect(friendLivePhaseSourceSchema.options).toEqual(['client', 'derived', 'coarse', 'unknown']);
    expect(friendLiveDestinationSourceSchema.options).toEqual(['known', 'planned']);
  });

  it('friendLiveFlightSchema: валидный payload без координат/высоты/скорости/ВПП/балла', () => {
    const parsed = friendLiveFlightSchema.safeParse(live());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data).sort()).toEqual([
        'aircraft_icao',
        'callsign',
        'destination_icao',
        'destination_source',
        'elapsed_s',
        'last_update_at',
        'origin_icao',
        'phase',
        'phase_source',
        'route_known',
        'stale',
        'started_at',
      ]);
    }
  });

  it('friendLiveFlightSchema: forbidden-поля (lat/lon/alt/speed/runway/score/flight_id) → ошибка', () => {
    for (const forbidden of [
      { lat: 55.97 },
      { lon: 37.41 },
      { altitude_ft: 5000 },
      { groundspeed_kt: 250 },
      { runway_icao: '06R' },
      { score: 88 },
      { flight_id: UUID },
    ]) {
      expect(friendLiveFlightSchema.safeParse(live(forbidden)).success).toBe(false);
    }
  });

  it('friendLiveFlightSchema: маршрут неизвестен — destination/source null, route_known=false', () => {
    const parsed = friendLiveFlightSchema.safeParse(
      live({ destination_icao: null, destination_source: null, route_known: false }),
    );
    expect(parsed.success).toBe(true);
  });

  it('friendLiveFlightSchema: phase=null + phase_source=unknown (нет свежих данных)', () => {
    const parsed = friendLiveFlightSchema.safeParse(
      live({ phase: null, phase_source: 'unknown', last_update_at: null, stale: true }),
    );
    expect(parsed.success).toBe(true);
  });

  it('friendLiveSchema: нужен user_id/handle/display_name/live; id рейса не является полем', () => {
    const valid = {
      user_id: UUID,
      handle: 'captain_ivan',
      display_name: 'Иван',
      live: live(),
    };
    expect(friendLiveSchema.safeParse(valid).success).toBe(true);
    expect(friendLiveSchema.safeParse({ ...valid, id: UUID }).success).toBe(false);
    expect(friendLiveSchema.safeParse({ ...valid, handle: null }).success).toBe(true);
    expect(friendLiveSchema.safeParse({ ...valid, handle: 'bad!' }).success).toBe(false);
  });

  it('friendsLiveResponseSchema: пример из spec валиден; лишнее поле → ошибка; cap 100', () => {
    const response = {
      data: [{ user_id: UUID, handle: 'captain_ivan', display_name: 'Иван', live: live() }],
      meta: { generated_at: NOW, poll_after_s: 30, count: 1 },
    };
    expect(friendsLiveResponseSchema.safeParse(response).success).toBe(true);
    expect(friendsLiveResponseSchema.safeParse({ ...response, extra: 1 }).success).toBe(false);
    expect(
      friendsLiveResponseSchema.safeParse({
        ...response,
        data: Array.from({ length: FRIENDS_LIVE_MAX_LIMIT + 1 }, () => response.data[0]),
      }).success,
    ).toBe(false);
  });

  it('friendsLiveQuerySchema: дефолт 50, коэрция строки, кап и границы', () => {
    expect(friendsLiveQuerySchema.parse({})).toEqual({ limit: FRIENDS_LIVE_DEFAULT_LIMIT });
    expect(friendsLiveQuerySchema.parse({ limit: '25' })).toEqual({ limit: 25 });
    expect(friendsLiveQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(friendsLiveQuerySchema.safeParse({ limit: FRIENDS_LIVE_MAX_LIMIT + 1 }).success).toBe(false);
    expect(friendsLiveQuerySchema.safeParse({ page: 1 }).success).toBe(false);
  });

  it('isLiveVisible: дефолт ON для принятых друзей (owner decision 2026-10-16, opt-out)', () => {
    expect(FRIENDS_LIVE_SHOW_LIVE_DEFAULT).toBe(true);
  });

  it('profileVisibilityUpdateSchema принимает show_live аддитивно', () => {
    expect(profileVisibilityUpdateSchema.safeParse({ show_live: true }).success).toBe(true);
    expect(profileVisibilityUpdateSchema.safeParse({ show_live: false }).success).toBe(true);
    expect(profileVisibilityUpdateSchema.safeParse({ show_live: 'yes' }).success).toBe(false);
    expect(profileVisibilityUpdateSchema.safeParse({}).success).toBe(false);
  });
});
