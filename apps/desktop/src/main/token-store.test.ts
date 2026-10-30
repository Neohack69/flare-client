import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
}));

vi.mock('electron', () => ({ safeStorage }));

import type { StoredTokens } from '@flightlog/agent';

import { SafeStorageTokenStore, TokenEncryptionUnavailableError } from './token-store';

const tokens: StoredTokens = {
  access_token: 'access',
  device_token: 'device',
  device_id: '123e4567-e89b-42d3-a456-426614174000',
};

function tempFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'flightlog-tokens-'));
  return { dir, file: join(dir, 'agent', 'tokens.enc') };
}

describe('SafeStorageTokenStore (R4 / ADR-0011 §5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('шифрует и расшифровывает токен при доступном safeStorage', async () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(true);
    safeStorage.encryptString.mockImplementation((value: string) =>
      Buffer.from(`cipher:${Buffer.from(value, 'utf8').toString('base64')}`),
    );
    safeStorage.decryptString.mockImplementation((buffer: Buffer) =>
      Buffer.from(buffer.toString('utf8').replace(/^cipher:/, ''), 'base64').toString('utf8'),
    );

    const { dir, file } = tempFile();
    try {
      const store = new SafeStorageTokenStore(file);
      await store.save(tokens);
      const onDisk = readFileSync(file, 'utf8');
      expect(onDisk.startsWith('cipher:')).toBe(true);
      expect(onDisk).not.toContain('device_token');
      await expect(store.load()).resolves.toEqual(tokens);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fail-closed: без шифрования и без опт-ина save отклоняется, load → null', async () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const { dir, file } = tempFile();
    try {
      const store = new SafeStorageTokenStore(file);
      await expect(store.save(tokens)).rejects.toBeInstanceOf(TokenEncryptionUnavailableError);
      await expect(store.load()).resolves.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dev-опт-ин: plaintext-fallback работает с предупреждением', async () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const onWarn = vi.fn();
    const { dir, file } = tempFile();
    try {
      const store = new SafeStorageTokenStore(file, true, onWarn);
      await store.save(tokens);
      await expect(store.load()).resolves.toEqual(tokens);
      expect(onWarn).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clear удаляет файл, load на отсутствующем файле → null', async () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(true);
    const { dir, file } = tempFile();
    try {
      const store = new SafeStorageTokenStore(file);
      await store.clear();
      await expect(store.load()).resolves.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
