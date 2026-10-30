import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AgentStatusEvent, DeviceCodeResponse } from '@flightlog/contracts';

import type {
  CloseableOutboxBuffer,
  RuntimeAuth,
  RuntimePreviewClient,
  RuntimeRecorder,
  RuntimeSyncer,
  RuntimeUploader,
} from '../cli/runtime.js';
import { AgentRuntime } from '../cli/runtime.js';
import type { AgentConfig } from '../cli/config.js';
import { createConsoleLogger, type Logger } from '../cli/logger.js';
import {
  defaultIcaoTypeDesignatorLookup,
  getDefaultAircraftCfgIndex,
} from '../flight/aircraft-config.js';
import { loadAircraftDictionary } from '../flight/aircraft-dictionary.js';
import { FlightRecorder } from '../flight/recorder.js';
import {
  createSimSource,
  createSimSourceResolver,
  parseSimSourcePreference,
} from '../sim/registry.js';
import { SimSession } from '../sim/session.js';
import { SIM_SOURCE_ENV, type SimSource, type SimSourceId } from '../sim/source.js';
import { DeviceAuthClient } from '../sync/device-auth.js';
import { HeartbeatClient, HeartbeatScheduler } from '../sync/heartbeat.js';
import { FetchHttpClient, type HttpClient } from '../sync/http.js';
import { OutboxSyncer } from '../sync/outbox-syncer.js';
import { resolveMachineId } from '../sync/machine-id.js';
import { TouchdownPreviewClient } from '../sync/touchdown-preview.js';
import { FileTokenStore, type StoredTokens, type TokenStore } from '../sync/token-store.js';
import { DEFAULT_SYNC_MAX_ATTEMPTS, FlightUploader } from '../sync/uploader.js';
import { resolveProvenance } from '../util/provenance.js';

/** Auth-клиент с возможностью refresh (нужен и рантайму, и uploader'у). */
export interface BootstrapAuth extends RuntimeAuth {
  refresh(): Promise<StoredTokens>;
}

export interface BootstrapAgentOptions {
  config: AgentConfig;
  /** Переопределение хранилища токенов (Electron: `safeStorage`-прокси). */
  tokenStore?: TokenStore;
  logger?: Logger;
  /** Канонический read-only источник телеметрии (ADR-0023; предпочтительно). */
  source?: SimSource;
  /** @deprecated Используйте `source`. Алиас сохранён на один релиз. */
  adapter?: SimSource;
  http?: HttpClient;
  /** Переопределение outbox (desktop/smoke: in-memory). */
  buffer?: CloseableOutboxBuffer;
  auth?: BootstrapAuth;
  recorder?: RuntimeRecorder;
  uploader?: RuntimeUploader;
  syncer?: RuntimeSyncer;
  /** CD-6.2: переопределение `machine_id` (иначе env/файл; `null` — legacy). */
  machineId?: string | null;
  /** Аддитивный статус-канал (ADR-0011 §2.2). */
  onStatus?: (event: AgentStatusEvent) => void;
  /** Device-flow требует показать код пользователю (для GUI). */
  onUserCode?: (info: DeviceCodeResponse) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /**
   * T-D §6.4: best-effort загрузка выученного словаря ICAO на старте.
   * По умолчанию включена вне тестового окружения (`NODE_ENV !== 'test'`).
   */
  loadAircraftDictionary?: boolean;
}

/** Зависимости синка outbox → API (общие для рантайма и ручного CLI-синка). */
export interface SyncDependencies {
  buffer: CloseableOutboxBuffer;
  tokenStore: TokenStore;
  auth: BootstrapAuth;
  uploader: RuntimeUploader;
  syncer: RuntimeSyncer;
  /** `score-preview.md` §4: серверный предпросмотр балла касания. */
  preview: RuntimePreviewClient;
  /** W1a: heartbeat «клиент онлайн» (запускается рантаймом). */
  heartbeat: HeartbeatScheduler;
}

/**
 * Результат сборки агента: рантайм и его зависимости (для CLI/Electron host).
 */
export interface BootstrappedAgent extends SyncDependencies {
  runtime: AgentRuntime;
  config: AgentConfig;
  logger: Logger;
  /** Единственный read-only источник этого рантайма (ADR-0023). */
  source: SimSource;
  /** @deprecated Алиас `source`. Сохранён на один релиз. */
  adapter: SimSource;
  recorder: RuntimeRecorder;
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  dispose(reason?: string): Promise<void>;
}

/** Результат сборки только синк-стека (без SimConnect) — для `pnpm ... sync`. */
export interface BootstrappedOutboxSync extends SyncDependencies {
  config: AgentConfig;
  logger: Logger;
  /** Закрывает SQLite-буфер (без финального flush'а). */
  close(): void;
}

