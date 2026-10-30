import {
  aircraftIcaoSchema,
  AIRCRAFT_MODEL_SEED,
  AIRCRAFT_MODEL_SOURCE_MAX,
  canonicalAircraftIcao,
  normalizeAircraftModelText,
} from '@flightlog/contracts';

/** Версия локального справочника маппинга (ADR-0008: для переобработки). */
export const AIRCRAFT_DB_VERSION = '2026.10.12';

export const UNKNOWN_AIRCRAFT_ICAO = 'ZZZZ';

/**
 * Источник `aircraft_icao` (ADR-0008 §4):
 * - `atc_type` — валидный ICAO из `ATC TYPE`;
 * - `aircraft_cfg` — `icao_type_designator` из `aircraft.cfg` загруженного ВС
 *   (T-ICAO-BCS3: пресеты аддонов задают невалидный `ATC TYPE`/`ATC MODEL`);
 * - `title` — точное совпадение `TITLE`/`ATC MODEL`/`ATC TYPE` со справочником;
 * - `heuristic` — эвристический разбор `TITLE`/`ATC MODEL`;
 * - `config` — тип задан конфигом/пользователем (переопределяет сим);
 * - `unknown` — не распознано → `ZZZZ`.
 */
export type AircraftIcaoSource =
  'atc_type' | 'aircraft_cfg' | 'title' | 'heuristic' | 'config' | 'unknown';

export interface ResolvedAircraftIcao {
  icao: string;
  source: AircraftIcaoSource;
}

/**
 * ICAO type designator: 2–4 символа и **минимум одна буква**. Все реальные
 * designators (Doc 8643) содержат букву, а числовой мусор из `ATC TYPE`
 * (`"223"` у пресета A220) валидным считаться не должен.
 */
const ICAO_RE = /^(?=.*[A-Z])[A-Z0-9]{2,4}$/;

/**
 * Локальный справочник `TITLE/ATC MODEL → ICAO` (нормализованные строки).
 * Не претендует на полноту: при отсутствии совпадения работает эвристика
 * (`HEURISTIC_RULES`), затем `ZZZZ`/`unknown` (ADR-0008).
 *
 * Источник данных — `AIRCRAFT_MODEL_SEED` из `@flightlog/contracts` (единый с
 * серверным генератором артефакта `icao-dict.json`, T-D §5.4/§6.4).
 */
export const ATC_MODEL_TO_ICAO: Readonly<Record<string, string>> = AIRCRAFT_MODEL_SEED;

/**
 * Загруженный из артефакта словарь (seed ∪ learned), либо `null` — тогда
 * используется только встроенный `ATC_MODEL_TO_ICAO` (T-D §6.4). Best-effort:
 * таймаут/офлайн оставляют встроенный словарь.
 */
let activeDictionary: Readonly<Record<string, string>> | null = null;

/**
 * Применяет загруженный артефакт словаря поверх встроенного (learned перекрывает
 * seed). `null` — сбросить к встроенному. Синхронно; вызывается после
 * {@link loadAircraftDictionary}.
 */
export function setAircraftDictionary(
  pairs: Readonly<Record<string, string>> | null | undefined,
): void {
  activeDictionary =
    pairs && Object.keys(pairs).length > 0 ? { ...ATC_MODEL_TO_ICAO, ...pairs } : null;
}

/** Активный словарь: загруженный (seed ∪ learned) или встроенный seed. */
export function getAircraftDictionary(): Readonly<Record<string, string>> {
  return activeDictionary ?? ATC_MODEL_TO_ICAO;
}

/**
 * Семейные designators, у которых в Doc 8643 есть варианты. X-Plane отдаёт в
 * `acf_ICAO` семейный код (`A320`), а точную модификацию — только в описании
 * (`acf_descrip` → `A320neo`). Поэтому для семейного `ATC MODEL` title имеет
 * право уточнить вариант; точный designator из сима (`A20N`) не переопределяется.
 */
const FAMILY_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  A319: ['A319', 'A19N'],
  A320: ['A320', 'A20N'],
  A321: ['A321', 'A21N'],
};

/**
 * Порядок правил критичен: первое совпадение выигрывает, поэтому более
 * специфичные варианты (`737 MAX 8`, `747-8`) идут раньше общих (`737`, `747`).
 * `TITLE` у аддонов часто содержит мусор/префиксы — правило ищет подстроку.
 */
