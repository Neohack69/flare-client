import { z } from 'zod';

import { aircraftIcaoSchema, airportIcaoSchema, utcDateTimeSchema, uuidSchema } from './primitives.js';
import { handleSchema } from './handle.js';

/**
 * T184 — клубные экзамены по белому списку полос (VA runway whitelist).
 * Matching keys совпадают с T96/T177: `destination_icao` + `runway_icao`
 * (+ optional `aircraft_icao`); зачёт = `eligible AND verified`.
 */

/** §6.4 — лимиты по умолчанию. */
export const CLUB_OWNED_LIMIT = 3;
export const CLUB_MEMBERS_ACTIVE_LIMIT = 50;
export const CLUB_EXAM_ITEMS_LIMIT = 12;
export const CLUB_PUBLISHED_EXAMS_LIMIT = 3;
export const CLUB_LIST_CAP = 50;
/** Cap ответа roster: active лимит + запас на `invited`/терминальные строки (F5). */
export const CLUB_MEMBERS_LIST_CAP = CLUB_MEMBERS_ACTIVE_LIMIT + 20;
/** Cap списка входящих приглашений пользователя. */
export const CLUB_INVITES_LIST_CAP = 50;
export const CLUB_NAME_MAX = 80;
export const CLUB_EXAM_TITLE_MAX = 80;

/**
 * B3 — палитра бренда клуба (Pro). Храним ключ, а не свободный hex: значения
 * цветов живут в `packages/ui/src/tokens.css` и имеют отдельные варианты для
 * тёмной/светлой темы (контраст текста ≥4.5).
 */
export const CLUB_BRAND_COLORS = [
  'steel',
  'sky',
  'mint',
  'amber',
  'coral',
  'rose',
  'violet',
  'slate',
] as const;
export const clubBrandColorSchema = z.enum(CLUB_BRAND_COLORS);
export type ClubBrandColor = z.output<typeof clubBrandColorSchema>;

export const clubRoleSchema = z.enum(['owner', 'officer', 'member']);
export type ClubRole = z.output<typeof clubRoleSchema>;

export const clubMembershipStatusSchema = z.enum(['invited', 'active', 'left', 'kicked']);
export type ClubMembershipStatus = z.output<typeof clubMembershipStatusSchema>;

export const clubStatusSchema = z.enum(['active', 'archived']);
export type ClubStatus = z.output<typeof clubStatusSchema>;

export const clubExamStatusSchema = z.enum(['draft', 'published', 'closed']);
export type ClubExamStatus = z.output<typeof clubExamStatusSchema>;

export const clubExamResultStatusSchema = z.enum(['in_progress', 'passed', 'failed']);
export type ClubExamResultStatus = z.output<typeof clubExamResultStatusSchema>;

/** `^[a-z0-9-]{3,32}` со стартом/концом на букву-цифру. */
export const clubSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/);

/** Пункт белого списка ВПП экзамена. `aircraft_icao = null` — любой тип. */
export const clubExamItemSchema = z
  .object({
    destination_icao: z.string().trim().toUpperCase().pipe(airportIcaoSchema),
    runway_icao: z.string().trim().toUpperCase().min(1).max(8),
    aircraft_icao: z
      .string()
      .trim()
      .toUpperCase()
      .pipe(aircraftIcaoSchema)
      .nullable(),
    min_score: z.number().int().min(0).max(100),
    sort_order: z.number().int().min(0).max(1000),
  })
  .strict();
export type ClubExamItem = z.output<typeof clubExamItemSchema>;

/** Участник клуба (roster). Без email и других ПДн. */
export const clubMemberSchema = z
  .object({
    user_id: uuidSchema,
    handle: handleSchema.nullable(),
    display_name: z.string(),
    role: clubRoleSchema,
    status: clubMembershipStatusSchema,
    joined_at: utcDateTimeSchema.nullable(),
  })
  .strict();
export type ClubMember = z.output<typeof clubMemberSchema>;

