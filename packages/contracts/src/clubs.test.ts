import { describe, expect, it } from 'vitest';

import {
  CLUB_BRAND_COLORS,
  CLUB_EXAM_ITEMS_LIMIT,
  clubBrandingUpdateSchema,
  clubExamCreateSchema,
  clubExamItemSchema,
  clubExamUpdateSchema,
  clubInviteItemSchema,
  clubInviteListSchema,
  clubSlugSchema,
} from './clubs.js';

const item = (over: Partial<Record<string, unknown>> = {}) => ({
  destination_icao: 'ULLI',
  runway_icao: '28L',
  aircraft_icao: null,
  min_score: 70,
  sort_order: 0,
  ...over,
});

describe('clubs — белый список ВПП', () => {
  it('нормализует ICAO/designator к верхнему регистру', () => {
    const parsed = clubExamItemSchema.parse(item({ destination_icao: 'ulli', runway_icao: '28l' }));
    expect(parsed.destination_icao).toBe('ULLI');
    expect(parsed.runway_icao).toBe('28L');
  });

  it('отклоняет неверный ICAO, длинный designator и min_score вне 0..100', () => {
    expect(clubExamItemSchema.safeParse(item({ destination_icao: 'ULL' })).success).toBe(false);
    expect(clubExamItemSchema.safeParse(item({ runway_icao: '123456789' })).success).toBe(false);
    expect(clubExamItemSchema.safeParse(item({ min_score: 101 })).success).toBe(false);
    expect(clubExamItemSchema.safeParse(item({ min_score: -1 })).success).toBe(false);
  });

  it('отклоняет лишние поля (strict)', () => {
    expect(clubExamItemSchema.safeParse(item({ extra: true })).success).toBe(false);
  });
});

describe('clubs — exam create', () => {
  it('принимает корректный набор', () => {
    const parsed = clubExamCreateSchema.parse({ title: 'Checkride', items: [item()] });
    expect(parsed.items).toHaveLength(1);
  });

  it('отклоняет дубли пунктов (create)', () => {
    const result = clubExamCreateSchema.safeParse({
      title: 'Dup',
      items: [item(), item({ runway_icao: '28l' })],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message === 'duplicate runway items')).toBe(true);
    }
  });

  it('пустой список и превышение лимита пунктов отклоняются', () => {
    expect(clubExamCreateSchema.safeParse({ title: 'Empty', items: [] }).success).toBe(false);
    const many = Array.from({ length: CLUB_EXAM_ITEMS_LIMIT + 1 }, (_, i) =>
      item({ runway_icao: `R${i}`, sort_order: i }),
    );
    expect(clubExamCreateSchema.safeParse({ title: 'Many', items: many }).success).toBe(false);
  });
});

describe('clubs — exam update (F4)', () => {
  it('принимает patch без items и непустой patch', () => {
    expect(clubExamUpdateSchema.safeParse({ title: 'Renamed' }).success).toBe(true);
  });

  it('отклоняет пустой patch', () => {
    expect(clubExamUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('отклоняет дубли items (update) — 422, а не 500 unique violation', () => {
    const result = clubExamUpdateSchema.safeParse({
      items: [item(), item({ aircraft_icao: null })],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message === 'duplicate runway items')).toBe(true);
    }
  });

  it('принимает недублирующиеся items', () => {
    const result = clubExamUpdateSchema.safeParse({
      items: [item({ runway_icao: '28L' }), item({ runway_icao: '10R' })],
    });
    expect(result.success).toBe(true);
  });
});

describe('clubs — slug', () => {
  it('принимает валидный и отклоняет невалидный slug', () => {
    expect(clubSlugSchema.safeParse('aero-club').success).toBe(true);
    expect(clubSlugSchema.safeParse('-bad').success).toBe(false);
    expect(clubSlugSchema.safeParse('ab').success).toBe(false);
    expect(clubSlugSchema.safeParse('Bad_Upper').success).toBe(false);
  });
});

describe('clubs — invites (wave2)', () => {
  const invite = {
    club_id: '123e4567-e89b-42d3-a456-426614174000',
    slug: 'aero-club',
    name: 'Aero Club',
    role: 'member',
    invited_at: '2026-10-10T12:00:00.000Z',
    inviter_display_name: 'Owner',
  };

  it('парсит pending-приглашение и список', () => {
    expect(clubInviteItemSchema.safeParse(invite).success).toBe(true);
    expect(clubInviteListSchema.safeParse({ invites: [invite] }).success).toBe(true);
  });

  it('inviter_display_name nullable; битый role и лишние поля отклоняются', () => {
    expect(clubInviteItemSchema.safeParse({ ...invite, inviter_display_name: null }).success).toBe(
      true,
    );
    expect(clubInviteItemSchema.safeParse({ ...invite, role: 'admin' }).success).toBe(false);
    expect(clubInviteItemSchema.safeParse({ ...invite, email: 'x@y.z' }).success).toBe(false);
  });
});

describe('clubs — branding palette (B3)', () => {
  it('accepts every palette key and null reset', () => {
    for (const key of CLUB_BRAND_COLORS) {
      expect(clubBrandingUpdateSchema.safeParse({ brand_color: key }).success).toBe(true);
    }
    expect(clubBrandingUpdateSchema.safeParse({ brand_color: null }).success).toBe(true);
  });

  it('rejects free hex, unknown keys and extra fields', () => {
    for (const value of ['#ff0000', 'red', 'AMBER', '']) {
      expect(clubBrandingUpdateSchema.safeParse({ brand_color: value }).success).toBe(false);
    }
    expect(clubBrandingUpdateSchema.safeParse({ brand_color: 'amber', extra: true }).success).toBe(
      false,
    );
    expect(clubBrandingUpdateSchema.safeParse({}).success).toBe(false);
  });
});
