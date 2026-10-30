import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  MACHINE_ID_BYTES,
  MachineIdStore,
  generateMachineId,
  isValidMachineId,
  machineIdPath,
} from './machine-id';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'flightlog-machine-id-'));
}

describe('generateMachineId', () => {
  it('случайный 128-бит в url-safe форме', () => {
    const id = generateMachineId();
    // 16 bytes → base64url без паддинга = 22 символа.
    expect(id).toHaveLength(22);
    expect(Buffer.from(id, 'base64url')).toHaveLength(MACHINE_ID_BYTES);
    expect(isValidMachineId(id)).toBe(true);
  });

  it('значения разные', () => {
    expect(generateMachineId()).not.toBe(generateMachineId());
  });

  it('валидатор соответствует контракту (16..128, [A-Za-z0-9._~-])', () => {
    expect(isValidMachineId('a'.repeat(16))).toBe(true);
    expect(isValidMachineId('a'.repeat(128))).toBe(true);
    expect(isValidMachineId('a'.repeat(15))).toBe(false);
    expect(isValidMachineId('bad value with spaces')).toBe(false);
  });
});

describe('MachineIdStore', () => {
  it('создаёт отдельный файл machine-id (не токены/auth)', async () => {
    const dir = tempDir();
    try {
      const store = new MachineIdStore(machineIdPath(dir));
      const id = await store.getOrCreate();
      expect(store.path).toBe(join(dir, 'machine-id'));
      expect(readFileSync(store.path, 'utf8').trim()).toBe(id);
      expect(isValidMachineId(id)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('идемпотентен: повторный вызов и новый инстанс дают тот же id', async () => {
    const dir = tempDir();
    try {
      const path = machineIdPath(dir);
      const first = await new MachineIdStore(path).getOrCreate();
      const again = await new MachineIdStore(path).getOrCreate();
      const inProcess = await new MachineIdStore(path).getOrCreate();
      expect(again).toBe(first);
      expect(inProcess).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('не логирует raw-значение и предупреждает про битый файл', async () => {
    const dir = tempDir();
    try {
      const path = machineIdPath(dir);
      writeFileSync(path, 'not a valid machine id with spaces', 'utf8');
      const onWarn = vi.fn();
      const store = new MachineIdStore(path, { onWarn });
      const id = await store.getOrCreate();
      expect(onWarn).toHaveBeenCalled();
      for (const call of onWarn.mock.calls) {
        expect(String(call[0])).not.toContain(id);
      }
      expect(readFileSync(path, 'utf8').trim()).toBe(id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('при сбое записи возвращает session-id и не падает', async () => {
    const dir = tempDir();
    try {
      // Каталог-файл на пути делает mkdir/write невозможными.
      const blockedParent = join(dir, 'blocked');
      writeFileSync(blockedParent, 'not a directory', 'utf8');
      const path = join(blockedParent, 'machine-id');
      const onWarn = vi.fn();
      const store = new MachineIdStore(path, { onWarn });
      const id = await store.getOrCreate();
      expect(isValidMachineId(id)).toBe(true);
      expect(onWarn).toHaveBeenCalled();
      for (const call of onWarn.mock.calls) {
        expect(String(call[0])).not.toContain(id);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
