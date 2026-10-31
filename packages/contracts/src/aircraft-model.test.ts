import { describe, expect, it } from 'vitest';

import {
  AIRCRAFT_MODEL_SOURCE_MAX,
  aircraftDictionaryArtifactSchema,
  aircraftIcaoSourceSchema,
  aircraftModelSuggestionCreateSchema,
  aircraftModelSuggestionSchema,
  adminAircraftSuggestionRejectSchema,
  adminAircraftSuggestionsQuerySchema,
  isSeedAircraftModelSource,
  normalizeAircraftModelText,
} from './aircraft-model.js';
import { AIRCRAFT_MODEL_SEED } from './aircraft-model-seed.js';
import { flightCreateSchema, flightPatchSchema } from './flight.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

describe('normalizeAircraftModelText (T-D §6.2)', () => {
  it('trim + upper + схлопывание пробелов', () => {
    expect(normalizeAircraftModelText('  Boeing   737-800 ')).toBe('BOEING 737-800');
  });

  it('сохраняет строку как есть кроме регистра/пробелов (снятие хвостов — OPEN)', () => {
    expect(normalizeAircraftModelText('Boeing 737-800 ASOBO')).toBe('BOEING 737-800 ASOBO');
    expect(normalizeAircraftModelText('A320 livery')).toBe('A320 LIVERY');
  });

  it('D3: удаляет control/bidi/zero-width символы', () => {
    expect(normalizeAircraftModelText('B\u202E738')).toBe('B738'); // RLO override
    expect(normalizeAircraftModelText('B\u202A738\u202C')).toBe('B738'); // LRE/PDF
    expect(normalizeAircraftModelText('BOEING\u200B 737-800')).toBe('BOEING 737-800'); // ZWSP
    expect(normalizeAircraftModelText('BOEING\u0000 737-800')).toBe('BOEING 737-800'); // NUL
    // Пробельные control (`\t`) схлопываются, а не склеивают слова.
    expect(normalizeAircraftModelText('BOEING\t737-800')).toBe('BOEING 737-800');
  });

  it('D3: NFKC нормализует совместимые формы (anti-spoofing)', () => {
    expect(normalizeAircraftModelText('Ｂ７３８')).toBe('B738');
  });

  it('D3: из одних невидимых символов получается пустая строка (отвергается схемой)', () => {
    expect(normalizeAircraftModelText('\u202E\u200B\u0000')).toBe('');
    expect(
      aircraftModelSuggestionCreateSchema.safeParse({
        source_string: '\u202E\u200B',
        proposed_icao: 'B738',
      }).success,
    ).toBe(false);
  });
});

describe('isSeedAircraftModelSource (D1, анти-Sybil)', () => {
  it('распознаёт seed-строки с нормализацией', () => {
    expect(isSeedAircraftModelSource('boeing 737-800')).toBe(true);
    expect(isSeedAircraftModelSource('  Airbus   A320 ')).toBe(true);
    expect(isSeedAircraftModelSource('AIRBUS\u200B A320')).toBe(true);
  });

  it('first-seen строки (нет в seed) — не seed', () => {
    expect(isSeedAircraftModelSource('PMDG 777-200LR')).toBe(false);
    expect(isSeedAircraftModelSource('SOME CUSTOM PLANE')).toBe(false);
    expect(isSeedAircraftModelSource('')).toBe(false);
  });
});

