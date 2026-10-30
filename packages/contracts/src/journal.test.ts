import { describe, expect, it } from 'vitest';

import {
  FLIGHT_JOURNAL_BODY_MAX,
  aiJournalSummaryDtoSchema,
  flightJournalNoteSchema,
  flightJournalPutSchema,
  journalSummaryInputV1Schema,
  journalSummaryOutputV1Schema,
  journalSummaryRequestSchema,
} from './journal.js';
import { publicFlightSchema } from './sharing.js';

const FLIGHT_ID = '223e4567-e89b-42d3-a456-426614174000';

describe('flight journal contracts (T183)', () => {
  it('note accepts 1..2000 body', () => {
    expect(
      flightJournalNoteSchema.safeParse({
        flight_id: FLIGHT_ID,
        body: 'Felt soft;',
        created_at: '2026-10-05T12:00:00.000Z',
        updated_at: '2026-10-05T12:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      flightJournalNoteSchema.safeParse({
        flight_id: FLIGHT_ID,
        body: '',
        created_at: '2026-10-05T12:00:00.000Z',
        updated_at: '2026-10-05T12:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      flightJournalNoteSchema.safeParse({
        flight_id: FLIGHT_ID,
        body: 'x'.repeat(FLIGHT_JOURNAL_BODY_MAX + 1),
        created_at: '2026-10-05T12:00:00.000Z',
        updated_at: '2026-10-05T12:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('put accepts null (clear) and rejects oversize', () => {
    expect(flightJournalPutSchema.safeParse({ body: null }).success).toBe(true);
    expect(flightJournalPutSchema.safeParse({ body: 'ok' }).success).toBe(true);
    expect(
      flightJournalPutSchema.safeParse({ body: 'x'.repeat(FLIGHT_JOURNAL_BODY_MAX + 1) }).success,
    ).toBe(false);
  });

  it('summary request language enum', () => {
    expect(journalSummaryRequestSchema.safeParse({}).success).toBe(true);
    expect(journalSummaryRequestSchema.safeParse({ language: 'en' }).success).toBe(true);
    expect(journalSummaryRequestSchema.safeParse({ language: 'de' }).success).toBe(false);
  });

  it('input forbids extra keys (track/PII)', () => {
    const base = {
      schema_version: 'journal_summary_input@1' as const,
      language: 'ru' as const,
      note: { text: 'Held too long' },
      flight: {
        aircraft_icao: 'B738',
        origin_icao: 'UUEE',
        destination_icao: 'ULLI',
        duration_s: 3600,
      },
      landing: {
        seq: 1,
        score: 82,
        grade: 'good' as const,
        runway_icao: '28L',
        vs_fpm: -120,
        g_force: 1.1,
        centreline_offset_m: 1.2,
        bounce_count: 0,
        touchdown_zone: 'aim',
        headwind_kt: 5,
        crosswind_kt: 2,
      },
    };
    expect(journalSummaryInputV1Schema.safeParse(base).success).toBe(true);
    expect(
      journalSummaryInputV1Schema.safeParse({
        ...base,
        track_points: [{ lat: 1, lon: 2 }],
      }).success,
    ).toBe(false);
    expect(
      journalSummaryInputV1Schema.safeParse({
        ...base,
        user_id: FLIGHT_ID,
      }).success,
    ).toBe(false);
  });

  it('output alignment enum + summary bounds', () => {
    expect(
      journalSummaryOutputV1Schema.safeParse({
        schema_version: 'journal_summary_output@1',
        summary: 'You wrote soft; metrics show firm touchdown.',
        wrote_highlight: 'soft feel',
        metrics_highlight: 'vs −280 fpm',
        alignment: 'mismatch',
      }).success,
    ).toBe(true);
    expect(
      journalSummaryOutputV1Schema.safeParse({
        schema_version: 'journal_summary_output@1',
        summary: 'x',
        wrote_highlight: null,
        metrics_highlight: null,
        alignment: 'unknown',
      }).success,
    ).toBe(false);
  });

  it('dto shape for stub/real summary', () => {
    expect(
      aiJournalSummaryDtoSchema.safeParse({
        flight_id: FLIGHT_ID,
        status: 'failed',
        language: 'ru',
        summary: null,
        report_id: null,
        cached: false,
        error: 'AI_UNAVAILABLE',
      }).success,
    ).toBe(true);
  });

  it('publicFlightSchema has no journal fields (SHARE-3 / F-212)', () => {
    const shape = publicFlightSchema.shape as Record<string, unknown>;
    expect(shape.body).toBeUndefined();
    expect(shape.journal).toBeUndefined();
    expect(shape.has_journal).toBeUndefined();
    expect(shape.journal_summary).toBeUndefined();
    expect(shape.note).toBeUndefined();
  });
});