const HEURISTIC_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Airbus
  [/A380/, 'A388'],
  [/A350[- ]?900/, 'A359'],
  [/A350/, 'A359'],
  [/A330[- ]?300/, 'A333'],
  [/A330/, 'A333'],
  [/A321[- ]?NEO|A21N/, 'A21N'],
  [/A320[- ]?NEO|A20N/, 'A20N'],
  [/A319[- ]?NEO|A19N/, 'A19N'],
  [/A220[- ]?300|BCS3/, 'BCS3'],
  [/A220/, 'BCS3'],
  [/A321/, 'A321'],
  [/A320/, 'A320'],
  [/A319/, 'A319'],
  [/A318/, 'A318'],
  // Boeing
  [/737[- ]?MAX[- ]?8|737[- ]?8[- ]?MAX|B38M/, 'B38M'],
  [/737[- ]?900/, 'B739'],
  [/737[- ]?800/, 'B738'],
  [/737[- ]?700/, 'B737'],
  [/737/, 'B738'],
  [/747[- ]?8(?![0-9])/, 'B748'],
  [/747[- ]?400/, 'B744'],
  [/747/, 'B744'],
  [/757[- ]?300/, 'B753'],
  [/757[- ]?200/, 'B752'],
  [/757/, 'B752'],
  [/767[- ]?300/, 'B763'],
  [/767/, 'B763'],
  // Boeing 777 family (R5.8): варианты различаются по суффиксу, порядок —
  // от специфичных к общим. 777-200LR/777F (PMDG-класс) раньше падали в B77W.
  [/777[- ]?200[- ]?LR|B77L/, 'B77L'],
  [/777[- ]?200[- ]?ER|777[- ]?200|B772/, 'B772'],
  [/777[- ]?300[- ]?ER|B77W/, 'B77W'],
  [/777[- ]?8(?![0-9])|B778/, 'B778'],
  [/777[- ]?9(?![0-9])|B779/, 'B779'],
  [/777[- ]?300|B773/, 'B773'],
  [/777[- ]?F|FREIGHTER|FREIGHT|B77F/, 'B77L'],
  [/777/, 'B77W'],
  [/787[- ]?10|B78X/, 'B78X'],
  [/787[- ]?9/, 'B789'],
  [/787[- ]?8/, 'B788'],
  [/787/, 'B789'],
  // McDonnell Douglas
  [/MD[- ]?11/, 'MD11'],
  [/MD[- ]?82/, 'MD82'],
  [/MD[- ]?80/, 'MD80'],
  [/MD[- ]?8[0-9]/, 'MD80'],
  // Embraer
  [/EMBRAER[- ]?195|E[- ]?195/, 'E195'],
  [/EMBRAER[- ]?190|E[- ]?190/, 'E190'],
  [/EMBRAER[- ]?175|E[- ]?175/, 'E175'],
  [/EMBRAER[- ]?170|E[- ]?170/, 'E170'],
  // Bombardier
  [/CRJ[- ]?900|CRJ[- ]?9/, 'CRJ9'],
  [/CRJ[- ]?700|CRJ[- ]?7/, 'CRJ7'],
  [/CRJ/, 'CRJ9'],
  // Turboprops
  [/ATR[- ]?72[- ]?600|ATR[- ]?76|AT76/, 'AT76'],
  [/ATR[- ]?72|AT72/, 'AT72'],
  [/ATR[- ]?42|AT45/, 'AT45'],
  [/DASH[- ]?8|DH8D|Q400/, 'DH8D'],
  [/MA[- ]?60/, 'MA60'],
  [/KING[- ]?AIR[- ]?350|B350/, 'B350'],
  [/KING[- ]?AIR[- ]?200|SUPER[- ]?KING|BE20/, 'BE20'],
  [/CARAVAN|C208/, 'C208'],
  [/PC[- ]?12/, 'PC12'],
  [/TBM[- ]?9/, 'TBM9'],
  // Bizjets
  [/CITATION[- ]?CJ4|CJ4|C25C/, 'C25C'],
  [/CITATION[- ]?(XLS|EXCEL)|C56X/, 'C56X'],
  [/PHENOM[- ]?300|E55P/, 'E55P'],
  [/G650|GLF6/, 'GLF6'],
  [/CITATION/, 'C25C'],
  // GA
  [/CESSNA[- ]?152|C152/, 'C152'],
  [/CESSNA[- ]?182|C182/, 'C182'],
  [/CESSNA[- ]?172|C172|SKYHAWK/, 'C172'],
  [/PA[- ]?28|P28A|CHEROKEE|ARCHER/, 'PA28'],
  [/SR[- ]?22/, 'SR22'],
  [/DA[- ]?40/, 'DA40'],
  [/DA[- ]?62/, 'DA62'],
  [/DHC[- ]?2|BEAVER/, 'DHC2'],
  [/ICON[- ]?A5/, 'ICON'],
  // Helicopters
  [/ROBINSON[- ]?R22|R[- ]?22/, 'R22'],
  [/BELL[- ]?407|B407/, 'B407'],
  [/AS[- ]?350|AS50|ECUREUIL/, 'AS50'],
  [/EC[- ]?145|EC45|BK[- ]?117|H[- ]?145/, 'EC45'],
  [/H[- ]?125/, 'H125'],
];

export function normalizeAtcText(value: string | null | undefined): string {
  return normalizeAircraftModelText(value);
}

