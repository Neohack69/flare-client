import { homedir, hostname as osHostname } from 'node:os';
import { join } from 'node:path';

import type { SimConnectProtocolName } from '../sim/node-simconnect-adapter.js';
import { resolveMachineId } from '../sync/machine-id.js';
import { DEFAULT_AGENT_SOURCE, packageVersion } from '../util/provenance.js';
import { parseLogLevel, type LogLevel } from './logger.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type AgentLogLevel = LogLevel;

/** Полная конфигурация runnable-агента (env → типизированный объект). */
export interface AgentConfig {
  apiUrl: string;
  tokenStorePath: string;
  outboxPath: string;
  clientName: string;
  platform: string;
  /** Fallback-ICAO: если задан, используется вместо `ATC MODEL/TYPE` (ADR-0008). */
  aircraftIcao: string | null;
  protocol: SimConnectProtocolName;
  maxSampleHz: number;
  syncIntervalMs: number;
  /** W1a: период `POST /v1/agent/heartbeat` (дефолт 60 с). */
  heartbeatIntervalMs?: number;
  connectPollMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  /** Таймаут финальной синхронизации при shutdown (мс); 0 — отключено. */
  shutdownFlushMs: number;
  /**
   * CD-6.1: источник телеметрии (`agent`/`electron`). Опционально, чтобы
   * desktop-клиент мог собрать конфиг без этих полей (дефолт — env/`agent`).
   */
  source?: string;
  /** CD-6.1: версия клиента (semver); дефолт — env/`package.json`. */
  version?: string;
  /** CD-6.2: локальный `machine_id` (env/файл); `null`/`undefined` — legacy. */
  machineId?: string | null;
  /** CD-3.4: retention синхронизированных строк буфера (дней). */
  bufferRetentionDays?: number;
  /** CD-3.4: порог pending-строк буфера для предупреждения. */
  bufferMaxPending?: number;
  /**
   * P2: карантин после (ре)коннекта/загрузки сима (с). Пока он не истёк,
   * рейс не стартует. Дефолт — 4 с (`AGENT_LOAD_QUARANTINE_S`).
   */
  loadQuarantineS?: number;
  logLevel: AgentLogLevel;
}

export interface LoadAgentConfigOptions {
  platform?: string;
  hostname?: string;
  homeDir?: string;
}

const DEFAULT_API_URL = 'http://localhost:3000';
const DEFAULT_PROTOCOL: SimConnectProtocolName = 'sunrise';
const PROTOCOLS: readonly SimConnectProtocolName[] = ['sunrise', 'kittyhawk', 'fsx_sp2'];
const ICAO_RE = /^[A-Z0-9]{2,4}$/;

/**
 * Читает конфигурацию из env. Бросает `ConfigError` только на явно некорректные
 * значения (операторские ошибки) — отсутствующие заменяются безопасными дефолтами.
 */
export function loadAgentConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadAgentConfigOptions = {},
): AgentConfig {
  const home = options.homeDir ?? homedir();
  const dataDir = readString(env, 'AGENT_DATA_DIR', join(home, '.flightlog'));

  return {
    apiUrl: normalizeApiUrl(readString(env, 'API_URL', DEFAULT_API_URL)),
    tokenStorePath: readString(
      env,
      'TOKEN_STORE_PATH',
      join(dataDir, 'agent-tokens.json'),
    ),
    outboxPath: readString(env, 'AGENT_OUTBOX_PATH', join(dataDir, 'agent-outbox.sqlite')),
    clientName: readString(
      env,
      'AGENT_CLIENT_NAME',
      `Flare Agent @ ${options.hostname ?? osHostname()}`,
    ),
    platform: readString(env, 'AGENT_PLATFORM', options.platform ?? process.platform),
    aircraftIcao: readAircraftIcao(env),
    protocol: readProtocol(env),
    maxSampleHz: readInt(env, 'AGENT_MAX_SAMPLE_HZ', 20, { min: 1, max: 60 }),
    syncIntervalMs: readInt(env, 'AGENT_SYNC_INTERVAL_MS', 30_000, {
      min: 1_000,
      max: 86_400_000,
    }),
    heartbeatIntervalMs: readInt(env, 'AGENT_HEARTBEAT_INTERVAL_MS', 60_000, {
      min: 1_000,
      max: 3_600_000,
    }),
    connectPollMs: readInt(env, 'AGENT_CONNECT_POLL_MS', 1_000, { min: 100, max: 60_000 }),
    reconnectBaseMs: readInt(env, 'AGENT_RECONNECT_BASE_MS', 5_000, {
      min: 100,
      max: 600_000,
    }),
    reconnectMaxMs: readInt(env, 'AGENT_RECONNECT_MAX_MS', 60_000, {
      min: 100,
      max: 3_600_000,
    }),
    shutdownFlushMs: readInt(env, 'AGENT_SHUTDOWN_FLUSH_MS', 15_000, {
      min: 0,
      max: 300_000,
    }),
    source: readBoundedString(env, 'AGENT_SOURCE', DEFAULT_AGENT_SOURCE, 64),
    version: readBoundedString(env, 'AGENT_VERSION', packageVersion(), 64),
    machineId: resolveMachineId({ env }),
    bufferRetentionDays: readInt(env, 'AGENT_BUFFER_RETENTION_DAYS', 7, {
      min: 0,
      max: 3_650,
    }),
    bufferMaxPending: readInt(env, 'AGENT_BUFFER_MAX_PENDING', 50_000, {
      min: 0,
      max: 10_000_000,
    }),
    loadQuarantineS: readInt(env, 'AGENT_LOAD_QUARANTINE_S', 4, { min: 0, max: 60 }),
    logLevel: parseLogLevel(env.AGENT_LOG_LEVEL, 'info'),
  };
}

function readBoundedString(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
  maxLength: number,
): string {
  const value = readString(env, key, fallback);
  if (value.length > maxLength) {
    throw new ConfigError(`${key} must be at most ${maxLength} characters`);
  }
  return value;
}

function readString(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const raw = env[key];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : fallback;
}

function readInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new ConfigError(
      `${key} must be an integer between ${bounds.min} and ${bounds.max} (got "${raw}")`,
    );
  }
  return value;
}

function readProtocol(env: Record<string, string | undefined>): SimConnectProtocolName {
  const raw = readString(env, 'SIMCONNECT_PROTOCOL', DEFAULT_PROTOCOL).toLowerCase();
  if (!(PROTOCOLS as readonly string[]).includes(raw)) {
    throw new ConfigError(`SIMCONNECT_PROTOCOL must be one of: ${PROTOCOLS.join(', ')}`);
  }
  return raw as SimConnectProtocolName;
}

function readAircraftIcao(env: Record<string, string | undefined>): string | null {
  const raw = env.AIRCRAFT_ICAO;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const icao = raw.trim().toUpperCase();
  if (!ICAO_RE.test(icao)) {
    throw new ConfigError('AIRCRAFT_ICAO must be a 2-4 character ICAO type code (e.g. B738)');
  }
  return icao;
}

function normalizeApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`API_URL must be a valid URL (got "${raw}")`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('API_URL must use http or https');
  }
  return url.toString().replace(/\/+$/, '');
}
