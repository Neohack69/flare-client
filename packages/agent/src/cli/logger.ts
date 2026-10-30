/**
 * Минимальный logger для runnable-агента (без внешних зависимостей).
 *
 * Безопасность: метаданные проходят через `redactRecord`, который вырезает
 * значения по «секретным» ключам (токены, секреты, пароли, Authorization).
 * Это не заменяет дисциплину логирования — в логи не передаём сырые ответы API.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface LogWriter {
  write(chunk: string): unknown;
}

export interface ConsoleLoggerOptions {
  level?: LogLevel;
  /** Поток для `debug`/`info` (по умолчанию `process.stdout`). */
  out?: LogWriter;
  /** Поток для `warn`/`error` (по умолчанию `process.stderr`). */
  err?: LogWriter;
  now?: () => Date;
}

const SENSITIVE_KEY =
  /(^|_)(token|secret|password|authorization)s?$|^api[_-]?key$|^apikey$|^user[_-]?code$/i;
const MAX_DEPTH = 6;

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** `AGENT_LOG_LEVEL` → `LogLevel`; неизвестное значение → `fallback`. */
export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return normalized && isLogLevel(normalized) ? normalized : fallback;
}

/** Рекурсивно вырезает значения секретных ключей (неизменяемо). */
export function redactRecord(
  meta: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactValue(value, depth + 1);
  }
  return out;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return redactRecord(value as Record<string, unknown>, depth);
  }
  return value;
}

export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const threshold = LEVEL_ORDER[level];
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const now = options.now ?? (() => new Date());

  const log = (entryLevel: Exclude<LogLevel, 'silent'>, message: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[entryLevel] < threshold) return;
    const suffix = meta ? ` ${JSON.stringify(redactRecord(meta))}` : '';
    const line = `[${now().toISOString()}] ${entryLevel.toUpperCase().padEnd(5)} ${message}${suffix}\n`;
    const writer = entryLevel === 'warn' || entryLevel === 'error' ? err : out;
    writer.write(line);
  };

  return {
    debug: (message, meta) => log('debug', message, meta),
    info: (message, meta) => log('info', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    error: (message, meta) => log('error', message, meta),
  };
}
