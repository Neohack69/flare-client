import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** Ротация: файл больше 5 МиБ переименовывается в `<path>.1`, затем пишется заново. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface FileLogSink {
  readonly path: string;
  write(line: string): void;
}

export interface CreateFileLogOptions {
  maxBytes?: number;
  onError?: (message: string, error: unknown) => void;
}

function stringifyMeta(meta: unknown): string {
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

/** `2026-09-26T00:00:00.000Z INFO  agent starting {...}` — стабильный формат для grep. */
export function formatLogLine(level: string, message: string, meta?: unknown): string {
  const head = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  return meta === undefined ? head : `${head} ${stringifyMeta(meta)}`;
}

/**
 * T123: файловый лог main-процесса. Нужен трей-приложению без окна/консоли:
 * статусы и ошибки agent-host должны переживать закрытие терминала. Пишем
 * синхронным append (частота низкая), ошибки записи не роняют приложение.
 */
export function createFileLog(
  filePath: string,
  options: CreateFileLogOptions = {},
): FileLogSink | null {
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch (error) {
    options.onError?.(`cannot create log directory for ${filePath}`, error);
    return null;
  }

  let disabled = false;

  const rotateIfNeeded = (): void => {
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      return;
    }
    if (size < maxBytes) return;
    const rotated = `${filePath}.1`;
    try {
      // Windows rename не перезаписывает существующий `.1` — убираем явно.
      rmSync(rotated, { force: true });
      renameSync(filePath, rotated);
    } catch (error) {
      options.onError?.(`cannot rotate log file ${filePath}`, error);
    }
  };

  return {
    path: filePath,
    write(line: string): void {
      if (disabled) return;
      const text = line.endsWith('\n') ? line : `${line}\n`;
      try {
        rotateIfNeeded();
        appendFileSync(filePath, text, 'utf8');
      } catch (error) {
        disabled = true;
        options.onError?.(`cannot write log file ${filePath}`, error);
      }
    },
  };
}
