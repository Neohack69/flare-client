import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { machineIdSchema } from '@flightlog/contracts';

/**
 * Локальный `machine_id` (ADR-0018 §5, CD-6.2): случайные 128 бит, opaque
 * url-safe. Хранится **отдельно** от токенов (`auth.json`/safeStorage), сырое
 * значение никогда не логируется — на сервер уходит заголовком
 * `X-TD-Machine-Id`, сервер хранит только `sha256`.
 *
 * Источники (по приоритету): env `FLIGHTLOG_MACHINE_ID` → файл
 * `FLIGHTLOG_MACHINE_ID_FILE` (создаётся один раз, 0600). Нет ни того, ни
 * другого — legacy-режим (`null`, без заголовка/поля).
 */
export interface ResolveMachineIdOptions {
  env?: Record<string, string | undefined>;
  /** Явный путь к файлу; иначе `FLIGHTLOG_MACHINE_ID_FILE`. */
  filePath?: string | null;
  /** Создавать файл при отсутствии (по умолчанию `true`). */
  create?: boolean;
}

/** 128-бит в base64url (22 url-safe символа). */
export function generateMachineId(): string {
  return randomBytes(16).toString('base64url');
}

/** Валидирует opaque-идентификатор (`machineIdSchema`); мусор → `null`. */
export function parseMachineId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = machineIdSchema.safeParse(value.trim());
  return parsed.success ? parsed.data : null;
}

export function resolveMachineId(options: ResolveMachineIdOptions = {}): string | null {
  const env = options.env ?? process.env;
  const direct = parseMachineId(env.FLIGHTLOG_MACHINE_ID);
  if (direct) return direct;

  const filePath = options.filePath ?? env.FLIGHTLOG_MACHINE_ID_FILE;
  if (typeof filePath !== 'string' || filePath.trim().length === 0) return null;
  return readOrCreateMachineIdFile(filePath.trim(), options.create ?? true);
}

/** Читает `machine_id` из файла; при `create` — генерирует и сохраняет один раз. */
export function readOrCreateMachineIdFile(filePath: string, create = true): string | null {
  const existing = readMachineIdFile(filePath);
  if (existing) return existing;
  if (!create) return null;

  const generated = generateMachineId();
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, generated, { encoding: 'utf8', mode: 0o600 });
  } catch {
    return null;
  }
  return readMachineIdFile(filePath) ?? generated;
}

function readMachineIdFile(filePath: string): string | null {
  try {
    return parseMachineId(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}
