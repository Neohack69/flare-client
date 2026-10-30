import { z } from 'zod';

import { scoreGradeSchema } from './scoring.js';
import {
  aircraftIcaoSchema,
  airportIcaoSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './primitives.js';

/** Максимум символов заметки (UTF-16 code units ≈ JS string length). */
export const FLIGHT_JOURNAL_BODY_MAX = 2000;

/** GET/PUT ответ — одна заметка владельца (T183). */
export const flightJournalNoteSchema = z
  .object({
    flight_id: uuidSchema,
    body: z.string().min(1).max(FLIGHT_JOURNAL_BODY_MAX),
    created_at: utcDateTimeSchema,
    updated_at: utcDateTimeSchema,
  })
  .strict();
export type FlightJournalNote = z.output<typeof flightJournalNoteSchema>;

/** PUT /v1/flights/{id}/journal — null/blank → очистить (DELETE строки). */
export const flightJournalPutSchema = z
  .object({
    body: z.string().max(FLIGHT_JOURNAL_BODY_MAX).nullable(),
  })
  .strict();
export type FlightJournalPut = z.output<typeof flightJournalPutSchema>;

export const flightJournalGetResponseSchema = z
  .object({ data: flightJournalNoteSchema.nullable() })
  .strict();
export type FlightJournalGetResponse = z.output<typeof flightJournalGetResponseSchema>;

export const flightJournalPutResponseSchema = z
  .object({ data: flightJournalNoteSchema.nullable() })
  .strict();
export type FlightJournalPutResponse = z.output<typeof flightJournalPutResponseSchema>;

/** POST /v1/flights/{id}/journal/summary — optional language (T183 Pro). */
export const journalSummaryRequestSchema = z
  .object({
    language: z.enum(['ru', 'en']).optional(),
  })
  .strict();
export type JournalSummaryRequest = z.output<typeof journalSummaryRequestSchema>;

/**
 * Вход LLM для journal_summary (F-212): агрегаты + note text.
 * Запрещены track_points / PII / user_id в provider payload.
 */
export const journalSummaryInputV1Schema = z
  .object({
    schema_version: z.literal('journal_summary_input@1'),
    language: z.enum(['ru', 'en']),
    note: z
      .object({
        text: z.string().min(1).max(FLIGHT_JOURNAL_BODY_MAX),
      })
      .strict(),
    flight: z
      .object({
        aircraft_icao: aircraftIcaoSchema.nullable(),
        origin_icao: airportIcaoSchema.nullable(),
        destination_icao: airportIcaoSchema.nullable(),
        duration_s: z.number().int().nullable(),
      })
      .strict(),
    landing: z
      .object({
        seq: z.number().int().positive().nullable(),
        score: z.number().min(0).max(100).nullable(),
        grade: scoreGradeSchema.nullable(),
        runway_icao: z.string().nullable(),
        vs_fpm: z.number().nullable(),
        g_force: z.number().nullable(),
        centreline_offset_m: z.number().nullable(),
        bounce_count: z.number().int().nullable(),
        touchdown_zone: z.string().nullable(),
        headwind_kt: z.number().nullable(),
        crosswind_kt: z.number().nullable(),
      })
      .strict(),
  })
  .strict();
export type JournalSummaryInputV1 = z.output<typeof journalSummaryInputV1Schema>;

/** Выход LLM: сопоставление «написал / метрики». */
export const journalSummaryOutputV1Schema = z
  .object({
    schema_version: z.literal('journal_summary_output@1'),
    summary: z.string().min(1).max(600),
    wrote_highlight: z.string().max(240).nullable(),
    metrics_highlight: z.string().max(240).nullable(),
    alignment: z.enum(['aligned', 'partial', 'mismatch', 'insufficient_data']),
  })
  .strict();
export type JournalSummaryOutputV1 = z.output<typeof journalSummaryOutputV1Schema>;

/**
 * Публичный DTO POST/GET …/journal/summary (T183).
 * LLM generation может быть deferred → status failed + error, shape стабилен.
 */
export const aiJournalSummaryDtoSchema = z
  .object({
    flight_id: uuidSchema,
    status: z.enum(['pending', 'running', 'done', 'failed', 'empty']),
    language: z.enum(['ru', 'en']),
    summary: journalSummaryOutputV1Schema.nullable(),
    report_id: uuidSchema.nullable(),
    cached: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();
export type AiJournalSummaryDto = z.output<typeof aiJournalSummaryDtoSchema>;

export const aiJournalSummaryResponseSchema = z
  .object({ data: aiJournalSummaryDtoSchema })
  .strict();
export type AiJournalSummaryResponse = z.output<typeof aiJournalSummaryResponseSchema>;

export const aiJournalSummaryGetResponseSchema = z
  .object({ data: aiJournalSummaryDtoSchema.nullable() })
  .strict();
export type AiJournalSummaryGetResponse = z.output<typeof aiJournalSummaryGetResponseSchema>;

/** Срез заметки в личном export T73 (не в public `/s`). */
export const meExportJournalNoteSchema = z
  .object({
    flight_id: uuidSchema,
    body: z.string().min(1).max(FLIGHT_JOURNAL_BODY_MAX),
    updated_at: utcDateTimeSchema,
  })
  .strict();
export type MeExportJournalNote = z.output<typeof meExportJournalNoteSchema>;
