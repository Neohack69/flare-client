import { z } from 'zod';
import { meExportJournalNoteSchema } from './journal.js';
import { emailSchema, utcDateTimeSchema, uuidSchema } from './primitives.js';

/**
 * Privacy / 152-ФЗ (T73, COMP-1, DATA-5).
 *
 * Версия политики — строка ISO-даты документа (не semver): смена текста политики
 * поднимает константу на сервере; клиент принимает только текущую версию.
 */

/** Текущая версия политики ПДн (совпадает с серверной константой). */
export const PRIVACY_POLICY_VERSION = '2026-10-01';

export const privacyPolicyVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'policy version must be YYYY-MM-DD');
export type PrivacyPolicyVersion = z.output<typeof privacyPolicyVersionSchema>;

/** GET /v1/me/consent — статус согласия субъекта. */
export const meConsentSchema = z
  .object({
    /** Версия политики, которую сервер сейчас требует. */
    current_version: privacyPolicyVersionSchema,
    /** Версия, которую пользователь принял последней; `null` — ещё не принимал. */
    accepted_version: privacyPolicyVersionSchema.nullable(),
    /** Когда приняли `accepted_version`; `null` если согласия нет. */
    accepted_at: utcDateTimeSchema.nullable(),
    /** `true`, если `accepted_version === current_version`. */
    accepted: z.boolean(),
    /** URL текста политики (публичная страница); `null` пока страница не опубликована. */
    policy_url: z.string().url().nullable(),
  })
  .strict();
export type MeConsent = z.output<typeof meConsentSchema>;

/** POST /v1/me/consent — принять текущую версию. */
export const meConsentAcceptSchema = z
  .object({
    version: privacyPolicyVersionSchema,
  })
  .strict();
export type MeConsentAccept = z.output<typeof meConsentAcceptSchema>;

/** DELETE /v1/me — typed-confirm email (как admin soft-delete). */
export const meDeleteSchema = z
  .object({
    confirm: emailSchema,
  })
  .strict();
export type MeDelete = z.output<typeof meDeleteSchema>;

/** Урезанный профиль в экспорте (без хешей/токенов). */
export const meExportUserSchema = z
  .object({
    id: uuidSchema,
    email: emailSchema,
    display_name: z.string(),
    locale: z.string(),
    handle: z.string().nullable(),
    role: z.enum(['user', 'admin']),
    plan_code: z.string(),
    ai_enabled: z.boolean(),
    email_verified: z.boolean(),
    created_at: utcDateTimeSchema,
  })
  .strict();
export type MeExportUser = z.output<typeof meExportUserSchema>;

export const meExportDeviceSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    platform: z.string().nullable(),
    source: z.string().nullable(),
    agent_version: z.string().nullable(),
    created_at: utcDateTimeSchema,
    last_seen_at: utcDateTimeSchema.nullable(),
    revoked_at: utcDateTimeSchema.nullable(),
  })
  .strict();
export type MeExportDevice = z.output<typeof meExportDeviceSchema>;

export const meExportFlightSchema = z
  .object({
    id: uuidSchema,
    status: z.string(),
    visibility: z.string(),
    callsign: z.string().nullable(),
    origin_icao: z.string().nullable(),
    destination_icao: z.string().nullable(),
    started_at: utcDateTimeSchema,
    ended_at: utcDateTimeSchema.nullable(),
  })
  .strict();
export type MeExportFlight = z.output<typeof meExportFlightSchema>;

export const meExportAiReportSchema = z
  .object({
    id: uuidSchema,
    flight_id: uuidSchema.nullable(),
    kind: z.string(),
    status: z.string(),
    language: z.string().nullable(),
    created_at: utcDateTimeSchema,
    completed_at: utcDateTimeSchema.nullable(),
    /** Markdown-текст разбора; без `llm_usage` и без чужих отчётов. */
    content_md: z.string().nullable(),
  })
  .strict();
export type MeExportAiReport = z.output<typeof meExportAiReportSchema>;