/**
 * T-D §5.6/§6.1: сырая строка модели для самообучения словаря (`aircraft_model_raw`).
 * Порядок кандидатов `ATC MODEL` → `TITLE` → `ATC TYPE`: `ATC MODEL` обычно ближе
 * к типу ВС, `TITLE` — fallback для аддонов без `ATC MODEL`. Строка нормализуется
 * (`normalizeAtcText`) и обрезается до {@link AIRCRAFT_MODEL_SOURCE_MAX} (≤128),
 * чтобы пройти ingest-схему `aircraftModelSourceStringSchema`. `null` — строки нет.
 */
export function selectAircraftModelRaw(input: {
  atc_model?: string | null;
  atc_type?: string | null;
  title?: string | null;
}): string | null {
  for (const candidate of [input.atc_model, input.title, input.atc_type]) {
    const normalized = normalizeAtcText(candidate);
    if (normalized.length > 0) return normalized.slice(0, AIRCRAFT_MODEL_SOURCE_MAX);
  }
  return null;
}

function isValidIcao(value: string): boolean {
  // MSFS sometimes reports `ATC TYPE = ZZZZ` while `ATC MODEL` still has a
  // known type (e.g. `ATCCOM.AC_MODEL B77L.0.TEXT`). Never let the sentinel
  // win over a later title/model/dictionary match.
  if (value === UNKNOWN_AIRCRAFT_ICAO) return false;
  return ICAO_RE.test(value) && aircraftIcaoSchema.safeParse(value).success;
}

/** Поиск по активному словарю (seed ∪ learned) с нормализацией ключа. */
function dictionaryMatch(candidate: string): string | null {
  const mapped = getAircraftDictionary()[normalizeAircraftModelText(candidate)];
  return mapped && isValidIcao(mapped) ? mapped : null;
}

/**
 * Приоритет (ADR-0008 §4 / T84 / T-ICAO-BCS3):
 * `ATC TYPE` (валидный ICAO) → `icao_type_designator` из `aircraft.cfg` →
 * `TITLE`/`ATC MODEL`/`ATC TYPE` по справочнику → эвристический разбор
 * `TITLE`/`ATC MODEL` → `ZZZZ` (`unknown`).
 * `TITLE` проверяется раньше `ATC MODEL`: он обычно человекочитаемее.
 */
export function resolveAircraftIcao(input: {
  atc_model?: string | null;
  atc_type?: string | null;
  title?: string | null;
  /** `icao_type_designator` из `aircraft.cfg` (робастный источник, T-ICAO-BCS3). */
  icaoTypeDesignator?: string | null;
}): ResolvedAircraftIcao {
  const atcType = normalizeAtcText(input.atc_type);
  if (isValidIcao(atcType)) return { icao: canonicalAircraftIcao(atcType), source: 'atc_type' };

  const designator = normalizeAtcText(input.icaoTypeDesignator);
  if (isValidIcao(designator)) {
    return { icao: canonicalAircraftIcao(designator), source: 'aircraft_cfg' };
  }

  const title = normalizeAtcText(input.title);
  const atcModel = normalizeAtcText(input.atc_model);

  // Точный designator из сима (например, X-Plane `acf_ICAO = A20N`) сильнее
  // title: словарь/эвристика не должны «понижать» его до семейного A320.
  if (atcModel !== UNKNOWN_AIRCRAFT_ICAO && isValidIcao(atcModel)) {
    const variant = titleVariantForFamily(atcModel, title);
    if (variant) return { icao: canonicalAircraftIcao(variant), source: 'title' };
    return { icao: canonicalAircraftIcao(atcModel), source: 'title' };
  }

  const tiers = [title, atcModel, atcType];

  for (const candidate of tiers) {
    if (!candidate) continue;
    const mapped = dictionaryMatch(candidate);
    if (mapped) return { icao: canonicalAircraftIcao(mapped), source: 'title' };
    if (isValidIcao(candidate)) return { icao: canonicalAircraftIcao(candidate), source: 'title' };
  }

  for (const candidate of tiers) {
    const heuristic = heuristicFromModel(candidate);
    if (heuristic) return { icao: canonicalAircraftIcao(heuristic), source: 'heuristic' };
  }

  return { icao: UNKNOWN_AIRCRAFT_ICAO, source: 'unknown' };
}

/**
 * Уточнение семейного `ATC MODEL` по title: `A320` + `A320neo` → `A20N`.
 * Возвращает только вариант из того же семейства (иначе null — семейный код
 * остаётся как есть, без угадывания).
 */
function titleVariantForFamily(family: string, title: string): string | null {
  const variants = FAMILY_VARIANTS[family];
  if (!variants || !title) return null;
  const fromTitle = dictionaryMatch(title) ?? heuristicFromModel(title);
  if (!fromTitle) return null;
  const canonical = canonicalAircraftIcao(fromTitle);
  return canonical !== family && variants.includes(canonical) ? canonical : null;
}

/** Эвристический разбор длинной строки модели (`TITLE`/`ATC MODEL`) в ICAO. */
function heuristicFromModel(model: string): string | null {
  if (model.length === 0) return null;
  for (const [pattern, icao] of HEURISTIC_RULES) {
    if (pattern.test(model) && isValidIcao(icao)) return icao;
  }
  return null;
}
