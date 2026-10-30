import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeAtcText } from './aircraft-icao.js';

/**
 * Робастный источник `aircraft_icao` (T-ICAO-BCS3): `icao_type_designator`
 * из `aircraft.cfg` загруженного ВС. Симулятор грузит пресет аддона, поэтому
 * `ATC TYPE`/`ATC MODEL` могут содержать невалидные значения (например,
 * `atc_type="223"` у Synaptic A220), а корректный ICAO лежит в
 * `icao_type_designator`.
 *
 * Локализация: `TITLE`/`ATC MODEL` из сима сопоставляются с `title`/`ui_type`/
 * `atc_model` найденных `aircraft.cfg` (скан Community-каталогов). Индекс
 * строится лениво и кэшируется на процесс.
 */

/** Нужные поля одного `aircraft.cfg`. */
export interface AircraftCfgFields {
  title: string | null;
  uiType: string | null;
  atcModel: string | null;
  atcType: string | null;
  icaoTypeDesignator: string | null;
}

export interface AircraftCfgEntry extends AircraftCfgFields {
  path: string;
}

/** Запрос локализации: значения из сима. */
export interface AircraftCfgQuery {
  title?: string | null;
  atcModel?: string | null;
}

/** Функция-резолвер `icao_type_designator` для `FlightRecorder`. */
export type IcaoTypeDesignatorLookup = (query: AircraftCfgQuery) => string | null;

/** Виртуальная ФС индекса (подменяется в тестах). */
export interface AircraftCfgVirtualFs {
  /** `null`, если каталога нет/недоступен. */
  listDir(dir: string): ReadonlyArray<{ name: string; isDirectory: boolean }> | null;
  readFile(file: string): string;
}

export interface AircraftCfgIndexOptions {
  roots?: readonly string[];
  fs?: AircraftCfgVirtualFs;
  maxFiles?: number;
  maxDepth?: number;
  /** Построить индекс синхронно (тесты/диагностика). */
  eager?: boolean;
}

export interface AircraftCfgIndex {
  readonly size: number;
  readonly ready: boolean;
  /** Запустить фоновое построение, если ещё не запущено. */
  ensureBuilt(): void;
  /** Построить синхронно (идемпотентно). */
  build(): void;
  lookup(query: AircraftCfgQuery): string | null;
}

/**
 * Устойчивый парсер `aircraft.cfg` → `key=value` (ключи в нижнем регистре).
 * Поддерживает `key = value` / `key=value`, кавычки/без, инлайн-комментарии
 * `;` вне кавычек, любой регистр ключей (`Title` и `title`). Первое непустое
 * значение ключа выигрывает (секции не различаем — нужные ключи уникальны).
 */
export function parseAircraftCfg(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = stripCfgComment(rawLine);
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    if (!key) continue;
    const value = unquote(line.slice(eq + 1).trim());
    if (!value || fields[key] !== undefined) continue;
    fields[key] = value;
  }
  return fields;
}

export function toAircraftCfgFields(fields: Record<string, string>): AircraftCfgFields {
  return {
    title: fields['title'] ?? null,
    uiType: fields['ui_type'] ?? null,
    atcModel: fields['atc_model'] ?? null,
    atcType: fields['atc_type'] ?? null,
    icaoTypeDesignator: fields['icao_type_designator'] ?? null,
  };
}

/** Сопоставление по нормализованным `title`/`ui_type`/`atc_model`. */
const MATCH_KEYS: ReadonlyArray<keyof AircraftCfgFields> = ['title', 'uiType', 'atcModel'];

/**
 * Служебные токены названий аддонов/производителей/сборок: мешают точному
 * равенству строк, но не несут информации о модели (R5.8). Сравниваем только
 * «модельные» токены (например, `777-200LR`, `A220-300`).
 */
