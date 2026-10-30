import { z } from 'zod';

import { CLUB_NAME_MAX, clubSlugSchema } from './clubs.js';
import { handleSchema } from './handle.js';
import {
  aircraftIcaoSchema,
  airportIcaoSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './primitives.js';
import { scoreGradeSchema } from './scoring.js';

/** T174 friend_achievement + T181 own_touchdown + club_invite (расширение CHECK). */
export const notificationKindSchema = z.enum([
  'friend_achievement',
  'own_touchdown',
  'club_invite',
]);
export type NotificationKind = z.output<typeof notificationKindSchema>;

/**
 * Фильтр inbox по kind: одиночное значение или CSV-список
 * (`?kind=own_touchdown` / `?kind=friend_achievement,own_touchdown`).
 * Выбран CSV вместо repeatable `?kind=&kind=`, потому что:
 *  - один и тот же параметр работает и в `@Query` (Express всегда даёт string),
 *    и в JSON-теле mark-read, без ветвлений по типу;
 *  - расширяется на новые kind без изменения контракта;
 *  - отсутствие параметра = все kind (обратная совместимость).
 * Возвращает дедуплицированный массив.
 */
export const notificationKindFilterSchema = z
  .string()
  .transform((raw) =>
    raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(notificationKindSchema).min(1))
  .transform((values) => Array.from(new Set(values)));
export type NotificationKindFilter = z.output<typeof notificationKindFilterSchema>;

export const friendAchievementNotificationSchema = z
  .object({
    id: uuidSchema,
    kind: z.literal('friend_achievement'),
    created_at: utcDateTimeSchema,
    read_at: utcDateTimeSchema.nullable(),
    actor: z
      .object({
        id: uuidSchema,
        handle: handleSchema.nullable(),
        display_name: z.string(),
        deleted: z.boolean(),
      })
      .strict(),
    achievement: z
      .object({
        id: z.string().min(1).max(64),
        title_ru: z.string(),
        title_en: z.string(),
      })
      .strict(),
  })
  .strict();
export type FriendAchievementNotification = z.output<typeof friendAchievementNotificationSchema>;

/** Личное «касание зафиксировано» (T181); Free in-app, Pro + push/Telegram. */
export const ownTouchdownNotificationSchema = z
  .object({
    id: uuidSchema,
    kind: z.literal('own_touchdown'),
    created_at: utcDateTimeSchema,
    read_at: utcDateTimeSchema.nullable(),
    flight_id: uuidSchema,
    landing_seq: z.number().int().positive(),
    score: z.number().min(0).max(100).nullable(),
    grade: scoreGradeSchema.nullable(),
    vs_fpm: z.number().nullable(),
    aircraft_icao: aircraftIcaoSchema.nullable(),
    /**
     * Полный маршрут `origin → destination` (spec friends-notifications.md §6).
     * Оба поля аддитивны и nullable: у старых строк `origin_icao`/`touchdown_at`
     * ещё не было — тогда показываем только пункт назначения.
     */
    origin_icao: airportIcaoSchema.nullable().optional(),
    destination_icao: airportIcaoSchema.nullable(),
    runway_icao: z.string().min(1).max(8).nullable(),
    touchdown_at: utcDateTimeSchema.nullable().optional(),
  })
  .strict();
export type OwnTouchdownNotification = z.output<typeof ownTouchdownNotificationSchema>;

/**
 * Приглашение в клуб (club invite). Одно уведомление на пару (получатель, клуб):
 * повторное приглашение после отказа/исключения переоткрывает строку, а не плодит
 * дубликаты. Действие — переход на `/clubs`, где приглашение можно принять/отклонить.
 */
export const clubInviteNotificationSchema = z
  .object({
    id: uuidSchema,
    kind: z.literal('club_invite'),
    created_at: utcDateTimeSchema,
    read_at: utcDateTimeSchema.nullable(),
    actor: z
      .object({
        id: uuidSchema,
        handle: handleSchema.nullable(),
        display_name: z.string(),
        deleted: z.boolean(),
      })
      .strict(),
    club: z
      .object({
        id: uuidSchema,
        slug: clubSlugSchema,
        name: z.string().min(1).max(CLUB_NAME_MAX),
      })
      .strict(),
  })
  .strict();
export type ClubInviteNotification = z.output<typeof clubInviteNotificationSchema>;

export const userNotificationSchema = z.discriminatedUnion('kind', [
  friendAchievementNotificationSchema,
  ownTouchdownNotificationSchema,
  clubInviteNotificationSchema,
]);
export type UserNotification = z.output<typeof userNotificationSchema>;

export const notificationsListSchema = z
  .object({
    items: z.array(userNotificationSchema).max(50),
    unread_count: z.number().int().nonnegative(),
  })
  .strict();
export type NotificationsList = z.output<typeof notificationsListSchema>;

export const notificationsUnreadByKindSchema = z
  .object({
    friend_achievement: z.number().int().nonnegative(),
    own_touchdown: z.number().int().nonnegative(),
    club_invite: z.number().int().nonnegative(),
  })
  .strict();
export type NotificationsUnreadByKind = z.output<typeof notificationsUnreadByKindSchema>;

export const notificationsUnreadSchema = z
  .object({
    /** Суммарный unread без фильтра по kind (обратная совместимость). */
    count: z.number().int().nonnegative(),
    /** Разбивка unread по kind, чтобы UI брал «свою» цифру. */
    by_kind: notificationsUnreadByKindSchema,
  })
  .strict();
export type NotificationsUnread = z.output<typeof notificationsUnreadSchema>;

export const notificationsUnreadQuerySchema = z
  .object({
    kind: notificationKindFilterSchema.optional(),
  })
  .strict();
export type NotificationsUnreadQuery = z.output<typeof notificationsUnreadQuerySchema>;

export const notificationsListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    kind: notificationKindFilterSchema.optional(),
  })
  .strict();
export type NotificationsListQuery = z.output<typeof notificationsListQuerySchema>;

export const notificationsMarkReadSchema = z
  .object({
    ids: z.array(uuidSchema).max(50).optional(),
    all: z.boolean().optional(),
    /** Ограничить mark-read одним/несколькими kind; без него — все kinds. */
    kind: notificationKindFilterSchema.optional(),
  })
  .strict()
  .refine((body) => body.all === true || (body.ids != null && body.ids.length > 0), {
    message: 'ids or all required',
  });
export type NotificationsMarkRead = z.output<typeof notificationsMarkReadSchema>;

export const notificationsMarkReadResultSchema = z
  .object({
    updated: z.number().int().nonnegative(),
  })
  .strict();
export type NotificationsMarkReadResult = z.output<typeof notificationsMarkReadResultSchema>;
