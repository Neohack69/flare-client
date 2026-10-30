import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { StoredTokens, TokenStore } from '@flightlog/agent';
import { storedTokensSchema } from '@flightlog/contracts';
import { safeStorage } from 'electron';

export class TokenEncryptionUnavailableError extends Error {
  constructor() {
    super(
      'Windows protected storage (safeStorage/DPAPI) is unavailable; refusing to write tokens in plaintext',
    );
    this.name = 'TokenEncryptionUnavailableError';
  }
}

/**
 * Device-токен в шифрованном виде через `safeStorage` (DPAPI на Windows) — R4/ADR-0011 §5.
 * Fail-closed: если шифрование недоступно, токен **не** пишется в открытый файл.
 * Dev-опт-ин на plaintext (только явной переменной) — с громким предупреждением.
 */
export class SafeStorageTokenStore implements TokenStore {
  constructor(
    private readonly filePath: string,
    private readonly allowPlaintextFallback = false,
    private readonly onWarn?: (message: string) => void,
  ) {}

  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  allowsPlaintext(): boolean {
    return this.allowPlaintextFallback;
  }

  private canWritePlaintext(): boolean {
    return this.allowPlaintextFallback && !safeStorage.isEncryptionAvailable();
  }

  async load(): Promise<StoredTokens | null> {
    let raw: Buffer;
    try {
      raw = await readFile(this.filePath);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
    if (raw.length === 0) return null;

    let json: string | null = null;
    if (safeStorage.isEncryptionAvailable()) {
      try {
        json = safeStorage.decryptString(raw);
      } catch {
        json = null;
      }
    } else if (this.canWritePlaintext()) {
      json = raw.toString('utf8');
    }
    if (json === null) return null;

    try {
      const parsed = storedTokensSchema.safeParse(JSON.parse(json));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    const json = JSON.stringify(tokens);
    let payload: Buffer;
    if (safeStorage.isEncryptionAvailable()) {
      payload = safeStorage.encryptString(json);
    } else if (this.canWritePlaintext()) {
      this.onWarn?.('safeStorage unavailable: writing device token as PLAINTEXT (dev fallback)');
      payload = Buffer.from(json, 'utf8');
    } else {
      throw new TokenEncryptionUnavailableError();
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, payload, { mode: 0o600 });
    await rename(tempPath, this.filePath);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