type SyncStackOptions = Pick<
  BootstrapAgentOptions,
  | 'tokenStore'
  | 'http'
  | 'buffer'
  | 'auth'
  | 'uploader'
  | 'syncer'
  | 'machineId'
  | 'onUserCode'
  | 'sleep'
  | 'random'
> & {
  /**
   * ADR-0023: канонический id выбранного `SimSource` — уходит в uploader
   * provenance как `sim`. Задаётся `bootstrapAgent` после резолва источника;
   * `bootstrapOutboxSync` (ручной CLI-синк) его не знает и не шлёт.
   */
  sim?: SimSourceId;
};

/**
 * Общий composition root синк-стека. Выделен из `bootstrapAgent`, чтобы ручной
 * CLI-синк использовал ровно те же SQLite-буфер, токены, uploader и syncer, но
 * не тянул SimConnect-адаптер и рекордер.
 */
async function buildSyncStack(
  config: AgentConfig,
  logger: Logger,
  options: SyncStackOptions,
): Promise<SyncDependencies> {
  const http = options.http ?? new FetchHttpClient();
  const tokenStore = options.tokenStore ?? new FileTokenStore(config.tokenStorePath);
  // CD-6.1/CD-6.2: origin и machine_id — конфиг → env → безопасный дефолт.
  const provenance = resolveProvenance({ source: config.source, version: config.version });
  const machineId = options.machineId ?? config.machineId ?? resolveMachineId();

  let buffer = options.buffer;
  if (!buffer) {
    // Ленивый импорт: `better-sqlite3` — нативный модуль (в Electron host его
    // подменяет/пересобирает `@electron/rebuild`), не тянем его без нужды.
    const { SqliteOutboxBuffer } = await import('../buffer/sqlite-buffer.js');
    mkdirSync(dirname(config.outboxPath), { recursive: true });
    buffer = new SqliteOutboxBuffer(config.outboxPath);
  }

  const auth: BootstrapAuth =
    options.auth ??
    new DeviceAuthClient({
      http,
      apiBaseUrl: config.apiUrl,
      tokenStore,
      clientName: config.clientName,
      platform: config.platform,
      machineId,
      onUserCode: (info) => {
        // `user_code` — не секрет, но по требованию T116 не логируется
        // (redactRecord также вырезает его как чувствительный ключ).
        logger.info('device authorization required: open the URL and approve the code', {
          verification_uri: info.verification_uri,
          expires_in_s: info.expires_in,
        });
        options.onUserCode?.(info);
      },
    });

  const uploader =
    options.uploader ??
    new FlightUploader({
      apiBaseUrl: config.apiUrl,
      http,
      buffer,
      tokenStore,
      auth,
      source: provenance.source,
      version: provenance.version,
      sim: options.sim,
      machineId,
      // Ограниченный backoff: один flush не «залипает» навсегда, а сдаётся и
      // повторяется следующим (interval/manual), поэтому очередь не wedges.
      retry: { maxAttempts: DEFAULT_SYNC_MAX_ATTEMPTS, random: options.random },
      sleep: options.sleep,
    });

  const syncer = options.syncer ?? new OutboxSyncer({ uploader, buffer, logger });

  // score-preview.md §4: предпросмотр касания тем же транспортом/токенами.
  const preview = new TouchdownPreviewClient({
    apiBaseUrl: config.apiUrl,
    http,
    tokenStore,
    auth,
    machineId,
  });

  const heartbeat = new HeartbeatScheduler({
    client: new HeartbeatClient({
      apiBaseUrl: config.apiUrl,
      http,
      tokenStore,
      auth,
      machineId,
    }),
    logger,
    intervalMs: config.heartbeatIntervalMs,
  });

  return { buffer, tokenStore, auth, uploader, syncer, preview, heartbeat };
}

/**
 * Собирает только синк-стек (без SimConnect). Используется CLI-командой
 * `pnpm --filter @flightlog/agent sync` для ручной/диагностической выгрузки
 * зависшего outbox.
 */
export async function bootstrapOutboxSync(
  options: Pick<BootstrapAgentOptions, 'config' | 'logger'> & SyncStackOptions,
): Promise<BootstrappedOutboxSync> {
  const { config } = options;
  const logger = options.logger ?? createConsoleLogger({ level: config.logLevel });
  const deps = await buildSyncStack(config, logger, options);
  return {
    ...deps,
    config,
    logger,
    close: () => {
      try {
        deps.buffer.close?.();
      } catch (error) {
        logger.warn('buffer close failed', { error: errorMessage(error) });
      }
    },
  };
}

/**
 * Общий composition root агента (ADR-0011 §2.1): собирает рантайм с дефолтными
 * реализациями, но позволяет CLI/Electron переопределить зависимости (токены,
 * буфер, логи, статус). CLI `main.ts` и `apps/desktop` agent-host используют
 * одну и ту же сборку — логика записи/синка не дублируется.
 *
 * Async: дефолтный SQLite-буфер загружается лениво, чтобы host не тянул
 * нативный `better-sqlite3` до первого запуска агента.
 */
