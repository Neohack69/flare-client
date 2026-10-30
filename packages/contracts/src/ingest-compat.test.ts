import { describe, expect, it } from 'vitest';

import {
  flightCompleteSchema,
  flightCreateSchema,
  flightEventsBatchSchema,
  trackBatchSchema,
} from './index';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const POINT_UUID = '223e4567-e89b-42d3-a456-426614174000';
const EVENT_UUID = '323e4567-e89b-42d3-a456-426614174000';
const TS = '2026-09-23T12:00:00.000Z';

/** Полный текущий минимум точки (§13.2 + обязательные поля схемы). */
function point(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_point_id: POINT_UUID,
    seq: 1,
    ts: TS,
    lat: 55.972,
    lon: 37.414,
    alt_ft: 850,
    gs_kt: 145,
    heading_deg: 245.1,
    pitch_deg: 2.1,
    bank_deg: -0.4,
    g: 1.02,
    on_ground: false,
    quality: 0,
    ...overrides,
  };
}

const flightCreate = {
  client_flight_id: UUID,
  aircraft_icao: 'B738',
  started_at: TS,
};

describe('contracts — толерантный приём телеметрии (api.md §13.3)', () => {
  it('track/batch принимает лишние поля точки и батча (не 422)', () => {
    const parsed = trackBatchSchema.safeParse({
      points: [point({ qnh_mb: 1013, future_metric: 42 })],
      source: 'msfs-plugin',
      version: '9.9.9',
      // поле, которого нет даже в батче
      future_batch_field: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Неизвестные поля отброшены, а не проброшены дальше.
      expect(parsed.data.points[0]).not.toHaveProperty('qnh_mb');
      expect(parsed.data.points[0]).not.toHaveProperty('future_metric');
      expect(parsed.data).not.toHaveProperty('future_batch_field');
      expect(parsed.data.points[0]?.lat).toBe(55.972);
    }
  });

  it('track/batch от «старой версии» (без source/version) принимается', () => {
    const parsed = trackBatchSchema.safeParse({ points: [point()] });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.source).toBeUndefined();
      expect(parsed.data.version).toBeUndefined();
    }
  });

  it('source/version не меняют разобранные точки (информационны)', () => {
    const bare = trackBatchSchema.parse({ points: [point()] });
    const tagged = trackBatchSchema.parse({
      points: [point()],
      source: 'msfs-plugin',
      version: '0.1.0',
    });
    expect(tagged.points).toEqual(bare.points);
  });

  it('events/batch принимает лишние поля события и батча', () => {
    const parsed = flightEventsBatchSchema.safeParse({
      events: [
        {
          client_event_id: EVENT_UUID,
          type: 'touchdown',
          ts: TS,
          extra_event_field: 'x',
        },
      ],
      source: 'msfs-plugin',
      client_version: '0.1.0',
      future: 1,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.events[0]).not.toHaveProperty('extra_event_field');
      expect(parsed.data.events[0]?.severity).toBe(0);
      expect(parsed.data.events[0]?.data).toEqual({});
    }
  });

  it('POST /v1/flights: source/version и лишние поля принимаются', () => {
    const parsed = flightCreateSchema.safeParse({
      ...flightCreate,
      source: 'msfs-plugin',
      version: '0.1.0',
      future_field: 'ignored',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.source).toBe('msfs-plugin');
      expect(parsed.data.version).toBe('0.1.0');
      expect(parsed.data).not.toHaveProperty('future_field');
    }
  });

  it('POST /v1/flights без source/version (старый плагин) принимается', () => {
    expect(flightCreateSchema.safeParse(flightCreate).success).toBe(true);
  });

  it('unclosed enum: неизвестный source не гейтит приём (forward-compat)', () => {
    const parsed = flightCreateSchema.safeParse({ ...flightCreate, source: 'some-future-client' });
    expect(parsed.success).toBe(true);
  });

  it('/complete принимает лишние поля и client_version как синоним', () => {
    const parsed = flightCompleteSchema.safeParse({
      ended_at: TS,
      client_flight_id: UUID,
      source: 'msfs-plugin',
      client_version: '0.1.0',
      future: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.client_version).toBe('0.1.0');
      expect(parsed.data).not.toHaveProperty('future');
    }
  });

  it('обязательный минимум всё ещё обязателен (несовместимая форма → ошибка)', () => {
    // Без lat/lon/ts — это несовместимость формы, а не «старая версия» (§13.2).
    expect(trackBatchSchema.safeParse({ points: [{ client_point_id: POINT_UUID }] }).success).toBe(
      false,
    );
    expect(flightCompleteSchema.safeParse({ ended_at: TS }).success).toBe(false);
  });
});
