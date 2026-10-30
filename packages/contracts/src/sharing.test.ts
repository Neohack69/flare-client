import { describe, expect, it } from 'vitest';

import {
  publicDebriefListItemSchema,
  publicDebriefListResponseSchema,
  publicFlightSchema,
} from './index';

const TOKEN = 'public-token-abcdefghijklmnop';

describe('contracts — публичный листинг debrief (SEO S3/S6)', () => {
  it('publicFlightSchema содержит visibility (private|unlisted|public)', () => {
    const visibility = publicFlightSchema.shape.visibility;
    expect(visibility.safeParse('public').success).toBe(true);
    expect(visibility.safeParse('unlisted').success).toBe(true);
    expect(visibility.safeParse('private').success).toBe(true);
    expect(visibility.safeParse('secret').success).toBe(false);
  });

  it('publicFlightSchema: canonical_token аддитивен и nullable (BUG-SEO-01)', () => {
    const minimal = {
      id: '123e4567-e89b-42d3-a456-426614174000',
      aircraft_icao: null,
      aircraft: null,
      callsign: null,
      origin_icao: null,
      destination_icao: null,
      status: 'completed',
      started_at: '2026-09-23T12:00:00.000Z',
      ended_at: null,
      duration_s: null,
      distance_m: null,
      max_altitude_ft: null,
      touchdown_at: null,
      score: null,
      quality: { is_partial: false, leaderboard_eligible: false, quality_flags: 0 },
    };
    // Старый payload без поля → safe-дефолт `null` (self-canonical).
    expect(publicFlightSchema.parse(minimal).canonical_token).toBeNull();
    expect(publicFlightSchema.parse({ ...minimal, canonical_token: TOKEN }).canonical_token).toBe(
      TOKEN,
    );
    expect(publicFlightSchema.safeParse({ ...minimal, canonical_token: '' }).success).toBe(false);
  });

  it('publicDebriefListItemSchema — whitelist полей', () => {
    const item = {
      token: TOKEN,
      visibility: 'public',
      leaderboard_eligible: true,
      has_score: true,
      has_track: true,
      origin_icao: 'UUEE',
      destination_icao: 'ULLI',
      updated_at: '2026-09-23T13:31:00.000Z',
    };
    expect(publicDebriefListItemSchema.safeParse(item).success).toBe(true);
    expect(publicDebriefListItemSchema.safeParse({ ...item, user_id: 'x' }).success).toBe(false);
  });

  it('publicDebriefListResponseSchema требует data + meta пагинации', () => {
    const item = {
      token: TOKEN,
      visibility: 'public',
      leaderboard_eligible: true,
      has_score: true,
      has_track: true,
      origin_icao: null,
      destination_icao: null,
      updated_at: null,
    };
    expect(
      publicDebriefListResponseSchema.safeParse({
        data: [item],
        meta: { next_cursor: null, has_more: false },
      }).success,
    ).toBe(true);
    expect(publicDebriefListResponseSchema.safeParse({ data: [item] }).success).toBe(false);
  });
});
