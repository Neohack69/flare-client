import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Долгоживущие токены устройства (api.md §2.3). */
export interface StoredTokens {
  access_token: string;
  device_token: string;
  device_id: string;
  /** ISO 8601 UTC; необязательно (access-токен обновляется через refresh). */
  access_expires_at?: string;
}

export interface TokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

function isStoredTokens(value: unknown): value is StoredTokens {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.access_token === 'string' &&
    typeof record.device_token === 'string' &&
    typeof record.device_id === 'string'
  );
}

/**
 * Хранилище device-токена в локальном файле с правами `0600` и атомарной
 * записью (temp + rename). На Windows режим файла не гарантируется ОС —
 * Electron может подставить `safeStorage`/DPAPI через тот же интерфейс.
 */
export class FileTokenStore implements TokenStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<StoredTokens | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return isStoredTokens(parsed) ? parsed : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(tokens), { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, this.filePath);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}

export class MemoryTokenStore implements TokenStore {
  private tokens: StoredTokens | null;

  constructor(initial: StoredTokens | null = null) {
    this.tokens = initial;
  }

  async load(): Promise<StoredTokens | null> {
    return this.tokens;
  }

  async save(tokens: StoredTokens): Promise<void> {
    this.tokens = tokens;
  }

  async clear(): Promise<void> {
    this.tokens = null;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}