/** Клуб в списке/карточке. `role` — роль запрашивающего пользователя. */
export const clubSchema = z
  .object({
    id: uuidSchema,
    slug: clubSlugSchema,
    name: z.string().min(1).max(CLUB_NAME_MAX),
    status: clubStatusSchema,
    owner_user_id: uuidSchema,
    role: clubRoleSchema,
    member_count: z.number().int().min(0),
    /** B3: `null` — без бренда; иначе ключ палитры (не hex). */
    brand_color: clubBrandColorSchema.nullable().default(null),
    created_at: utcDateTimeSchema,
    archived_at: utcDateTimeSchema.nullable(),
  })
  .strict();
export type Club = z.output<typeof clubSchema>;

export const clubListSchema = z
  .object({
    clubs: z.array(clubSchema).max(CLUB_LIST_CAP),
  })
  .strict();
export type ClubList = z.output<typeof clubListSchema>;

export const clubCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(CLUB_NAME_MAX),
    slug: clubSlugSchema.optional(),
  })
  .strict();
export type ClubCreate = z.output<typeof clubCreateSchema>;

export const clubUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(CLUB_NAME_MAX).optional(),
    archive: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.archive === true, {
    message: 'empty patch',
  });
export type ClubUpdate = z.output<typeof clubUpdateSchema>;

/** B3: `PATCH /v1/clubs/:id/branding` — только ключ палитры или сброс (`null`). */
export const clubBrandingUpdateSchema = z
  .object({
    brand_color: clubBrandColorSchema.nullable(),
  })
  .strict();
export type ClubBrandingUpdate = z.output<typeof clubBrandingUpdateSchema>;

export const clubInviteSchema = z
  .object({
    handle: handleSchema,
  })
  .strict();
export type ClubInvite = z.output<typeof clubInviteSchema>;

export const clubMemberListSchema = z
  .object({
    members: z.array(clubMemberSchema).max(CLUB_MEMBERS_LIST_CAP),
  })
  .strict();
export type ClubMemberList = z.output<typeof clubMemberListSchema>;

/**
 * Pending-приглашение текущего пользователя (surface «Мои приглашения»).
 * Минимум для UI: клуб + роль приглашения + когда/кто позвал. Без email/ПДн.
 * `inviter_display_name` = null, если пригласивший удалён (FK SET NULL).
 */
export const clubInviteItemSchema = z
  .object({
    club_id: uuidSchema,
    slug: clubSlugSchema,
    name: z.string().min(1).max(CLUB_NAME_MAX),
    role: clubRoleSchema,
    invited_at: utcDateTimeSchema,
    inviter_display_name: z.string().nullable(),
  })
  .strict();
export type ClubInviteItem = z.output<typeof clubInviteItemSchema>;

export const clubInviteListSchema = z
  .object({
    invites: z.array(clubInviteItemSchema).max(CLUB_INVITES_LIST_CAP),
  })
  .strict();
export type ClubInviteList = z.output<typeof clubInviteListSchema>;

/** Свой прогресс по одной полосе (cache best matching landing в окне). */
export const clubExamAttemptSchema = z
  .object({
    destination_icao: airportIcaoSchema,
    runway_icao: z.string().min(1).max(8),
    aircraft_icao: aircraftIcaoSchema.nullable(),
    best_score: z.number().int().min(0).max(100),
    passed: z.boolean(),
    best_landing_id: uuidSchema.nullable(),
    updated_at: utcDateTimeSchema,
  })
  .strict();
export type ClubExamAttempt = z.output<typeof clubExamAttemptSchema>;

