import { describe, expect, it } from 'vitest';

import {
  clubInviteNotificationSchema,
  friendAchievementNotificationSchema,
  notificationKindFilterSchema,
  notificationsListQuerySchema,
  notificationsListSchema,
  notificationsMarkReadSchema,
  notificationsUnreadQuerySchema,
  notificationsUnreadSchema,
  ownTouchdownNotificationSchema,
  userNotificationSchema,
} from './notifications.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const ACTOR = '223e4567-e89b-42d3-a456-426614174001';
const NOW = '2026-10-05T12:00:00.000Z';

describe('notifications contracts (T174 / T181)', () => {
  it('принимает friend_achievement строку с каталоговыми title', () => {
    const parsed = friendAchievementNotificationSchema.safeParse({
      id: UUID,
      kind: 'friend_achievement',
      created_at: NOW,
      read_at: null,
      actor: {
        id: ACTOR,
        handle: 'marina',
        display_name: 'Марина',
        deleted: false,
      },
      achievement: {
        id: 'first_landing',
        title_ru: 'Первое касание',
        title_en: 'First touchdown',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('принимает own_touchdown (T181) и discriminated list', () => {
    const own = {
      id: UUID,
      kind: 'own_touchdown' as const,
      created_at: NOW,
      read_at: null,
      flight_id: UUID,
      landing_seq: 1,
      score: 90,
      grade: 'good' as const,
      vs_fpm: -150,
      aircraft_icao: 'A320',
      origin_icao: 'UUEE',
      destination_icao: 'ULLI',
      runway_icao: '06L',
      touchdown_at: NOW,
    };
    expect(ownTouchdownNotificationSchema.safeParse(own).success).toBe(true);
    expect(userNotificationSchema.safeParse(own).success).toBe(true);
    expect(
      notificationsListSchema.safeParse({
        items: [own],
        unread_count: 1,
      }).success,
    ).toBe(true);
  });

  it('принимает club_invite и валидирует клуб', () => {
    const invite = {
      id: UUID,
      kind: 'club_invite' as const,
      created_at: NOW,
      read_at: null,
      actor: { id: ACTOR, handle: 'neohack', display_name: 'Игорь', deleted: false },
      club: { id: UUID, slug: 'test-club', name: 'Test Club' },
    };
    expect(clubInviteNotificationSchema.safeParse(invite).success).toBe(true);
    expect(userNotificationSchema.safeParse(invite).success).toBe(true);
    expect(
      clubInviteNotificationSchema.safeParse({ ...invite, club: { ...invite.club, slug: 'BAD SLUG' } })
        .success,
    ).toBe(false);
    expect(
      clubInviteNotificationSchema.safeParse({ ...invite, club: { id: UUID, slug: 'x' } }).success,
    ).toBe(false);
  });

  it('origin_icao/touchdown_at аддитивны: без них и с null — валидно (старые строки)', () => {
    const base = {
      id: UUID,
      kind: 'own_touchdown' as const,
      created_at: NOW,
      read_at: null,
      flight_id: UUID,
      landing_seq: 1,
      score: null,
      grade: null,
      vs_fpm: null,
      aircraft_icao: null,
      destination_icao: 'ULLI',
      runway_icao: null,
    };
    // Старый ответ без новых полей — всё ещё валиден.
    const legacy = ownTouchdownNotificationSchema.safeParse(base);
    expect(legacy.success).toBe(true);
    if (legacy.success) {
      expect(legacy.data.origin_icao).toBeUndefined();
      expect(legacy.data.touchdown_at).toBeUndefined();
    }
    // Явные null (сервер отдаёт null для legacy-строк) — тоже валидно.
    const nullable = ownTouchdownNotificationSchema.safeParse({
      ...base,
      origin_icao: null,
      touchdown_at: null,
    });
    expect(nullable.success).toBe(true);
    if (nullable.success) {
      expect(nullable.data.origin_icao).toBeNull();
      expect(nullable.data.touchdown_at).toBeNull();
    }
    // Неверный тип — отклоняем.
    expect(
      ownTouchdownNotificationSchema.safeParse({ ...base, origin_icao: 123 }).success,
    ).toBe(false);
    expect(
      ownTouchdownNotificationSchema.safeParse({ ...base, touchdown_at: 'not-a-date' }).success,
    ).toBe(false);
  });

  it('mark-read: ids или all; пустой body — нет', () => {
    expect(notificationsMarkReadSchema.safeParse({ all: true }).success).toBe(true);
    expect(notificationsMarkReadSchema.safeParse({ ids: [UUID] }).success).toBe(true);
    expect(notificationsMarkReadSchema.safeParse({}).success).toBe(false);
    expect(notificationsMarkReadSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(notificationsMarkReadSchema.safeParse({ all: false }).success).toBe(false);
  });

  it('list / unread-count схемы', () => {
    expect(
      notificationsUnreadSchema.safeParse({
        count: 0,
        by_kind: { friend_achievement: 0, own_touchdown: 0, club_invite: 0 },
      }).success,
    ).toBe(true);
    // by_kind обязателен — без него ответ невалиден.
    expect(notificationsUnreadSchema.safeParse({ count: 0 }).success).toBe(false);
    expect(
      notificationsUnreadSchema.safeParse({
        count: 3,
        by_kind: { friend_achievement: 1, own_touchdown: 2, club_invite: 0 },
      }).success,
    ).toBe(true);
    expect(
      notificationsListSchema.safeParse({
        items: [],
        unread_count: 0,
      }).success,
    ).toBe(true);
  });

  it('kind-фильтр: одиночное значение и CSV → массив; дубликаты схлопываются', () => {
    expect(notificationKindFilterSchema.parse('own_touchdown')).toEqual(['own_touchdown']);
    expect(notificationKindFilterSchema.parse('friend_achievement,own_touchdown')).toEqual([
      'friend_achievement',
      'own_touchdown',
    ]);
    expect(notificationKindFilterSchema.parse(' own_touchdown , friend_achievement ')).toEqual([
      'own_touchdown',
      'friend_achievement',
    ]);
    expect(notificationKindFilterSchema.parse('own_touchdown,own_touchdown')).toEqual([
      'own_touchdown',
    ]);
    expect(notificationKindFilterSchema.safeParse('').success).toBe(false);
    expect(notificationKindFilterSchema.safeParse('   ').success).toBe(false);
    expect(notificationKindFilterSchema.safeParse('bogus').success).toBe(false);
    expect(notificationKindFilterSchema.safeParse('own_touchdown,bogus').success).toBe(false);
  });

  it('list-query: kind опционален; limit по умолчанию 20', () => {
    expect(notificationsListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(notificationsListQuerySchema.parse({ kind: 'friend_achievement' }).kind).toEqual([
      'friend_achievement',
    ]);
    expect(notificationsListQuerySchema.parse({ limit: '5', kind: 'own_touchdown' }).limit).toBe(5);
  });

  it('unread-query: kind опционален, strict', () => {
    expect(notificationsUnreadQuerySchema.parse({})).toEqual({});
    expect(notificationsUnreadQuerySchema.parse({ kind: 'own_touchdown' }).kind).toEqual([
      'own_touchdown',
    ]);
    expect(notificationsUnreadQuerySchema.safeParse({ bogus: 'x' }).success).toBe(false);
  });

  it('mark-read: kind-скоуп; refine всё ещё требует all/ids', () => {
    expect(
      notificationsMarkReadSchema.safeParse({ all: true, kind: 'friend_achievement' }).success,
    ).toBe(true);
    expect(
      notificationsMarkReadSchema.safeParse({ ids: [UUID], kind: 'friend_achievement' }).success,
    ).toBe(true);
    expect(notificationsMarkReadSchema.safeParse({ kind: 'friend_achievement' }).success).toBe(
      false,
    );
    expect(notificationsMarkReadSchema.parse({ all: true, kind: 'own_touchdown' }).kind).toEqual([
      'own_touchdown',
    ]);
  });
});