const MATCH_NOISE = new Set([
  'PMDG',
  'ASOBO',
  'AEROSOFT',
  'INIBUILDS',
  'SYNAPTIC',
  'FLIGHTSIM',
  'FLIGHT',
  'SIM',
  'SIMULATIONS',
  'SIMULATION',
  'STUDIO',
  'STUDIOS',
  'MSFS',
  'MSFS2020',
  'MSFS2024',
  'LIVERIES',
  'LIVERY',
  'PACK',
  'BOEING',
  'AIRBUS',
  'MCDONNELL',
  'DOUGLAS',
  'BOMBARDIER',
  'EMBRAER',
  'CESSNA',
  'BEECHCRAFT',
  'PIPER',
  'DIAMOND',
  'CIRRUS',
  'ATR',
  'ROBINSON',
  'BELL',
  'HAVILLAND',
  'CANADA',
  'GULFSTREAM',
  'ICON',
  'TBM',
]);

/** Значимые («модельные») токены нормализованной строки без служебного шума. */
function significantTokens(value: string): string[] {
  return value
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Z0-9-]/g, ''))
    .filter((token) => token.length >= 2 && !MATCH_NOISE.has(token));
}

/**
 * Мягкое совпадение: набор значимых токенов одной строки целиком входит в
 * набор другой. Устойчиво к префиксам/суффиксам аддонов («PMDG 777-200LR» ↔
 * «777-200LR»), но не путает разные варианты (`777-200` ≠ `777-200LR`).
 */
function sharesModelTokens(a: string, b: string): boolean {
  const tokensA = significantTokens(a);
  const tokensB = significantTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  const longerSet = new Set(longer);
  return shorter.every((token) => longerSet.has(token));
}

/**
 * Первая запись с `icao_type_designator`, у которой `title`/`ui_type`/`atc_model`
 * совпадает с `title`/`atc_model` из сима. Сначала точное равенство (приоритет),
 * затем мягкое совпадение по значимым токенам (R5.8: длинные title аддонов вроде
 * «PMDG 777-200LR» не совпадали с `ui_type`/`atc_model` буквально).
 */
export function matchAircraftCfgEntry(
  entries: readonly AircraftCfgEntry[],
  query: AircraftCfgQuery,
): AircraftCfgEntry | null {
  const targets = [normalizeAtcText(query.title), normalizeAtcText(query.atcModel)].filter(
    (value) => value.length > 0,
  );
  if (targets.length === 0) return null;

  for (const entry of entries) {
    if (!entry.icaoTypeDesignator) continue;
    for (const key of MATCH_KEYS) {
      const candidate = normalizeAtcText(entry[key]);
      if (candidate.length > 0 && targets.includes(candidate)) return entry;
    }
  }

  for (const entry of entries) {
    if (!entry.icaoTypeDesignator) continue;
    for (const key of MATCH_KEYS) {
      const candidate = normalizeAtcText(entry[key]);
      if (candidate.length > 0 && targets.some((target) => sharesModelTokens(candidate, target))) {
        return entry;
      }
    }
  }
  return null;
}

