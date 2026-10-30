import { describe, expect, it } from 'vitest';

import {
  WAITING_ROOM_CATALOG_VERSION,
  planAllowsWaitingRoomPush,
  waitingRoomPrefsPatchSchema,
  waitingRoomResponseSchema,
} from './waiting-room.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = '2026-10-05T12:00:00.000Z';

describe('waiting-room contracts (T181)', () => {
  it('парсит полный Free-агрегат без callsign', () => {
    const parsed = waitingRoomResponseSchema.safeParse({
      data: {
        phase: 'idle',
        sync: {
          health: 'quiet',
          last_activity_at: NOW,
          lag_s: 400,
          hint: 'device_quiet',
          pending_points: null,
          pending_events: null,
        },
        device: {
          id: UUID,
          name: 'Home PC',
          platform: 'win32',
          source: 'msfs-plugin',
          last_seen_at: NOW,
          view_status: 'active',
        },
        active_flight: null,
        last_landing: {
          flight_id: UUID,
          landing_seq: 1,
          aircraft_icao: 'A320',
          origin_icao: 'UUEE',
          destination_icao: 'ULLI',
          runway_icao: '06R',
          score: 88,
          grade: 'good',
          vs_fpm: -182,
          touchdown_at: NOW,
        },
        entitlements: {
          plan_code: 'free',
          push_enabled: false,
          telegram_rich: false,
        },
        prefs: {
          web_push_opt_in: false,
          telegram_opt_in: false,
          telegram_linked: false,
          telegram_available: false,
          web_push_available: false,
        },
      },
      meta: {
        generated_at: NOW,
        poll_after_s: 15,
        catalog_version: WAITING_ROOM_CATALOG_VERSION,
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.data).not.toHaveProperty('callsign');
      expect(parsed.data.data.active_flight).toBeNull();
    }
  });

  it('отклоняет неизвестную phase / лишние поля в data', () => {
    expect(
      waitingRoomResponseSchema.safeParse({
        data: {
          phase: 'flying',
          sync: {
            health: 'live',
            last_activity_at: null,
            lag_s: null,
            hint: 'ok',
            pending_points: null,
            pending_events: null,
          },
          device: null,
          active_flight: null,
          last_landing: null,
          entitlements: { plan_code: 'free', push_enabled: false, telegram_rich: false },
          prefs: {
            web_push_opt_in: false,
            telegram_opt_in: false,
            telegram_linked: false,
            telegram_available: false,
            web_push_available: false,
          },
        },
        meta: {
          generated_at: NOW,
          poll_after_s: 15,
          catalog_version: WAITING_ROOM_CATALOG_VERSION,
        },
      }).success,
    ).toBe(false);
  });

  it('prefs patch требует хотя бы одно поле; Free/Pro gate helper', () => {
    expect(waitingRoomPrefsPatchSchema.safeParse({}).success).toBe(false);
    expect(waitingRoomPrefsPatchSchema.safeParse({ web_push_opt_in: true }).success).toBe(true);
    expect(planAllowsWaitingRoomPush('free')).toBe(false);
    expect(planAllowsWaitingRoomPush('pro')).toBe(true);
    expect(planAllowsWaitingRoomPush('lifetime')).toBe(true);
    expect(planAllowsWaitingRoomPush('unlimited')).toBe(true);
  });
});
