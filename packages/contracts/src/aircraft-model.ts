import { z } from 'zod';
import { AIRCRAFT_MODEL_SEED } from './aircraft-model-seed.js';
import { aircraftIcaoSchema, utcDateTimeSchema, uuidSchema } from './primitives.js';

/**
 * T-D — пользовательский ICAO ВС и самообучение словаря
 * (`docs/architecture/t-d-user-aircraft-icao.md` §4–§6).
 *
 * Контракты обучающих пар, модерации и публичного артефакта словаря. Здесь же —
 * единая нормализация строки модели, чтобы сервер, генератор артефакта и агент
 * считали `source_norm` одинаково.
 */

/** Максимальная длина нормализованной строки модели (§5.3/§6.2). */
export const AIRCRAFT_MODEL_SOURCE_MAX = 128;

/**
 * Управляющие/невидимые символы, недопустимые в ключе `source_norm` (D3,
 * security review 2026-10-12): `\p{Cc}` (control) и `\p{Cf}` (format: bidi-
 * override, zero-width, BOM). Исключение — ZWJ (`U+200D`), чтобы не ломать
 * составные эмодзи (единообразно с `displayNameSchema`).
 */
const UNSAFE_SOURCE_CHARS = /[\p{Cc}\p{Cf}]/gu;
const ZERO_WIDTH_JOINER = '\u200D';

/**
 * Нормализация строки модели: NFKC (`anti-spoofing`, схлопывание совместимых
 * форм), схлопывание пробелов, удаление control/bidi/невидимых символов, `trim`,
 * `upper`. Чистая детерминированная функция; длина не ограничивается
 * (ограничение — в {@link aircraftModelSourceStringSchema}).
 *
 * Правила пробелов/регистра совпадают с `normalizeAtcText` агента (T-D §6.2);
 * D3 добавляет NFKC + стрип `\p{Cc}`/`\p{Cf}` (кроме ZWJ), чтобы пользовательский
 * `source_norm` не мог пронести spoofing-символы в глобальный словарь/admin-UI.
 */
export function normalizeAircraftModelText(raw: string | null | undefined): string {
  return (raw ?? '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .replace(UNSAFE_SOURCE_CHARS, (ch) => (ch === ZERO_WIDTH_JOINER ? ch : ''))
    .replace(/\s+/gu, ' ')
    .trim()
    .toUpperCase();
}

/** Нормализованная строка модели: `1..128` после {@link normalizeAircraftModelText}. */
export const aircraftModelSourceStringSchema = z
  .string()
  .transform((value) => normalizeAircraftModelText(value))
  .pipe(z.string().min(1).max(AIRCRAFT_MODEL_SOURCE_MAX));

/** Нормализованные ключи курируемого seed-словаря ({@link AIRCRAFT_MODEL_SEED}). */
const SEED_SOURCE_NORMS: ReadonlySet<string> = new Set(
  Object.keys(AIRCRAFT_MODEL_SEED).map((key) => normalizeAircraftModelText(key)),
);

/**
 * Известна ли строка модели курируемому seed-словарю (D1, security review
 * 2026-10-12). Авто-одобрение обучающей пары разрешено **только** для строк из
 * seed: first-seen строки (их нет в seed) уходят в ручную модерацию — иначе
 * 3 аккаунта могут авто-присвоить произвольную «addon-строку → ICAO».
 */
export function isSeedAircraftModelSource(source: string): boolean {
  return SEED_SOURCE_NORMS.has(normalizeAircraftModelText(source));
}

/** Источник `aircraft_icao` (T-D §5.1): `user` — правка, `learned` — словарь. */
export const aircraftIcaoSourceSchema = z.enum([
  'atc_type',
  'atc_model',
  'title',
  'heuristic',
  'aircraft_cfg',
  'xplane_acf',
  'unknown',
  'user',
  'learned',
]);
export type AircraftIcaoSource = z.output<typeof aircraftIcaoSourceSchema>;

export const aircraftModelSuggestionStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'merged',
]);
export type AircraftModelSuggestionStatus = z.output<typeof aircraftModelSuggestionStatusSchema>;

/**
 * `POST /v1/aircraft/model-suggestions` (T-D §4.3): анонимная обучающая пара.
 * `flight_id` опционален — тогда `source_string` может браться со `stats` рейса.
 */
export const aircraftModelSuggestionCreateSchema = z
  .object({
    source_string: aircraftModelSourceStringSchema,
    proposed_icao: aircraftIcaoSchema,
    flight_id: uuidSchema.optional(),
  })
  .strict();
export type AircraftModelSuggestionCreate = z.output<typeof aircraftModelSuggestionCreateSchema>;

/** Read-модель агрегата наблюдения для модерации (§4.4). */
export const aircraftModelSuggestionSchema = z
  .object({
    id: uuidSchema,
    source_norm: z.string().min(1).max(AIRCRAFT_MODEL_SOURCE_MAX),
    proposed_icao: aircraftIcaoSchema,
    observations: z.number().int().positive(),
    distinct_reporters: z.number().int().positive(),
    status: aircraftModelSuggestionStatusSchema,
    first_seen_at: utcDateTimeSchema,
    last_seen_at: utcDateTimeSchema,
  })
  .strict();
export type AircraftModelSuggestion = z.output<typeof aircraftModelSuggestionSchema>;

/** Ответ `POST /v1/aircraft/model-suggestions` (§4.3). */
export const aircraftModelSuggestionCreateResponseSchema = z
  .object({
    data: z
      .object({
        status: z.enum(['pending', 'approved']),
      })
      .strict(),
  })
  .strict();
export type AircraftModelSuggestionCreateResponse = z.output<
  typeof aircraftModelSuggestionCreateResponseSchema
>;

export const adminAircraftSuggestionsQuerySchema = z
  .object({
    status: aircraftModelSuggestionStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type AdminAircraftSuggestionsQuery = z.output<typeof adminAircraftSuggestionsQuerySchema>;

export const adminAircraftSuggestionsResponseSchema = z
  .object({
    data: z.array(aircraftModelSuggestionSchema),
    meta: z
      .object({
        next_cursor: z.string().nullable(),
        has_more: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type AdminAircraftSuggestionsResponse = z.output<
  typeof adminAircraftSuggestionsResponseSchema
>;

export const adminAircraftSuggestionRejectSchema = z
  .object({
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type AdminAircraftSuggestionReject = z.output<
  typeof adminAircraftSuggestionRejectSchema
>;

/** Ответ approve/reject модерации — обновлённый агрегат (§4.4). */
export const adminAircraftSuggestionActionResponseSchema = z
  .object({
    data: aircraftModelSuggestionSchema,
  })
  .strict();

/**
 * Публичный версионированный артефакт словаря (`GET /aircraft/icao-dict.json`,
 * §6.4). Immutable: новая версия — новый файл; агент применяет best-effort.
 */
export const aircraftDictionaryArtifactSchema = z
  .object({
    version: z.string().min(1).max(64),
    generated_at: utcDateTimeSchema,
    pairs: z.record(z.string().min(1).max(AIRCRAFT_MODEL_SOURCE_MAX), aircraftIcaoSchema),
  })
  .strict();
export type AircraftDictionaryArtifact = z.output<typeof aircraftDictionaryArtifactSchema>;