describe('aircraftModelSourceStringSchema через create-контракт (T-D §4.3)', () => {
  it('нормализует source_string и принимает валидный ICAO', () => {
    const parsed = aircraftModelSuggestionCreateSchema.parse({
      source_string: '  some custom plane  ',
      proposed_icao: 'ZZZZ',
    });
    expect(parsed.source_string).toBe('SOME CUSTOM PLANE');
    expect(parsed.proposed_icao).toBe('ZZZZ');
  });

  it('отвергает невалидный proposed_icao и лишние поля (strict)', () => {
    expect(
      aircraftModelSuggestionCreateSchema.safeParse({ source_string: 'X', proposed_icao: 'toolong' })
        .success,
    ).toBe(false);
    expect(
      aircraftModelSuggestionCreateSchema.safeParse({
        source_string: 'X',
        proposed_icao: 'B738',
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it('ограничивает длину нормализованной строки', () => {
    const long = 'A'.repeat(AIRCRAFT_MODEL_SOURCE_MAX + 1);
    expect(aircraftModelSuggestionCreateSchema.safeParse({ source_string: long, proposed_icao: 'B738' }).success).toBe(false);
    expect(
      aircraftModelSuggestionCreateSchema.safeParse({ source_string: 'A'.repeat(AIRCRAFT_MODEL_SOURCE_MAX), proposed_icao: 'B738' }).success,
    ).toBe(true);
  });

  it('принимает опциональный flight_id (uuid)', () => {
    const parsed = aircraftModelSuggestionCreateSchema.parse({
      source_string: 'X',
      proposed_icao: 'B738',
      flight_id: UUID,
    });
    expect(parsed.flight_id).toBe(UUID);
    expect(
      aircraftModelSuggestionCreateSchema.safeParse({ source_string: 'X', proposed_icao: 'B738', flight_id: 'nope' })
        .success,
    ).toBe(false);
  });
});

describe('read/moderation контракты (T-D §4.4)', () => {
  const suggestion = {
    id: UUID,
    source_norm: 'BOEING 737-800',
    proposed_icao: 'B738',
    observations: 5,
    distinct_reporters: 3,
    status: 'pending',
    first_seen_at: '2026-10-12T00:00:00Z',
    last_seen_at: '2026-10-12T01:00:00Z',
  };

  it('aircraftModelSuggestionSchema валиден и strict', () => {
    expect(aircraftModelSuggestionSchema.safeParse(suggestion).success).toBe(true);
    expect(aircraftModelSuggestionSchema.safeParse({ ...suggestion, status: 'bogus' }).success).toBe(false);
    expect(aircraftModelSuggestionSchema.safeParse({ ...suggestion, extra: 1 }).success).toBe(false);
  });

  it('adminAircraftSuggestionsQuerySchema: limit/status/cursor', () => {
    expect(adminAircraftSuggestionsQuerySchema.parse({}).limit).toBe(50);
    expect(adminAircraftSuggestionsQuerySchema.parse({ status: 'pending', limit: '10' }).limit).toBe(10);
    expect(adminAircraftSuggestionsQuerySchema.safeParse({ status: 'nope' }).success).toBe(false);
  });

  it('adminAircraftSuggestionRejectSchema: note ≤ 500', () => {
    expect(adminAircraftSuggestionRejectSchema.parse({}).note).toBeUndefined();
    expect(adminAircraftSuggestionRejectSchema.parse({ note: 'dup' }).note).toBe('dup');
    expect(adminAircraftSuggestionRejectSchema.safeParse({ note: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('aircraftIcaoSourceSchema / dictionary artifact (T-D §5.1/§6.4)', () => {
  it('enum источников', () => {
    for (const value of [
      'atc_type',
      'atc_model',
      'title',
      'heuristic',
      'aircraft_cfg',
      'xplane_acf',
      'unknown',
      'user',
      'learned',
    ]) {
      expect(aircraftIcaoSourceSchema.safeParse(value).success).toBe(true);
    }
    expect(aircraftIcaoSourceSchema.safeParse('config').success).toBe(false);
  });

  it('artifact: version/generated_at/pairs', () => {
    const artifact = {
      version: '2026.10.12.1',
      generated_at: '2026-10-12T10:00:00Z',
      pairs: { 'BOEING 737-800': 'B738', 'SOME CUSTOM PLANE': 'ZZZZ' },
    };
    expect(aircraftDictionaryArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(aircraftDictionaryArtifactSchema.safeParse({ ...artifact, extra: 1 }).success).toBe(false);
    expect(aircraftDictionaryArtifactSchema.safeParse({ ...artifact, pairs: { X: 'bad!' } }).success).toBe(false);
  });

  it('seed содержит ключевые пары', () => {
    expect(AIRCRAFT_MODEL_SEED['BOEING 737-800']).toBe('B738');
    expect(AIRCRAFT_MODEL_SEED['AIRBUS A320']).toBe('A320');
  });

  it('seed канонизирует Boeing 777F/Freighter/B77F → B77L (ICAO Doc 8643)', () => {
    expect(AIRCRAFT_MODEL_SEED['BOEING 777F']).toBe('B77L');
    expect(AIRCRAFT_MODEL_SEED['BOEING 777 FREIGHTER']).toBe('B77L');
    expect(AIRCRAFT_MODEL_SEED['B77F']).toBe('B77L');
  });
});

describe('flightPatchSchema += aircraft_icao (T-D §4.1)', () => {
  it('принимает aircraft_icao и сохраняет strict', () => {
    expect(flightPatchSchema.parse({ aircraft_icao: 'B738' }).aircraft_icao).toBe('B738');
    expect(flightPatchSchema.safeParse({ aircraft_icao: 'b738' }).success).toBe(false);
    expect(flightPatchSchema.safeParse({ aircraft_icao: 'B738', rogue: true }).success).toBe(false);
    expect(flightPatchSchema.parse({ visibility: 'public' }).aircraft_icao).toBeUndefined();
  });
});

describe('flightCreateSchema += aircraft_model_raw (T-D §5.6)', () => {
  const base = {
    client_flight_id: UUID,
    aircraft_icao: 'ZZZZ',
    started_at: '2026-10-12T00:00:00Z',
  };

  it('нормализует строку модели аддитивно', () => {
    const parsed = flightCreateSchema.parse({ ...base, aircraft_model_raw: ' pmdg 777-200lr ' });
    expect(parsed.aircraft_model_raw).toBe('PMDG 777-200LR');
  });

  it('необязательно и strip для неизвестных полей', () => {
    expect(flightCreateSchema.parse(base).aircraft_model_raw).toBeUndefined();
    const parsed = flightCreateSchema.parse({ ...base, unknown_future: 1 });
    expect('unknown_future' in parsed).toBe(false);
  });
});
