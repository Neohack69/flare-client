import { aircraftDictionaryArtifactSchema, AIRCRAFT_MODEL_SEED, normalizeAircraftModelText } from '@flightlog/contracts';

import { AIRCRAFT_DB_VERSION, ATC_MODEL_TO_ICAO, setAircraftDictionary } from './aircraft-icao.js';

/** Публичный артефакт словаря (T-D §6.4), публикуется как статика. */
export const DEFAULT_AIRCRAFT_DICT_URL = 'https://flyflare.ru/aircraft/icao-dict.json';
/** Таймаут best-effort загрузки: офлайн/медленно → встроенный словарь. */
export const DEFAULT_AIRCRAFT_DICT_TIMEOUT_MS = 3_000;

export interface LoadAircraftDictionaryOptions {
  url?: string;
  timeoutMs?: number;
  /** Инъекция fetch для тестов; по умолчанию `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface AircraftDictionaryLoadResult {
  /** `true` — артефакт получен и применён; `false` — остался встроенный словарь. */
  ok: boolean;
  source: 'remote' | 'embedded';
  version: string | null;
  /** Число пар в активном словаре после загрузки (seed ∪ learned). */
  pairs: number;
  effectiveVersion: string;
  error?: string;
}

/**
 * Сливает пары артефакта со встроенным seed (learned перекрывает seed),
 * нормализуя ключи тем же правилом, что сервер (`normalizeAircraftModelText`).
 * Чистая функция — тестируется без сети.
 */
export function buildAircraftDictionary(
  artifactPairs: Readonly<Record<string, string>> | null | undefined,
  seed: Readonly<Record<string, string>> = AIRCRAFT_MODEL_SEED,
): Record<string, string> {
  const merged: Record<string, string> = { ...seed };
  for (const [rawKey, icao] of Object.entries(artifactPairs ?? {})) {
    const key = normalizeAircraftModelText(rawKey);
    if (key.length > 0) merged[key] = icao;
  }
  return merged;
}

/**
 * Best-effort загрузка артефакта словаря на старте агента (T-D §6.4): таймаут,
 * офлайн, HTTP-ошибка или невалидный артефакт → встроенный словарь, без
 * исключений (офлайн-контракт агента не ломается). Успешный артефакт
 * применяется через {@link setAircraftDictionary}.
 */
export async function loadAircraftDictionary(
  options: LoadAircraftDictionaryOptions = {},
): Promise<AircraftDictionaryLoadResult> {
  const url = options.url ?? process.env.AIRCRAFT_DICT_URL ?? DEFAULT_AIRCRAFT_DICT_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AIRCRAFT_DICT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const embeddedPairs = Object.keys(ATC_MODEL_TO_ICAO).length;

  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      source: 'embedded',
      version: null,
      pairs: embeddedPairs,
      effectiveVersion: AIRCRAFT_DB_VERSION,
      error: 'fetch unavailable',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = aircraftDictionaryArtifactSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('invalid dictionary artifact');

    const merged = buildAircraftDictionary(parsed.data.pairs);
    setAircraftDictionary(merged);
    return {
      ok: true,
      source: 'remote',
      version: parsed.data.version,
      pairs: Object.keys(merged).length,
      effectiveVersion: parsed.data.version,
    };
  } catch (error) {
    return {
      ok: false,
      source: 'embedded',
      version: null,
      pairs: embeddedPairs,
      effectiveVersion: AIRCRAFT_DB_VERSION,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
