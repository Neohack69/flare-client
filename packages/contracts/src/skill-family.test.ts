import { describe, expect, it } from 'vitest';

import {
  FLEET_SKILLS_CATALOG_VERSION,
  resolveSkillFamilyId,
  skillFamilyTitles,
  SKILL_FAMILY_CATALOG,
} from './skill-family.js';
import { fleetSkillsResponseSchema } from './stats.js';

describe('skill-family catalog (T180)', () => {
  it('A20N → a320; BCS3 → a220 (не a320); ZZZZ → unknown', () => {
    expect(resolveSkillFamilyId('A20N')).toBe('a320');
    expect(resolveSkillFamilyId('a319')).toBe('a320');
    expect(resolveSkillFamilyId('BCS3')).toBe('a220');
    expect(resolveSkillFamilyId('ZZZZ')).toBe('unknown');
    expect(resolveSkillFamilyId(null)).toBe('unknown');
    expect(resolveSkillFamilyId(undefined)).toBe('unknown');
  });

  it('неизвестный ICAO → singleton icao:XXXX', () => {
    expect(resolveSkillFamilyId('C130')).toBe('icao:C130');
    expect(resolveSkillFamilyId('sf50')).toBe('icao:SF50');
  });

  it('каждый member сида уникален и мапится в свой family', () => {
    const seen = new Set<string>();
    for (const [familyId, meta] of Object.entries(SKILL_FAMILY_CATALOG)) {
      for (const icao of meta.members) {
        expect(seen.has(icao), `duplicate ICAO ${icao}`).toBe(false);
        seen.add(icao);
        expect(resolveSkillFamilyId(icao)).toBe(familyId);
      }
    }
  });

  it('catalog_version стабилен', () => {
    expect(FLEET_SKILLS_CATALOG_VERSION).toBe('fleet-skills@1.0.0');
    expect(skillFamilyTitles('a320').title_en).toContain('A320');
    expect(skillFamilyTitles('icao:C130').title_en).toBe('C130');
  });

  it('сид миграции 0051 согласован с каталогом (не model_key)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const sqlPath = join(
      here,
      '..',
      '..',
      '..',
      'apps',
      'api',
      'migrations',
      '0051_aircraft_skill_family.sql',
    );
    const sql = await readFile(sqlPath, 'utf8');
    const pairs = [...sql.matchAll(/\('([A-Z0-9]{2,4})',\s*'([a-z0-9_]+)'\)/g)];
    expect(pairs.length).toBeGreaterThan(10);
    for (const [, icao, family] of pairs) {
      expect(resolveSkillFamilyId(icao!), `seed ${icao}`).toBe(family);
    }
  });
});

describe('fleetSkillsResponseSchema (T180)', () => {
  it('принимает пустой аккаунт и Free locked stub', () => {
    const empty = {
      data: { free_family_id: null, families: [] },
      meta: {
        generated_at: '2026-10-05T12:00:00.000Z',
        timezone: 'UTC' as const,
        week_count: 12 as const,
        catalog_version: FLEET_SKILLS_CATALOG_VERSION,
        entitlement: {
          plan_code: 'free' as const,
          all_families: false,
          free_family_limit: 1 as const,
        },
      },
    };
    expect(fleetSkillsResponseSchema.safeParse(empty).success).toBe(true);

    const fixedWeeks = [
      '2026-07-13',
      '2026-07-20',
      '2026-07-27',
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
    ].map((week_start) => ({
      week_start,
      avg_score: null as number | null,
      landings_count: 0,
      avg_vs_fpm: null as number | null,
      avg_centreline_m: null as number | null,
    }));

    const freeStub = {
      data: {
        free_family_id: 'a320',
        families: [
          {
            family_id: 'a320',
            title_ru: 'Семейство A320',
            title_en: 'A320 family',
            member_icaos: ['A320'],
            locked: false,
            lock_reason: null,
            lifetime_landings: 3,
            lifetime_avg_score: 80,
            lifetime_best_score: 90,
            weeks: fixedWeeks,
          },
          {
            family_id: 'b737',
            title_ru: 'Семейство 737',
            title_en: '737 family',
            member_icaos: ['B738'],
            locked: true,
            lock_reason: 'free_cap',
            lifetime_landings: 1,
            lifetime_avg_score: 70,
            lifetime_best_score: 70,
            weeks: null,
          },
        ],
      },
      meta: empty.meta,
    };
    expect(fleetSkillsResponseSchema.safeParse(freeStub).success).toBe(true);
  });
});
