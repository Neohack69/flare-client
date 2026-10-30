import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { machineIdSchema } from '@flightlog/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { generateMachineId, parseMachineId, resolveMachineId } from './machine-id.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flightlog-machine-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('machine-id (CD-6.2, ADR-0018 §5)', () => {
  it('generateMachineId: случайные 128 бит в url-safe алфавите', () => {
    const first = generateMachineId();
    const second = generateMachineId();
    expect(machineIdSchema.safeParse(first).success).toBe(true);
    expect(first).toHaveLength(22);
    expect(first).not.toBe(second);
  });

  it('parseMachineId отбрасывает мусор', () => {
    expect(parseMachineId('short')).toBeNull();
    expect(parseMachineId('has space here!!')).toBeNull();
    expect(parseMachineId(42)).toBeNull();
    expect(parseMachineId('abcdefghijklmnop')).toBe('abcdefghijklmnop');
  });

  it('env FLIGHTLOG_MACHINE_ID имеет приоритет (сырое значение не пишется на диск)', () => {
    const path = join(tempDir(), 'machine-id');
    const resolved = resolveMachineId({
      env: { FLIGHTLOG_MACHINE_ID: 'machine-from-env-1234', FLIGHTLOG_MACHINE_ID_FILE: path },
    });
    expect(resolved).toBe('machine-from-env-1234');
  });

  it('файл FLIGHTLOG_MACHINE_ID_FILE создаётся один раз и переиспользуется', () => {
    const path = join(tempDir(), 'nested', 'machine-id');
    const first = resolveMachineId({ env: { FLIGHTLOG_MACHINE_ID_FILE: path } });
    expect(first).not.toBeNull();
    expect(machineIdSchema.safeParse(first).success).toBe(true);
    expect(readFileSync(path, 'utf8').trim()).toBe(first);

    const second = resolveMachineId({ env: { FLIGHTLOG_MACHINE_ID_FILE: path } });
    expect(second).toBe(first);
  });

  it('без env и файла — legacy `null`; create:false не создаёт файл', () => {
    expect(resolveMachineId({ env: {} })).toBeNull();
    const path = join(tempDir(), 'machine-id');
    expect(resolveMachineId({ env: {}, filePath: path, create: false })).toBeNull();
  });

  it('некорректный env игнорируется в пользу файла', () => {
    const path = join(tempDir(), 'machine-id');
    const resolved = resolveMachineId({
      env: { FLIGHTLOG_MACHINE_ID: 'bad id!!', FLIGHTLOG_MACHINE_ID_FILE: path },
    });
    expect(resolved).not.toBeNull();
    expect(machineIdSchema.safeParse(resolved).success).toBe(true);
  });
});