/** Экзамен в списке клуба + сводка собственного прогресса. */
export const clubExamSummarySchema = z
  .object({
    id: uuidSchema,
    club_id: uuidSchema,
    title: z.string().min(1).max(CLUB_EXAM_TITLE_MAX),
    status: clubExamStatusSchema,
    starts_at: utcDateTimeSchema.nullable(),
    ends_at: utcDateTimeSchema.nullable(),
    published_at: utcDateTimeSchema.nullable(),
    closed_at: utcDateTimeSchema.nullable(),
    item_count: z.number().int().min(0),
    required_count: z.number().int().min(0),
    /** Собственный статус запрашивающего (member view). */
    my_status: clubExamResultStatusSchema.nullable(),
    my_passed_count: z.number().int().min(0).nullable(),
  })
  .strict();
export type ClubExamSummary = z.output<typeof clubExamSummarySchema>;

export const clubExamListSchema = z
  .object({
    exams: z.array(clubExamSummarySchema),
  })
  .strict();
export type ClubExamList = z.output<typeof clubExamListSchema>;

export const clubExamDetailSchema = clubExamSummarySchema.extend({
  items: z.array(clubExamItemSchema),
  attempts: z.array(clubExamAttemptSchema),
});
export type ClubExamDetail = z.output<typeof clubExamDetailSchema>;

/** Нормализованный ключ пункта (без учёта регистра) для проверки дублей. */
function duplicateItemKey(item: Pick<ClubExamItem, 'destination_icao' | 'runway_icao' | 'aircraft_icao'>): string {
  return [
    item.destination_icao.toUpperCase(),
    item.runway_icao.toUpperCase(),
    (item.aircraft_icao ?? '').toUpperCase(),
  ].join('|');
}

function hasDuplicateItems(
  items: ReadonlyArray<Pick<ClubExamItem, 'destination_icao' | 'runway_icao' | 'aircraft_icao'>>,
): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    const key = duplicateItemKey(item);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export const clubExamCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(CLUB_EXAM_TITLE_MAX),
    starts_at: utcDateTimeSchema.nullable().optional(),
    ends_at: utcDateTimeSchema.nullable().optional(),
    items: z.array(clubExamItemSchema).min(1).max(CLUB_EXAM_ITEMS_LIMIT),
  })
  .strict()
  .refine((v) => !hasDuplicateItems(v.items), { message: 'duplicate runway items' });
export type ClubExamCreate = z.output<typeof clubExamCreateSchema>;

export const clubExamUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(CLUB_EXAM_TITLE_MAX).optional(),
    starts_at: utcDateTimeSchema.nullable().optional(),
    ends_at: utcDateTimeSchema.nullable().optional(),
    items: z.array(clubExamItemSchema).min(1).max(CLUB_EXAM_ITEMS_LIMIT).optional(),
  })
  .strict()
  .refine((v) => v.items === undefined || !hasDuplicateItems(v.items), {
    message: 'duplicate runway items',
  })
  .refine((v) => v.title !== undefined || v.items !== undefined || v.starts_at !== undefined || v.ends_at !== undefined, {
    message: 'empty patch',
  });
export type ClubExamUpdate = z.output<typeof clubExamUpdateSchema>;

/** Roster (officer+): per-item best score + status каждого участника. */
export const clubExamRosterEntrySchema = z
  .object({
    user_id: uuidSchema,
    handle: handleSchema.nullable(),
    display_name: z.string(),
    role: clubRoleSchema,
    status: clubExamResultStatusSchema,
    passed_count: z.number().int().min(0),
    required_count: z.number().int().min(0),
    completed_at: utcDateTimeSchema.nullable(),
    items: z.array(
      z
        .object({
          destination_icao: airportIcaoSchema,
          runway_icao: z.string().min(1).max(8),
          aircraft_icao: aircraftIcaoSchema.nullable(),
          best_score: z.number().int().min(0).max(100).nullable(),
          passed: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type ClubExamRosterEntry = z.output<typeof clubExamRosterEntrySchema>;

export const clubExamRosterSchema = z
  .object({
    exam: clubExamSummarySchema,
    entries: z.array(clubExamRosterEntrySchema).max(CLUB_MEMBERS_ACTIVE_LIMIT),
  })
  .strict();
export type ClubExamRoster = z.output<typeof clubExamRosterSchema>;