export async function bootstrapAgent(options: BootstrapAgentOptions): Promise<BootstrappedAgent> {
  const { config } = options;
  const logger = options.logger ?? createConsoleLogger({ level: config.logLevel });
  const provenance = resolveProvenance({ source: config.source, version: config.version });

  // Composition root источника (ADR-0023, Решение 3): ровно один `SimSource` на
  // рантайм. `auto` (дефолт) резолвится в MSFS, пока X-Plane не зарегистрирован;
  // `AGENT_SIM_SOURCE` — аварийный клапан (неизвестное значение → warn + фолбэк).
  const context = { logger, maxSampleHz: config.maxSampleHz, protocol: config.protocol };
  const resolver = createSimSourceResolver({ logger, context });
  const source = options.source ?? options.adapter ?? (await resolver.resolveAsync());

  // Sync-стек собираем ПОСЛЕ резолва источника: его `id` уходит в uploader
  // provenance (`sim`), поэтому рейс X-Plane сохраняется как `xplane12`, а не
  // дефолтным `msfs2024` (ADR-0023; root-cause владельца 0.3.16).
  const sync = await buildSyncStack(config, logger, { ...options, sim: source.id });

  const createRecorder = (target: SimSource): RuntimeRecorder =>
    new FlightRecorder({
      source: target,
      buffer: sync.buffer,
      aircraftIcao: config.aircraftIcao ?? undefined,
      aircraftIcaoLookup: defaultIcaoTypeDesignatorLookup,
      loadQuarantineS: config.loadQuarantineS,
      warn: (message, meta) => logger.warn(message, meta),
    });
  const recorder = options.recorder ?? createRecorder(source);

  // SIM-REDISCOVER-1: production-путь владеет «сессией источника», умеющей
  // переизбрать сим при недоступности/разрыве. Инъекция source/adapter/recorder
  // (тесты/CLI-хуки) сохраняет прежнюю семантику «один источник на рантайм».
  const useSession = !options.source && !options.adapter && !options.recorder;
  const parsedSource = parseSimSourcePreference(process.env[SIM_SOURCE_ENV] ?? null);
  const session = useSession
    ? new SimSession({
        preference: parsedSource.unknown !== null ? 'auto' : parsedSource.preference,
        initialSource: source,
        initialRecorder: recorder,
        createSource: (id: SimSourceId) => createSimSource(id, context),
        createRecorder,
        logger,
        context,
      })
    : null;

  // Прогреваем индекс `aircraft.cfg` в фоне: к первому полёту резолв готов,
  // старт записи не блокируется дисковым сканом (T-ICAO-BCS3).
  getDefaultAircraftCfgIndex().ensureBuilt();

  // T-D §6.4: best-effort загрузка выученного словаря ICAO (таймаут/офлайн →
  // встроенный). Не блокирует старт и не ломает офлайн-контракт. В тестах по
  // умолчанию выключена (без сети); можно переопределить `loadAircraftDictionary`.
  const dictionaryEnabled = options.loadAircraftDictionary ?? process.env.NODE_ENV !== 'test';
  if (dictionaryEnabled) {
    void loadAircraftDictionary().then((result) => {
      if (result.ok) {
        logger.info('aircraft dictionary loaded', {
          version: result.version,
          pairs: result.pairs,
        });
      } else {
        logger.info('aircraft dictionary using embedded fallback', {
          reason: result.error ?? 'unknown',
          pairs: result.pairs,
        });
      }
    });
  }

  const runtime = new AgentRuntime(config, {
    adapter: session ?? source,
    recorder: session ?? recorder,
    buffer: sync.buffer,
    tokenStore: sync.tokenStore,
    auth: sync.auth,
    uploader: sync.uploader,
    syncer: sync.syncer,
    preview: sync.preview,
    heartbeat: sync.heartbeat,
    logger,
    onStatus: options.onStatus,
    sleep: options.sleep,
    random: options.random,
    agentVersion: provenance.version,
    source: provenance.source,
    simSourceId: source.id,
    simDiscovery: session ?? undefined,
  });

  return {
    runtime,
    config,
    logger,
    source,
    adapter: source,
    buffer: sync.buffer,
    tokenStore: sync.tokenStore,
    auth: sync.auth,
    uploader: sync.uploader,
    syncer: sync.syncer,
    preview: sync.preview,
    heartbeat: sync.heartbeat,
    recorder: session ?? recorder,
    start: () => runtime.start(),
    stop: (reason) => runtime.stop(reason),
    dispose: (reason = 'dispose') => runtime.stop(reason),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
