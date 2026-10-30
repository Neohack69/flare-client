import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Происхождение источника телеметрии (api.md §3.3.3, CD-6.1). Поля
 * информационные: сервер никогда не гейтит приём по ним; агент шлёт их, чтобы
 * `devices.source`/`agent_version` и `flights.stats` заполнялись.
 */
export const DEFAULT_AGENT_SOURCE = 'agent';

const FALLBACK_VERSION = '0.0.0';

let cachedVersion: string | null = null;

/**
 * Версия пакета агента из ближайшего `package.json` — дефолт для `AGENT_VERSION`
 * (CD-6.1). Читается один раз; при недоступности файла — `0.0.0`.
 */
export function packageVersion(): string {
  if (cachedVersion === null) cachedVersion = readPackageVersion() ?? FALLBACK_VERSION;
  return cachedVersion;
}

function readPackageVersion(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    if (typeof manifest.version !== 'string') return null;
    const version = manifest.version.trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

export interface AgentProvenance {
  source: string;
  version: string;
}

export interface ResolveProvenanceInput {
  /** Явный источник (конфиг); иначе env `AGENT_SOURCE`, иначе `agent`. */
  source?: string | null;
  /** Явная версия (конфиг); иначе env `AGENT_VERSION`, иначе `package.json`. */
  version?: string | null;
  env?: Record<string, string | undefined>;
}

/** Итоговое происхождение агента: конфиг → env → безопасный дефолт. */
export function resolveProvenance(input: ResolveProvenanceInput = {}): AgentProvenance {
  const env = input.env ?? process.env;
  return {
    source: firstNonEmpty(input.source, env.AGENT_SOURCE, DEFAULT_AGENT_SOURCE),
    version: firstNonEmpty(input.version, env.AGENT_VERSION, packageVersion()),
  };
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}
