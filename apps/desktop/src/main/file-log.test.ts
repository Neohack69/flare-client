import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFileLog, formatLogLine } from './file-log';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flightlog-file-log-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('formatLogLine', () => {
  it('пишет timestamp, level и meta', () => {
    const line = formatLogLine('info', 'agent starting', { protocol: 'sunrise' });
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(line).toContain('INFO');
    expect(line).toContain('agent starting');
    expect(line).toContain('{"protocol":"sunrise"}');
  });

  it('без meta добавляет только заголовок', () => {
    expect(formatLogLine('warn', 'simulator not available')).toMatch(
      /\d{4}-\d{2}-\d{2}T.*WARN\s+simulator not available$/,
    );
  });
});

describe('createFileLog', () => {
  it('создаёт каталог, пишет строки и добавляет перевод строки', () => {
    const dir = tempDir();
    const file = join(dir, 'agent', 'client.log');
    const sink = createFileLog(file);
    expect(sink).not.toBeNull();
    sink?.write('first');
    sink?.write('second\n');
    expect(readFileSync(file, 'utf8')).toBe('first\nsecond\n');
    expect(sink?.path).toBe(file);
  });

  it('ротирует файл при превышении лимита (в т.ч. повторно, перезаписывая .1)', () => {
    const dir = tempDir();
    const file = join(dir, 'client.log');
    writeFileSync(file, 'x'.repeat(32), 'utf8');
    const sink = createFileLog(file, { maxBytes: 16 });
    sink?.write('after');
    expect(statSync(`${file}.1`).size).toBe(32);
    expect(readFileSync(file, 'utf8')).toBe('after\n');

    sink?.write('y'.repeat(32));
    sink?.write('z');
    expect(readFileSync(file, 'utf8')).toBe('z\n');
    expect(statSync(`${file}.1`).size).toBe(('after\n' + 'y'.repeat(32) + '\n').length);
  });

  it('ошибка записи отключает sink и не бросает', () => {
    const dir = tempDir();
    const badPath = join(dir, 'as-directory');
    // Путь занят каталогом — appendFileSync не сможет открыть файл.
    mkdirSync(badPath, { recursive: true });
    const errors: string[] = [];
    const sink = createFileLog(badPath, { onError: (message) => errors.push(message) });
    expect(() => sink?.write('line')).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
  });
});