export const meExportShareSchema = z
  .object({
    id: uuidSchema,
    flight_id: uuidSchema,
    created_at: utcDateTimeSchema,
    expires_at: utcDateTimeSchema.nullable(),
    revoked_at: utcDateTimeSchema.nullable(),
  })
  .strict();
export type MeExportShare = z.output<typeof meExportShareSchema>;

/** T184: собственные членства в клубах (без чужих roster rows). */
export const meExportClubMembershipSchema = z
  .object({
    club_id: uuidSchema,
    slug: z.string(),
    name: z.string(),
    role: z.enum(['owner', 'officer', 'member']),
    status: z.enum(['invited', 'active', 'left', 'kicked']),
    joined_at: utcDateTimeSchema.nullable(),
  })
  .strict();
export type MeExportClubMembership = z.output<typeof meExportClubMembershipSchema>;

/** T184: собственные итоги клубных экзаменов (только субъект экспорта). */
export const meExportClubExamResultSchema = z
  .object({
    club_id: uuidSchema,
    exam_id: uuidSchema,
    title: z.string(),
    status: z.enum(['in_progress', 'passed', 'failed']),
    passed_count: z.number().int().min(0),
    required_count: z.number().int().min(0),
    completed_at: utcDateTimeSchema.nullable(),
    updated_at: utcDateTimeSchema,
  })
  .strict();
export type MeExportClubExamResult = z.output<typeof meExportClubExamResultSchema>;

/**
 * T73 follow-up: одна точка трека в экспорте субъекта. Только собственные
 * геоданные без внутренних id/токенов/`quality`-маски и без сырых телеметрических
 * каналов, не нужных для переносимости. Объём ограничен на сервере (см.
 * `EXPORT_TRACK_POINTS_LIMIT`).
 */
export const meExportTrackPointSchema = z
  .object({
    flight_id: uuidSchema,
    ts: utcDateTimeSchema,
    lat: z.number().finite().gte(-90).lte(90),
    lon: z.number().finite().gte(-180).lte(180),
    altitude_ft: z.number().finite().nullable(),
    on_ground: z.boolean(),
    groundspeed_kt: z.number().finite().nullable(),
  })
  .strict();
export type MeExportTrackPoint = z.output<typeof meExportTrackPointSchema>;

/**
 * GET /v1/me/export — дамп субъекта (DATA-5).
 * Без `llm_usage` / секретов (пароль, TOTP, токены, IP / чужие данные).
 *
 * `track_points` — ограниченная выборка сырых точек (лимит сервера); полный
 * трек без лимита — пост-MVP (async-export). `track_points_included`/`policy_url`
 * аддитивны и имеют дефолты для совместимости со старыми потребителями.
 */
export const meExportSchema = z
  .object({
    schema_version: z.literal(1),
    exported_at: utcDateTimeSchema,
    /** T73 follow-up: URL политики/согласий ПДн; `null` пока не опубликована. */
    policy_url: z.string().url().nullable().default(null),
    user: meExportUserSchema,
    consent: meConsentSchema,
    devices: z.array(meExportDeviceSchema),
    flights: z.array(meExportFlightSchema),
    ai_reports: z.array(meExportAiReportSchema),
    share_links: z.array(meExportShareSchema),
    /** T183: личные заметки капитанского журнала (не в public `/s`). */
    journal_notes: z.array(meExportJournalNoteSchema).default([]),
    /** T184: собственные клубные членства и итоги экзаменов (не чужие roster). */
    club_memberships: z.array(meExportClubMembershipSchema).default([]),
    club_exam_results: z.array(meExportClubExamResultSchema).default([]),
    /** T73 follow-up: ограниченная выборка сырых точек трека субъекта. */
    track_points: z.array(meExportTrackPointSchema).default([]),
    /** `true`, если сырые точки трека включены (лимитированно). */
    track_points_included: z.boolean().default(false),
  })
  .strict();
export type MeExport = z.output<typeof meExportSchema>;