export function createAircraftCfgIndex(options: AircraftCfgIndexOptions = {}): AircraftCfgIndex {
  const fs = options.fs ?? nodeFs;
  const roots = options.roots ?? discoverCommunityRoots();
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  let entries: AircraftCfgEntry[] | null = null;
  let building = false;
  const cache = new Map<string, string | null>();

  const build = (): void => {
    if (entries) return;
    entries = scanAircraftCfg(roots, fs, maxFiles, maxDepth);
    cache.clear();
  };

  const ensureBuilt = (): void => {
    if (entries || building) return;
    building = true;
    setImmediate(() => {
      try {
        build();
      } finally {
        building = false;
      }
    });
  };

  const lookup = (query: AircraftCfgQuery): string | null => {
    if (!entries) {
      ensureBuilt();
      return null;
    }
    const key = `${normalizeAtcText(query.title)}\u0000${normalizeAtcText(query.atcModel)}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    const result = matchAircraftCfgEntry(entries, query)?.icaoTypeDesignator ?? null;
    cache.set(key, result);
    return result;
  };

  if (options.eager) build();

  return {
    get size() {
      return entries?.length ?? 0;
    },
    get ready() {
      return entries !== null;
    },
    ensureBuilt,
    build,
    lookup,
  };
}

let defaultIndex: AircraftCfgIndex | null = null;

export function getDefaultAircraftCfgIndex(): AircraftCfgIndex {
  defaultIndex ??= createAircraftCfgIndex();
  return defaultIndex;
}

/** Дефолтный резолвер для production-сборки агента (`bootstrapAgent`). */
export function defaultIcaoTypeDesignatorLookup(query: AircraftCfgQuery): string | null {
  return getDefaultAircraftCfgIndex().lookup(query);
}

/**
 * Каталоги Community по умолчанию. Приоритет — env-переопределение
 * (`MSFS2024_COMMUNITY_DIR`, `;`-разделённый), затем `Community*` под
 * `D:\MSFS2024_Addons` / MSFS-root, затем стандартные `%APPDATA%`/`%LOCALAPPDATA%`.
 */
export function discoverCommunityRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = new Set<string>();
  const override = env.MSFS2024_COMMUNITY_DIR ?? env.MSFS_COMMUNITY_DIR;
  if (override) {
    for (const part of override.split(';')) {
      const trimmed = part.trim();
      if (trimmed) roots.add(trimmed);
    }
  }

  const addonsRoot = env.MSFS2024_ADDONS_DIR ?? 'D:\\MSFS2024_Addons';
  addCommunityRoots(roots, addonsRoot);

  for (const msfsRoot of [env.MSFS2024_ROOT, env.MSFS_ROOT]) {
    if (msfsRoot) addCommunityRoots(roots, join(msfsRoot, 'Packages'));
  }

  if (env.APPDATA) {
    roots.add(join(env.APPDATA, 'Microsoft Flight Simulator', 'Packages', 'Community'));
  }
  if (env.LOCALAPPDATA) {
    roots.add(
      join(
        env.LOCALAPPDATA,
        'Packages',
        'Microsoft.FlightSimulator_8wekyb3d8bbwe',
        'LocalCache',
        'Packages',
        'Community',
      ),
    );
  }
  return [...roots];
}

const DEFAULT_MAX_FILES = 20000;
const DEFAULT_MAX_DEPTH = 12;

const nodeFs: AircraftCfgVirtualFs = {
  listDir(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    } catch {
      return null;
    }
  },
  readFile(file) {
    return readFileSync(file, 'utf8');
  },
};

/** Развернуть `Community*`-каталоги под `parent` (напр. `Community` и `Community2024`). */
function addCommunityRoots(roots: Set<string>, parent: string): void {
  if (!parent) return;
  roots.add(join(parent, 'Community'));
  const listing = nodeFs.listDir(parent);
  if (!listing) return;
  for (const entry of listing) {
    if (entry.isDirectory && /^community/i.test(entry.name)) {
      roots.add(join(parent, entry.name));
    }
  }
}

function scanAircraftCfg(
  roots: readonly string[],
  fs: AircraftCfgVirtualFs,
  maxFiles: number,
  maxDepth: number,
): AircraftCfgEntry[] {
  const entries: AircraftCfgEntry[] = [];
  const seenRoots = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    if (entries.length >= maxFiles || depth > maxDepth) return;
    const listing = fs.listDir(dir);
    if (!listing) return;
    for (const item of listing) {
      if (entries.length >= maxFiles) return;
      const full = join(dir, item.name);
      if (item.isDirectory) {
        walk(full, depth + 1);
        continue;
      }
      if (item.name.toLowerCase() !== 'aircraft.cfg') continue;
      try {
        const fields = toAircraftCfgFields(parseAircraftCfg(fs.readFile(full)));
        if (!fields.icaoTypeDesignator) continue;
        entries.push({ path: full, ...fields });
      } catch {
        // Нечитаемый cfg не должен ломать построение индекса.
      }
    }
  };

  for (const root of roots) {
    if (!root || seenRoots.has(root)) continue;
    seenRoots.add(root);
    walk(root, 0);
  }
  return entries;
}

function stripCfgComment(line: string): string {
  let inQuote = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') inQuote = !inQuote;
    else if (char === ';' && !inQuote) return line.slice(0, index);
  }
  return line;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).trim();
  }
  return value;
}
