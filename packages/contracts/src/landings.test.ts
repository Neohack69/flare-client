import { describe, expect, it } from 'vitest';

import {
  flightSchema,
  landingSummarySchema,
  publicFlightSchema,
  publicLandingSummarySchema,
  scorePolicySchema,
} from './index';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = '2026-09-26T10:12:03.000Z';

function landing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UUID,
    seq: 1,
    touchdown_at: NOW,
    touch_and_go: true,
    ground_contact_s: 14,
    metrics: { vs_fpm: -420, g_force: 1.6, bounce_count: 0, bounced: false, aircraft_icao: 'C172' },
    score: 61,
    grade: 'firm',
    components: { vertical_speed: 48.0, g_force: 55.0 },
    score_version: '1.0.0',
    segmentation_version: '1.0.0',
    confidence: 1.0,
    eligible: true,
    verified: true,
    quality_flags: 0,
    ...overrides,
  };
}

describe('contracts — landings (ADR-0010)', () => {
  it('scorePolicySchema — закрытый набор best|last|avg', () => {
    expect(scorePolicySchema.options).toEqual(['best', 'last', 'avg']);
    expect(scorePolicySchema.safeParse('best').success).toBe(true);
    expect(scorePolicySchema.safeParse('worst').success).toBe(false);
  });

  it('landingSummarySchema принимает валидную посадку и отклоняет лишние поля', () => {
    expect(landingSummarySchema.safeParse(landing()).success).toBe(true);
    expect(landingSummarySchema.safeParse(landing({ extra: 1 })).success).toBe(false);
    expect(landingSummarySchema.safeParse(landing({ seq: 0 })).success).toBe(false);
    expect(landingSummarySchema.safeParse(landing({ score: 101 })).success).toBe(false);
  });

  it('landingSummarySchema.runway аддитивно nullable (ADR-0013 / T129)', () => {
    const without = landingSummarySchema.parse(landing());
    expect(without.runway).toBeNull();

    const withRunway = landingSummarySchema.parse(
      landing({
        runway: {
          airport_icao: 'URSS',
          designator: '02',
          length_m: 2500,
          width_m: 45,
          heading_deg: 20,
          source: 'ourairports',
        },
      }),
    );
    expect(withRunway.runway?.designator).toBe('02');
    expect(withRunway.runway?.heading_deg).toBe(20);
  });

  it('ground_contact_s nullable (последняя посадка без отрыва)', () => {
    const parsed = landingSummarySchema.safeParse(
      landing({ touch_and_go: false, ground_contact_s: null }),
    );
    expect(parsed.success).toBe(true);
  });

  it('flightSchema.landings аддитивно, по умолчанию []', () => {
    const parsed = flightSchema.parse({
      id: UUID,
      user_id: UUID,
      device_id: null,
      client_flight_id: UUID,
      aircraft_icao: 'C172',
      callsign: null,
      origin_icao: null,
      destination_icao: null,
      started_at: NOW,
      server_received_at: NOW,
      ended_at: null,
      duration_s: null,
      distance_m: null,
      max_altitude_ft: null,
      touchdown_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
    expect(parsed.landings).toEqual([]);

    const withLandings = flightSchema.parse({ ...parsed, landings: [landing()] });
    expect(withLandings.landings).toHaveLength(1);
    expect(withLandings.landings[0]?.seq).toBe(1);
  });

  it('publicLandingSummarySchema санитизирована: без id/verified/quality_flags', () => {
    const parsed = publicLandingSummarySchema.safeParse(landing());
    expect(parsed.success).toBe(false);
    const sanitized = { ...landing() };
    delete sanitized.id;
    delete sanitized.verified;
    delete sanitized.quality_flags;
    const ok = publicLandingSummarySchema.safeParse(sanitized);
    expect(ok.success).toBe(true);
    expect(ok.success && 'id' in ok.data).toBe(false);
  });

  it('publicFlightSchema.landings/landings_count аддитивны и по умолчанию []/0', () => {
    const parsed = publicFlightSchema.parse({
      id: UUID,
      aircraft_icao: 'C172',
      aircraft: null,
      callsign: null,
      origin_icao: null,
      destination_icao: null,
      status: 'completed',
      started_at: NOW,
      ended_at: null,
      duration_s: null,
      distance_m: null,
      max_altitude_ft: null,
      touchdown_at: null,
      score: null,
      quality: { is_partial: false, leaderboard_eligible: true, quality_flags: 0 },
    });
    expect(parsed.landings).toEqual([]);
    expect(parsed.landings_count).toBe(0);
  });
});
