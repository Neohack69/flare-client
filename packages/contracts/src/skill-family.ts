/**
 * T180 — каталог skill family (семейства ВС для трендов посадок).
 * Source of display titles + allowlist slug'ов. JOIN в БД — колонка
 * `aircraft.skill_family` (миграция 0051); `model_key` сюда не маппится.
 */

export const FLEET_SKILLS_CATALOG_VERSION = 'fleet-skills@1.0.0' as const;

export interface SkillFamilyMeta {
  title_en: string;
  title_ru: string;
  /** ICAO members из сида 0013; не полный мировой каталог. */
  members: readonly string[];
}

/** Стабильные slug'и семейств MVP (без singleton `icao:` / `unknown`). */
export const SKILL_FAMILY_CATALOG = {
  a320: {
    title_en: 'A320 family',
    title_ru: 'Семейство A320',
    members: ['A319', 'A320', 'A20N', 'A321'],
  },
  b737: {
    title_en: '737 family',
    title_ru: 'Семейство 737',
    members: ['B738', 'B739', 'B37M'],
  },
  a220: {
    title_en: 'A220 family',
    title_ru: 'Семейство A220',
    members: ['BCS3'],
  },
  e190: {
    title_en: 'E190 family',
    title_ru: 'Семейство E190',
    members: ['E190'],
  },
  crj: {
    title_en: 'CRJ family',
    title_ru: 'Семейство CRJ',
    members: ['CRJ9'],
  },
  c172: {
    title_en: 'C172 family',
    title_ru: 'Семейство C172',
    members: ['C152', 'C172', 'C182'],
  },
  pa28: {
    title_en: 'Low-wing GA',
    title_ru: 'Лёгкие НВ (low-wing)',
    members: ['PA28', 'SR22', 'DA40'],
  },
  ga_twin: {
    title_en: 'GA twin',
    title_ru: 'Лёгкие двухмоторные',
    members: ['PA34', 'DA42'],
  },
  turboprop_single: {
    title_en: 'Turboprop single',
    title_ru: 'Турбовинтовые одномоторные',
    members: ['C208', 'PC12'],
  },
  turboprop_twin: {
    title_en: 'Turboprop twin',
    title_ru: 'Турбовинтовые двухмоторные',
    members: ['B350', 'AT72', 'DH8D'],
  },
  bizjet: {
    title_en: 'Bizjet',
    title_ru: 'Бизнес-джеты',
    members: ['C525', 'C560', 'GLF6'],
  },
  widebody: {
    title_en: 'Widebody',
    title_ru: 'Широкофюзеляжные',
    members: ['B763', 'B77W', 'B788', 'A333', 'A359'],
  },
  very_large: {
    title_en: 'Very large',
    title_ru: 'Очень большие',
    members: ['B744', 'B748', 'A388'],
  },
  heli: {
    title_en: 'Helicopter',
    title_ru: 'Вертолёты',
    members: ['B407', 'H125'],
  },
  unknown: {
    title_en: 'Unknown',
    title_ru: 'Неизвестно',
    members: ['ZZZZ'],
  },
} as const satisfies Record<string, SkillFamilyMeta>;

export type CatalogSkillFamilyId = keyof typeof SKILL_FAMILY_CATALOG;

/** ICAO → catalog family (только сид); иначе null (нужен singleton / unknown). */
const ICAO_TO_FAMILY: ReadonlyMap<string, CatalogSkillFamilyId> = (() => {
  const map = new Map<string, CatalogSkillFamilyId>();
  for (const [familyId, meta] of Object.entries(SKILL_FAMILY_CATALOG) as [
    CatalogSkillFamilyId,
    SkillFamilyMeta,
  ][]) {
    for (const icao of meta.members) {
      map.set(icao.toUpperCase(), familyId);
    }
  }
  return map;
})();

/**
 * Резолв family_id по ICAO рейса (канон T180 §4.2):
 * - известный сид → catalog slug
 * - NULL / ZZZZ → `unknown`
 * - иначе singleton `icao:XXXX`
 */
export function resolveSkillFamilyId(aircraftIcao: string | null | undefined): string {
  if (aircraftIcao == null || aircraftIcao.trim() === '') return 'unknown';
  const icao = aircraftIcao.trim().toUpperCase();
  if (icao === 'ZZZZ') return 'unknown';
  const catalog = ICAO_TO_FAMILY.get(icao);
  if (catalog) return catalog;
  return `icao:${icao}`;
}

export function skillFamilyTitles(familyId: string): { title_en: string; title_ru: string } {
  if (familyId in SKILL_FAMILY_CATALOG) {
    const meta = SKILL_FAMILY_CATALOG[familyId as CatalogSkillFamilyId];
    return { title_en: meta.title_en, title_ru: meta.title_ru };
  }
  if (familyId.startsWith('icao:')) {
    const icao = familyId.slice('icao:'.length);
    return { title_en: icao, title_ru: icao };
  }
  return { title_en: familyId, title_ru: familyId };
}
