import type {
  AgentStatusEvent,
  AgentSyncReason,
  ScoreGrade,
  TouchdownPreviewRequest,
  TouchdownPreviewResponse,
} from '@flightlog/contracts';

import type { OutboxBuffer, OutboxCounts } from '../buffer/types.js';
import type {
  FlightEndedInfo,
  FlightRecorderEvents,
  FlightStartedInfo,
  RecorderState,
} from '../flight/recorder.js';
import type { TouchdownEvent } from '../flight/touchdown.js';
import type {
  SimRediscoveryOutcome,
  SimRediscoveryReason,
  SimSessionDiscovery,
} from '../sim/session.js';
import type { SimSourceId, SimSourceOpenInfo } from '../sim/source.js';
import type { SimConnectOpenInfo } from '../sim/types.js';
import { backoffDelayMs } from '../sync/http.js';
import { OutboxSyncer, type OutboxSyncResult } from '../sync/outbox-syncer.js';
import type { TokenStore, StoredTokens } from '../sync/token-store.js';
import {
  MachineMismatchError,
  NotAuthorizedError,
  SyncError,
  type FlushSummary,
  type UploadedLandingScore,
} from '../sync/uploader.js';
import type { AgentConfig } from './config.js';
import { describeError as errorMessage } from './error-message.js';
import type { Logger } from './logger.js';

/** CD-3.4: retention синхронизированных строк outbox по умолчанию (ADR-0008 §3). */
export const DEFAULT_BUFFER_RETENTION_DAYS = 7;
/** CD-3.4: порог pending-строк, после которого окно/трей предупреждаются. */
export const DEFAULT_BUFFER_MAX_PENDING = 50_000;
/**
 * SIM-REDISCOVER-1: сколько подряд неудачных connect'ов терпим до повторного
 * поиска источника. Частоту дополнительно ограничивает cooldown сессии (30 с).
 */
export const DEFAULT_DISCOVERY_FAILURE_THRESHOLD = 2;

/**
 * `403 MACHINE_MISMATCH` (ADR-0018 §5) — от uploader (`MachineMismatchError`) или
 * от device-refresh (`DeviceAuthError` с `code`). В обоих случаях нужен
 * `NeedsRepair`, а не авто-перевыпуск `device/code`.
 */
function isMachineMismatch(error: unknown): boolean {
  if (error instanceof MachineMismatchError) return true;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'MACHINE_MISMATCH';
}

/**
 * `SimSource` отдаёт `SimSourceOpenInfo`, но порт рекордера типизирован
 * legacy-`SimConnectOpenInfo`. Метка `sim` — признак расширенного payload.
 */
function toSimSourceOpenInfo(info: SimConnectOpenInfo): SimSourceOpenInfo | null {
  return typeof (info as { sim?: unknown }).sim === 'string' ? (info as SimSourceOpenInfo) : null;
}

/**
 * Внутренняя причина flush (`'manual'`, `'desktop'`, `'agent_stop'`…) →
 * контрактный `syncReason`. Desktop уведомляет только о `manual`.
 */
function toSyncReason(reason: string): AgentSyncReason {
  switch (reason) {
    case 'interval':
    case 'manual':
    case 'startup':
    case 'flight_ended':
    case 'shutdown':
      return reason;
    // Сессия без подтверждённого отрыва (стоянка/руление) — это не завершение
    // полёта: маппим в нейтральный `other`, а не `flight_ended`.
    case 'discarded':
      return 'other';
    case 'agent_stop':
    case 'desktop_stop':
      return 'shutdown';
    default:
      return 'other';
  }
}

/** Буфер, который при shutdown нужно закрыть (SQLite). */
export interface CloseableOutboxBuffer extends OutboxBuffer {
  close?(): void;
}

/** Минимальная поверхность рекордера, нужная рантайму (упрощает моки). */
export interface RuntimeRecorder {
  readonly state: RecorderState;
  start(): Promise<SimConnectOpenInfo>;
  stop(): Promise<void>;
  on<K extends keyof FlightRecorderEvents>(event: K, handler: FlightRecorderEvents[K]): void;
  off<K extends keyof FlightRecorderEvents>(event: K, handler: FlightRecorderEvents[K]): void;
}

/** Адаптеру рантайм доверяет только состояние соединения (read-only). */
export interface RuntimeSimAdapter {
  readonly connected: boolean;
}

export interface RuntimeAuth {
  authorize(): Promise<StoredTokens>;
}

export interface RuntimeUploader {
  flush(): Promise<FlushSummary>;
  /**
   * Серверный `id` рейса по клиентскому, если uploader уже выгружал его
   * (`score-preview.md` §4). Опционально: моки/старый uploader его не имеют —
   * тогда предпросмотр касания не вызывается (fallback «предварительно»).
   */
  resolveServerFlightId?(clientFlightId: string): string | null;
  /** Авторитетные посадки из последнего `/complete` для `lastLanding`. */
  resolveFinalLandings?(clientFlightId: string): readonly UploadedLandingScore[] | null;
}

/** Синкер outbox (по умолчанию `OutboxSyncer`); инжектируется для тестов/хостов. */
export interface RuntimeSyncer {
  flush(reason: string): Promise<OutboxSyncResult>;
}

/** W1a: периодический heartbeat устройства (не зависит от записи рейса). */
export interface RuntimeHeartbeat {
  start(): void;
  stop(): void;
}

/**
 * Клиент серверного предпросмотра балла касания (`score-preview.md` §4).
 * Fire-and-forget, отменяется новым касанием; ошибки не ломают запись.
 */
export interface RuntimePreviewClient {
  request(
    serverFlightId: string,
    input: TouchdownPreviewRequest,
    options?: { signal?: AbortSignal },
  ): Promise<TouchdownPreviewResponse>;
}

/** Источник балла в `lastLanding`/тосте: клиентский предпросмотр или сервер. */
export type ScoreSource = 'client' | 'server_preview' | 'server_final';

/**
 * Снимок последней посадки (T115). Удерживается рантаймом, чтобы балл/грейд/VS
 * оставались в статус-событиях и после завершения рейса (окно не «деградирует»).
 */
interface LastLanding {
  score: number;
  grade: ScoreGrade;
  /**
   * VS касания (fpm). `null` — телеметрия касания отсутствует; значение
   * **никогда** не подменяется нулём (честная деградация): UI показывает «—».
   */
  vsFpm: number | null;
  /** Число отскоков; `null` — неизвестно (не «0 по умолчанию»). */
  bounceCount: number | null;
  /** Признак touch-and-go; `null` — неизвестно (не «false по умолчанию»). */
  touchAndGo: boolean | null;
  /** Порядковый номер посадки; `null` — пер-посадочных данных нет. */
  seq: number | null;
  /** Время касания (ISO 8601 UTC); `null` — неизвестно (не `Date.now()`). */
  at: string | null;
  /**
   * `true` — балл клиентский (сервер не ответил / не разрешил геометрию) либо
   * сервер вернул посадку без реальной телеметрии касания (деградировавший
   * `/complete`); `false` — подтверждённый серверный предпросмотр/финал. UI
   * показывает метку «предварительно» (`score-preview.md` §4).
   */
  scorePreliminary: boolean;
  scoreSource: ScoreSource;
}

export interface AgentRuntimeDeps {
  adapter: RuntimeSimAdapter;
  recorder: RuntimeRecorder;
  buffer: CloseableOutboxBuffer;
  tokenStore: TokenStore;
  auth: RuntimeAuth;
  uploader: RuntimeUploader;
  logger: Logger;
  /** Переопределение синкера (по умолчанию оборачивает `uploader`). */
  syncer?: RuntimeSyncer;
  /** W1a: heartbeat «клиент онлайн» (по умолчанию — из bootstrap). */
  heartbeat?: RuntimeHeartbeat;
  /**
   * Аддитивный статус-канал для Electron-трея/офлайн-страницы (ADR-0011 §2.2).
   * Опционален: без колбэка поведение рантайма не меняется.
   */
  onStatus?: (event: AgentStatusEvent) => void;
  /** Задержка для ретраев (в тестах — управляемая). */
  sleep?: (ms: number) => Promise<void>;
  /** Источник джиттера backoff (в тестах — детерминированный). */
  random?: () => number;
  /** CD-4.2: версия агента/клиента для `AgentStatusEvent.agentVersion`. */
  agentVersion?: string;
  /** CD-4.2/CD-6.1: источник телеметрии для `AgentStatusEvent.source`. */
  source?: string;
  /** SIM-STATUS-1: канонический id сима для `AgentStatusEvent.sim`. */
  simSourceId?: SimSourceId;
  /**
   * SIM-REDISCOVER-1: сессия источника (переизбрание при недоступности/разрыве).
   * Без неё поведение прежнее (один источник на рантайм).
   */
  simDiscovery?: SimSessionDiscovery;
  /** Сколько подряд connect-ошибок до re-discovery (по умолчанию 2). */
  discoveryFailureThreshold?: number;
  /**
   * Серверный предпросмотр балла касания (`score-preview.md` §4). Опционален:
   * без него поведение прежнее (клиентский балл, метка «предварительно»).
   */
  preview?: RuntimePreviewClient;
}

/**
 * Оркестратор runnable-агента (T83): device flow → подключение к выбранному
 * симулятору (MSFS 2024 / X-Plane 12, строго read-only) → запись рейса в durable
 * outbox → батчевая загрузка.
 *
 * Устойчивость: если сим не запущен/не найден — рантайм не падает, а логирует
 * причину и ретраит подключение с экспоненциальным backoff. Ошибки синка также
 * не фатальны; потеря авторизации повторно запускает device flow.
 */
export class AgentRuntime {
  private readonly logger: Logger;
  private readonly abortController = new AbortController();
  private readonly abortPromise: Promise<void>;
  private readonly waitPromise: Promise<void>;
  private waitResolve: (() => void) | null = null;

  private readonly syncer: RuntimeSyncer;

  private running = false;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private connectionLoop: Promise<void> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncInFlight = false;
  private syncQueued = false;
  private queuedSyncReason: string | null = null;
  private reconnectAttempts = 0;
  /** Идущий re-discovery (сериализует свитч и connect-попытки). */
  private rediscoveryInFlight: Promise<void> | null = null;
  /** Последний успешный `connect` (sim/version/transport) для статуса. */
  private lastOpenInfo: SimSourceOpenInfo | null = null;
  /** Начало текущей записи — для строки «идёт запись · 12:34». */
  private flightStartedAt: string | null = null;
  private readonly discoveryFailureThreshold: number;
  private authorizing: Promise<StoredTokens> | null = null;
  private deviceId: string | null = null;
  private currentFlightId: string | null = null;
  /** ICAO текущего рейса: heartbeat не должен «терять» ВС в окне статуса. */
  private currentAircraftIcao: string | null = null;
  /** Последний клиентский id рейса — для финальной посадки после `/complete`. */
  private lastClientFlightId: string | null = null;
  /** Поколение предпросмотра: новое касание отменяет предыдущий запрос. */
  private previewGeneration = 0;
  private previewAbort: AbortController | null = null;
  private lastSyncAt: string | null = null;
  private lastLanding: LastLanding | null = null;
  /** CD-6.2: `403 MACHINE_MISMATCH` → загрузка остановлена до повторной привязки. */
  private needsRepair = false;
  /** CD-3.4: предупреждение о переполнении pending-очереди не спамим. */
  private bufferLimitWarned = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly deps: AgentRuntimeDeps,
  ) {
    this.logger = deps.logger;
    this.discoveryFailureThreshold = Math.max(
      1,
      deps.discoveryFailureThreshold ?? DEFAULT_DISCOVERY_FAILURE_THRESHOLD,
    );
    this.syncer =
      deps.syncer ??
      new OutboxSyncer({ uploader: deps.uploader, buffer: deps.buffer, logger: deps.logger });
    this.abortPromise = new Promise<void>((resolve) => {
      this.abortController.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    this.waitPromise = new Promise<void>((resolve) => {
      this.waitResolve = resolve;
    });
  }

  /** Запускает агент. Возвращается сразу после авторизации; циклы работают фоном. */
  async start(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    this.logger.info('agent starting (SimConnect read-only)', {
      api_url: this.config.apiUrl,
      outbox_path: this.config.outboxPath,
      token_store_path: this.config.tokenStorePath,
      protocol: this.config.protocol,
    });

    this.attachRecorder();

    // Обобщённое ожидание (сим не выбран/не подключён): имя сима называет UI,
    // когда источник известен (явный `AGENT_SIM_SOURCE`) — «Ожидание данных симулятора».
    this.emitStatus({ state: 'sim_waiting', message: 'Ожидание данных симулятора' });

    const tokens = await this.authorizeWithRetry();
    if (!this.running || !tokens) return;

    // CD-3.4: при старте подчищаем старые synced-строки до подъёма синка, чтобы
    // буфер не рос бесконечно (pending не трогаем — ADR-0008 §3).
    this.pruneBuffer();

    // Синк не зависит от сима: сначала выгружаем накопленный outbox (startup),
    // затем поднимаем периодический flush, и только потом уходим в цикл
    // подключения. Даже если сим не найден, pending-рейсы догрузятся.
    this.syncTimer = setInterval(() => this.requestFlush('interval'), this.config.syncIntervalMs);
    this.syncTimer.unref?.();
    // W1a: heartbeat не зависит от синка/записи — стартует после авторизации.
    this.deps.heartbeat?.start();
    this.requestFlush('startup');

    this.connectionLoop = this.runConnectionLoop();
  }

  /** Резолвится при `stop()` — основной процесс ждёт её для корректного завершения. */
  wait(): Promise<void> {
    return this.waitPromise;
  }

  /** Форсирует синк (кнопка «Синхронизировать сейчас» в трее/UI). */
  syncNow(reason = 'manual'): void {
    this.requestFlush(reason);
  }

  /** Идемпотентный graceful shutdown: финализация рейса, финальный синк, закрытие буфера. */
  async stop(reason = 'agent_stop'): Promise<void> {
    if (this.stopping) return this.stopPromise ?? Promise.resolve();
    this.stopping = true;
    this.running = false;
    this.logger.info('agent stopping', { reason });

    this.abortController.abort();
    this.previewAbort?.abort();
    this.deps.heartbeat?.stop();
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    this.stopPromise = (async () => {
      try {
        await this.deps.recorder.stop();
      } catch (error) {
        this.logger.warn('recorder stop failed', { error: errorMessage(error) });
      }
      await this.flushOnShutdown();
      this.detachRecorder();
      // CD-3.4: очистка + WAL-checkpoint перед закрытием буфера.
      this.pruneBuffer();
      try {
        this.deps.buffer.close?.();
      } catch (error) {
        this.logger.warn('buffer close failed', { error: errorMessage(error) });
      }
      this.waitResolve?.();
      this.logger.info('agent stopped', { reason });
    })();
    return this.stopPromise;
  }

  private async authorizeWithRetry(): Promise<StoredTokens | null> {
    let attempt = 0;
    while (this.running) {
      try {
        return await this.ensureAuthorized();
      } catch (error) {
        const delay = backoffDelayMs(attempt, {
          baseDelayMs: this.config.reconnectBaseMs,
          maxDelayMs: this.config.reconnectMaxMs,
          random: this.deps.random,
        });
        attempt += 1;
        this.logger.warn('authorization unavailable; will retry', {
          retry_in_ms: delay,
          error: errorMessage(error),
        });
        await this.sleep(delay);
      }
    }
    return null;
  }

  private async ensureAuthorized(): Promise<StoredTokens> {
    const stored = await this.deps.tokenStore.load();
    if (stored) {
      this.deviceId = stored.device_id;
      this.logger.info('device authorization loaded from store', { device_id: stored.device_id });
      this.announceAuthorized();
      return stored;
    }
    this.logger.debug('no device token found; starting device authorization flow');
    return this.authorizeDevice();
  }

  private authorizeDevice(): Promise<StoredTokens> {
    if (!this.authorizing) {
      this.authorizing = this.deps.auth
        .authorize()
        .then((tokens) => {
          this.deviceId = tokens.device_id;
          this.logger.info('device authorized', { device_id: tokens.device_id });
          this.announceAuthorized();
          return tokens;
        })
        .finally(() => {
          this.authorizing = null;
        });
    }
    return this.authorizing;
  }

  /**
   * Явное событие реальной авторизации (F-102, ADR-0011 §2.3.1): main закрывает
   * device-flow только по нему, а не по эвристике `sim_waiting`/`connected_idle`.
   * Транзиентное, без токенов — только `deviceId`/`at`.
   */
  private announceAuthorized(): void {
    this.emitStatus({ state: 'authorized', deviceId: this.deviceId ?? undefined });
  }

  private async runConnectionLoop(): Promise<void> {
    while (this.running) {
      // Пока идёт re-discovery/switch, не трогаем старый рекордер: сессия
      // подменяет его атомарно, следующий проход подключится к новому сим.
      if (this.rediscoveryInFlight !== null) {
        await this.rediscoveryInFlight;
        continue;
      }
      if (this.deps.adapter.connected) {
        // SIM-STATUS-1: пока соединение живо, раз в `connectPollMs` отдаём
        // heartbeat — окно статуса видит свежесть данных, не дожидаясь событий.
        this.emitHeartbeat();
        await this.sleep(this.config.connectPollMs);
        continue;
      }
      try {
        const info = await this.deps.recorder.start();
        if (!this.running) {
          await this.deps.recorder.stop().catch(() => undefined);
          return;
        }
        this.reconnectAttempts = 0;
        this.lastOpenInfo = toSimSourceOpenInfo(info);
        this.logger.info('connected to simulator (read-only)', { ...info });
        this.emitStatus({
          state: 'connected_idle',
          message: 'Подключено к симу (read-only)',
        });
        // Даже при успешном connect ждём период опроса: `adapter.connected`
        // остаётся источником истины о разрыве (защита от hot-loop у адаптера).
        await this.sleep(this.config.connectPollMs);
      } catch (error) {
        const delay = backoffDelayMs(this.reconnectAttempts, {
          baseDelayMs: this.config.reconnectBaseMs,
          maxDelayMs: this.config.reconnectMaxMs,
          random: this.deps.random,
        });
        this.reconnectAttempts += 1;
        this.logger.warn('simulator not available; will retry', {
          retry_in_ms: delay,
          error: errorMessage(error),
        });
        this.emitStatus({
          state: 'sim_waiting',
          message: `Симулятор не найден — повтор через ${Math.round(delay / 1000)} с`,
          retryInS: Math.max(1, Math.round(delay / 1000)),
        });
        // SIM-REDISCOVER-1: после N неудач подряд просим сессию переизбрать
        // источник. Частоту проб ограничивает cooldown сессии (30 с), поэтому
        // даже при частых ошибках/экспоненциальном backoff нет busy loop.
        if (this.reconnectAttempts >= this.discoveryFailureThreshold) {
          await this.runRediscovery('connect_failures');
        }
        await this.sleep(delay);
      }
    }
  }

  /**
   * Повторный поиск источника. Вызовы сериализуются: одновременный switch и
   * connect-попытка на старом рекордере недопустимы.
   */
  private runRediscovery(reason: SimRediscoveryReason): Promise<void> {
    if (this.rediscoveryInFlight !== null) return this.rediscoveryInFlight;
    const run = this.performRediscovery(reason).finally(() => {
      if (this.rediscoveryInFlight === run) this.rediscoveryInFlight = null;
    });
    this.rediscoveryInFlight = run;
    return run;
  }

  /**
   * Явный `AGENT_SIM_SOURCE` не переключается — решение и причина логируются
   * сессией. Пока идёт проба, UI видит `simSearching`, чтобы не выглядеть «мёртвым».
   */
  private async performRediscovery(reason: SimRediscoveryReason): Promise<void> {
    const discovery = this.deps.simDiscovery;
    if (!discovery || !this.running) return;
    this.emitStatus({
      state: 'sim_waiting',
      simSearching: true,
      message: 'Ищу симулятор…',
    });
    let outcome: SimRediscoveryOutcome;
    try {
      outcome = await discovery.rediscover(reason);
    } catch (error) {
      this.logger.warn('simulator discovery failed', {
        reason,
        error: errorMessage(error),
      });
      return;
    }
    this.logger.info('simulator discovery decision', {
      reason,
      status: outcome.status,
      from: outcome.from,
      to: outcome.to,
      attempted: outcome.attempted,
      next_probe_in_ms: outcome.nextProbeInMs,
    });
    if (outcome.status === 'switched') {
      this.reconnectAttempts = 0;
      this.lastOpenInfo = null;
    }
  }

  /** Периодический статус при живом соединении (не меняет состояние UI). */
  private emitHeartbeat(): void {
    if (this.stopping || !this.running) return;
    const recording = this.deps.recorder.state.recording;
    this.emitStatus({ state: recording ? 'recording' : 'connected_idle', heartbeat: true });
  }

  /**
   * Планирует flush. Если синк уже идёт, запрос КОАЛЕСЦИРУЕТСЯ в один отложенный:
   * после завершения текущего будет выполнен ещё один прогон. Так `flight_ended`/
   * `interval` не теряются, даже если предыдущая выгрузка заняла много времени.
   */
  private requestFlush(reason: string): void {
    if (this.stopping) return;
    // CD-6.2: NeedsRepair — заливка остановлена, буфер сохранён, сим-запись идёт.
    if (this.needsRepair) return;
    if (this.syncInFlight) {
      this.syncQueued = true;
      this.queuedSyncReason = reason;
      return;
    }
    void this.runFlush(reason);
  }

  private async runFlush(reason: string): Promise<void> {
    this.syncInFlight = true;
    this.emitStatus({
      state: 'syncing',
      syncReason: toSyncReason(reason),
      message: `Синхронизация (${reason})`,
    });
    try {
      const result = await this.syncer.flush(reason);
      this.lastSyncAt = new Date().toISOString();
      // Фактические счётчики выгрузки и причина синка (T125/T126): пустой
      // интервальный синк не уведомляет, ручной — сообщает результат.
      this.emitStatus({
        state: 'sync_ok',
        lastSyncAt: this.lastSyncAt,
        syncReason: toSyncReason(reason),
        // Явный сигнал «синк после сессии без отрыва»: клиент не сбрасывает его
        // на `flight_ended` и не показывает тост завершения полёта.
        flightDiscarded: reason === 'discarded' ? true : undefined,
        uploadedFlights: result.summary.flights_completed,
        uploadedPoints: result.summary.points_uploaded,
        uploadedEvents: result.summary.events_uploaded,
      });
      this.checkBufferLimit();
      // `/complete` принёс авторитетные посадки — перетираем ими предпросмотр.
      this.applyFinalLandings();
    } catch (error) {
      this.emitStatus({ state: 'sync_error', message: errorMessage(error) });
      await this.handleSyncError(error, reason);
    } finally {
      this.syncInFlight = false;
      if (this.syncQueued && !this.stopping) {
        const next = this.queuedSyncReason ?? 'queued';
        this.syncQueued = false;
        this.queuedSyncReason = null;
        void this.runFlush(next);
      }
    }
  }

  private async handleSyncError(error: unknown, reason: string): Promise<void> {
    // CD-6.2: `MACHINE_MISMATCH` — не перевыпускаем код и не чистим токены.
    // Загрузка останавливается, буфер сохраняется; одна строка лога без
    // токенов/машины. Выход из NeedsRepair — повторная привязка + рестарт.
    if (isMachineMismatch(error)) {
      if (this.needsRepair) return;
      this.needsRepair = true;
      this.logger.warn('machine mismatch: upload paused, device needs repair', {
        reason,
        code: 'MACHINE_MISMATCH',
      });
      this.emitStatus({
        state: 'sync_error',
        quality: 'fatal',
        needsRepair: true,
        message: 'Устройство требует повторной привязки — заливка приостановлена',
      });
      return;
    }
    if (error instanceof NotAuthorizedError) {
      this.logger.warn('device authorization lost; re-authorizing', { reason });
      try {
        await this.authorizeDevice();
      } catch (authError) {
        this.logger.error('re-authorization failed', { error: errorMessage(authError) });
      }
      return;
    }
    if (error instanceof SyncError) {
      this.logger.warn('sync failed', {
        reason,
        retryable: error.options.retryable ?? false,
        error: errorMessage(error),
      });
      return;
    }
    this.logger.error('unexpected sync error', { reason, error: errorMessage(error) });
  }

  private async flushOnShutdown(): Promise<void> {
    if (this.config.shutdownFlushMs <= 0) return;
    // NeedsRepair: сервер отклонит записи; буфер остаётся до повторной привязки.
    if (this.needsRepair) {
      this.logger.warn('final sync skipped: device needs repair (machine mismatch)');
      return;
    }
    const timeout = new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), this.config.shutdownFlushMs);
      timer.unref?.();
    });
    try {
      const summary = await Promise.race([this.deps.uploader.flush(), timeout]);
      if (summary) {
        this.logger.info('final sync completed', { ...summary });
      } else {
        this.logger.warn('final sync timed out', { timeout_ms: this.config.shutdownFlushMs });
      }
    } catch (error) {
      if (error instanceof NotAuthorizedError) {
        this.logger.warn('final sync skipped: device is not authorized');
        return;
      }
      this.logger.warn('final sync failed', { error: errorMessage(error) });
    }
  }

  private sleep(ms: number): Promise<void> {
    // Таймер намеренно НЕ `unref`-ится: пока агент работает, его циклы должны
    // удерживать event loop живым (иначе top-level await в main завершится).
    const delay = this.deps.sleep
      ? this.deps.sleep(ms)
      : new Promise<void>((resolve) => setTimeout(resolve, ms));
    return Promise.race([delay, this.abortPromise]);
  }

  private attachRecorder(): void {
    this.deps.recorder.on('flight_started', this.handleFlightStarted);
    this.deps.recorder.on('flight_ended', this.handleFlightEnded);
    this.deps.recorder.on('score', this.handleScore);
    this.deps.recorder.on('disconnect', this.handleDisconnect);
    this.deps.recorder.on('error', this.handleError);
  }

  private detachRecorder(): void {
    this.deps.recorder.off('flight_started', this.handleFlightStarted);
    this.deps.recorder.off('flight_ended', this.handleFlightEnded);
    this.deps.recorder.off('score', this.handleScore);
    this.deps.recorder.off('disconnect', this.handleDisconnect);
    this.deps.recorder.off('error', this.handleError);
  }

  private readonly handleFlightStarted = (info: FlightStartedInfo): void => {
    this.currentFlightId = info.client_flight_id;
    this.currentAircraftIcao = info.aircraft_icao;
    this.lastClientFlightId = info.client_flight_id;
    this.flightStartedAt = info.started_at;
    this.logger.info('flight started', {
      client_flight_id: info.client_flight_id,
      aircraft_icao: info.aircraft_icao,
      aircraft_icao_source: info.aircraft_icao_source,
      started_at: info.started_at,
    });
    this.emitStatus({
      state: 'recording',
      flightId: info.client_flight_id,
      aircraftIcao: info.aircraft_icao,
      message: `Полёт ${info.aircraft_icao}`,
    });
  };

  private readonly handleFlightEnded = (info: FlightEndedInfo): void => {
    this.currentFlightId = null;
    this.currentAircraftIcao = null;
    this.flightStartedAt = null;
    if (info.discarded) {
      this.logger.info('flight_discarded', {
        client_flight_id: info.client_flight_id,
        reason: info.reason,
        discard_reason: info.discard_reason,
        point_count: info.point_count,
      });
      this.emitStatus({
        state: 'connected_idle',
        flightDiscarded: true,
        message: 'Сессия без отрыва — не сохранена',
      });
      // Flush сохраняем: uploader отзовёт такую сессию через `/abandon` (по
      // `no_flight_evidence`). Но причина — `discarded`, а НЕ `flight_ended`.
      this.requestFlush('discarded');
      return;
    }
    this.logger.info('flight_completed', {
      client_flight_id: info.client_flight_id,
      reason: info.reason,
      point_count: info.point_count,
      event_count: info.event_count,
      landings_count: info.landings_count,
      touch_and_go_count: info.touch_and_go_count,
      bounce_count: info.bounce_count,
      is_partial: info.is_partial,
      leaderboard_eligible: info.leaderboard_eligible,
      score: info.score_preview?.score ?? null,
    });
    this.rememberFinalLanding(info);
    this.emitStatus({
      state: 'connected_idle',
      clientFlightId: info.client_flight_id,
      aircraftIcao: info.landings.at(-1)?.metrics.aircraft_icao ?? undefined,
    });
    this.requestFlush('flight_ended');
  };

  /**
   * Фиксирует последнюю посадку сессии из `FlightEndedInfo` (T115): авторитет —
   * предпросмотр рекордера. Если посадок не было, ранее запомненная сохраняется.
   */
  private rememberFinalLanding(info: FlightEndedInfo): void {
    const landing = info.landings.at(-1);
    if (landing) {
      this.lastLanding = {
        score: landing.score.score,
        grade: landing.score.grade,
        vsFpm: landing.metrics.vs_fpm,
        bounceCount: landing.bounceCount,
        touchAndGo: landing.touchAndGo,
        seq: landing.seq,
        at: landing.touchdown_at,
        scorePreliminary: true,
        scoreSource: 'client',
      };
      return;
    }
    if (info.score_preview && info.metrics) {
      this.lastLanding = {
        score: info.score_preview.score,
        grade: info.score_preview.grade,
        vsFpm: info.metrics.vs_fpm,
        bounceCount: info.metrics.bounce_count,
        touchAndGo: null,
        // Без пер-посадочного предпросмотра `seq`/время касания неизвестны:
        // не изобретаем «посадку #1» и не подставляем `ended_at` (время
        // завершения сессии ≠ время касания) — A-02.
        seq: null,
        at: null,
        scorePreliminary: true,
        scoreSource: 'client',
      };
    }
  }

  private readonly handleScore = (event: TouchdownEvent): void => {
    this.logger.info(event.kind === 'bounce' ? 'bounce detected' : 'touchdown detected', {
      landing_seq: event.landingSeq,
      touch_and_go: event.touchAndGo,
      vs_fpm: event.metrics.vs_fpm,
      g_force: event.metrics.g_force,
      bounce_count: event.bounceCount,
      score: event.score.score,
    });
    this.lastLanding = {
      score: event.score.score,
      grade: event.score.grade,
      vsFpm: event.metrics.vs_fpm,
      bounceCount: event.bounceCount,
      touchAndGo: event.touchAndGo,
      seq: event.landingSeq,
      at: event.ts,
      scorePreliminary: true,
      scoreSource: 'client',
    };
    const state = this.deps.recorder.state;
    const position = state.on_ground ? 'на земле' : 'в воздухе';
    const vsLabel =
      event.metrics.vs_fpm === null ? '—' : `${Math.round(event.metrics.vs_fpm)} fpm`;
    this.emitStatus({
      state: 'touchdown',
      flightId: this.currentFlightId ?? undefined,
      score: event.score.score,
      grade: event.score.grade,
      vsFpm: event.metrics.vs_fpm ?? undefined,
      bounceCount: event.bounceCount,
      touchAndGo: event.touchAndGo,
      landingSeq: event.landingSeq,
      lastLandingAt: event.ts,
      message:
        event.kind === 'bounce'
          ? `Отскок (${event.bounceCount}) · посадок: ${event.landingSeq}`
          : `Посадка #${event.landingSeq}${event.touchAndGo ? ' (T&G)' : ''}: ${event.score.score} · ${vsLabel} · ${position} · посадок: ${event.landingSeq}`,
    });
    // Fire-and-forget серверный предпросмотр (`score-preview.md` §4). Не блокирует
    // запись; при недоступности остаётся клиентский балл с меткой «предварительно».
    this.requestTouchdownPreview(event);
  };

  /**
   * Запрашивает серверный балл касания у уже известного рейса. Ничего не ждёт и
   * не бросает: ошибки/таймаут/404/`resolved=false` → тихий fallback на текущий
   * клиентский предпросмотр. Новое касание отменяет предыдущий запрос.
   *
   * `heading_deg: null` (в окне агента <3 валидных курсов, R1) сервер трактует
   * так же, как `/complete`: торец по курсу не подбирается → `resolved=false`,
   * клиент остаётся на клиентском балле «предварительно».
   */
  private requestTouchdownPreview(event: TouchdownEvent): void {
    const client = this.deps.preview;
    if (!client || this.needsRepair) return;
    if (typeof event.latitude !== 'number' || typeof event.longitude !== 'number') {
      return;
    }
    const clientFlightId = this.currentFlightId ?? this.lastClientFlightId;
    if (!clientFlightId) return;
    const serverFlightId = this.deps.uploader.resolveServerFlightId?.(clientFlightId);
    if (!serverFlightId) return;
    // Неизмеренные метрики не отправляем: контракт предпросмотра требует числа,
    // а подставлять «идеальные» 0 fpm / 1.0 g нельзя (data-honesty).
    if (event.metrics.vs_fpm === null || event.metrics.g_force === null) return;

    // Последнее касание побеждает: отменяем предыдущий вызов и его результат.
    this.previewAbort?.abort();
    const controller = new AbortController();
    this.previewAbort = controller;
    const generation = (this.previewGeneration += 1);

    const body: TouchdownPreviewRequest = {
      seq: event.landingSeq,
      touchdown_at: event.ts,
      lat: event.latitude,
      lon: event.longitude,
      heading_deg: event.headingDeg ?? null,
      vs_fpm: event.metrics.vs_fpm,
      g_force: event.metrics.g_force,
      pitch_deg: event.metrics.pitch_deg ?? null,
      bank_deg: event.metrics.bank_deg ?? null,
      bounce_count: event.bounceCount,
      aircraft_icao: event.metrics.aircraft_icao ?? null,
    };

    void client
      .request(serverFlightId, body, { signal: controller.signal })
      .then((response) => {
        if (generation !== this.previewGeneration) return;
        this.applyTouchdownPreview(response);
      })
      .catch((error) => {
        // Тихий fallback: балл остаётся клиентским с меткой «предварительно».
        this.logger.debug('touchdown preview unavailable (client score kept)', {
          landing_seq: event.landingSeq,
          error: errorMessage(error),
        });
      })
      .finally(() => {
        if (this.previewAbort === controller) this.previewAbort = null;
      });
  }

  /**
   * Применяет серверный предпросмотр: `resolved=true` — серверный балл (окно/тост
   * помечают его как подтверждённый), `resolved=false` — остаёмся на клиентском
   * балле с меткой «предварительно» (геометрия не применена).
   */
  private applyTouchdownPreview(response: TouchdownPreviewResponse): void {
    const landing = this.lastLanding;
    if (!landing || landing.seq !== response.data.seq) return;
    if (response.data.resolved) {
      this.lastLanding = {
        ...landing,
        score: response.data.score,
        grade: response.data.grade,
        vsFpm: response.data.metrics.vs_fpm,
        bounceCount: response.data.metrics.bounce_count,
        scorePreliminary: false,
        scoreSource: 'server_preview',
      };
    } else {
      this.lastLanding = {
        ...landing,
        scorePreliminary: true,
        scoreSource: 'client',
      };
    }
    this.emitTouchdownStatus();
  }

  /** Переэмитит текущий `touchdown`-статус с актуальным (возможно серверным) баллом. */
  private emitTouchdownStatus(): void {
    const landing = this.lastLanding;
    if (!landing) return;
    this.emitStatus({
      state: 'touchdown',
      landingSeq: landing.seq ?? undefined,
      lastLandingAt: landing.at ?? undefined,
    });
  }

  /**
   * Авторитетные посадки `/complete` перетирают предпросмотр в `lastLanding`
   * (`score-preview.md` §4). Вызывается после успешного flush; без данных —
   * no-op.
   */
  private applyFinalLandings(): void {
    const clientFlightId = this.lastClientFlightId;
    if (!clientFlightId) return;
    const landings = this.deps.uploader.resolveFinalLandings?.(clientFlightId);
    const last = landings?.at(-1);
    if (!last || last.score === null || last.grade === null) return;
    // Подтверждённый финал повторно не применяем; деградировавший (без
    // телеметрии касания) уточняется последующим полным `/complete`.
    if (this.lastLanding?.scoreSource === 'server_final' && !this.lastLanding.scorePreliminary) {
      return;
    }
    // Честная семантика (A-01): без реальной вертикальной скорости касания
    // посадка не «подтверждена», а VS/отскоки/T&G/время не выдумываются
    // (`?? 0`/`?? false`/`new Date()` запрещены). Неизмеренное поле остаётся
    // `null` или берётся из уже известного клиентского предпросмотра.
    const vsFpm = last.vs_fpm ?? this.lastLanding?.vsFpm ?? null;
    const confirmed = last.vs_fpm !== null;
    this.lastLanding = {
      score: last.score,
      grade: last.grade,
      vsFpm,
      bounceCount: last.bounce_count ?? this.lastLanding?.bounceCount ?? null,
      touchAndGo: last.touch_and_go ?? this.lastLanding?.touchAndGo ?? null,
      seq: last.seq,
      at: last.touchdown_at ?? this.lastLanding?.at ?? null,
      scorePreliminary: !confirmed,
      scoreSource: 'server_final',
    };
    this.emitStatus({ state: 'connected_idle', clientFlightId });
  }

  private readonly handleDisconnect = (reason?: string): void => {
    if (!this.running) return;
    this.logger.warn('simulator disconnected; will reconnect', { reason: reason ?? 'unknown' });
    this.lastOpenInfo = null;
    this.emitStatus({
      state: 'sim_waiting',
      message: `Симулятор отключён (${reason ?? 'unknown'}) — переподключение`,
    });
    // SIM-REDISCOVER-1: разрыв — повод переизбрать источник. Активный рейс к
    // этому моменту уже завершён рекордером (`sim_disconnected`); cooldown
    // сессии не даёт долбить пробами при нестабильном соединении.
    void this.runRediscovery('disconnect');
  };

  private readonly handleError = (error: Error): void => {
    this.logger.error('recorder error', { error: errorMessage(error) });
  };

  private emitStatus(event: AgentStatusEvent): void {
    const onStatus = this.deps.onStatus;
    if (!onStatus) return;
    try {
      const landing = this.lastLanding;
      const sim = this.simStatus();
      onStatus({
        ...event,
        at: new Date().toISOString(),
        deviceId: event.deviceId ?? this.deviceId ?? undefined,
        pendingCounts: event.pendingCounts ?? this.pendingCounts(),
        lastSyncAt: event.lastSyncAt ?? this.lastSyncAt ?? undefined,
        // CD-4.2/CD-6.1: окно/About видят версию и канал источника.
        agentVersion: event.agentVersion ?? this.deps.agentVersion ?? this.config.version,
        source: event.source ?? this.deps.source ?? this.config.source,
        // Heartbeat не должен обнулять рейс/ВС в окне статуса между событиями.
        flightId: event.flightId ?? this.currentFlightId ?? undefined,
        clientFlightId: event.clientFlightId ?? this.currentFlightId ?? undefined,
        aircraftIcao: event.aircraftIcao ?? this.currentAircraftIcao ?? undefined,
        // SIM-STATUS-1: конкретный сим/транспорт/свежесть данных для окна статуса.
        sim: event.sim ?? sim.sim,
        simConnected: event.simConnected ?? sim.simConnected,
        simPinned: event.simPinned ?? sim.simPinned,
        simVersion: event.simVersion ?? sim.simVersion,
        simTransport: event.simTransport ?? sim.simTransport,
        simTransportDegraded: event.simTransportDegraded ?? sim.simTransportDegraded,
        lastSampleAt: event.lastSampleAt ?? sim.lastSampleAt,
        flightStartedAt: event.flightStartedAt ?? this.flightStartedAt ?? undefined,
        // T115: последняя посадка переживает завершение рейса — окно статуса
        // продолжает показывать балл/грейд/VS, а не только текст.
        score: event.score ?? landing?.score,
        grade: event.grade ?? landing?.grade,
        vsFpm: event.vsFpm ?? landing?.vsFpm ?? undefined,
        bounceCount: event.bounceCount ?? landing?.bounceCount ?? undefined,
        touchAndGo: event.touchAndGo ?? landing?.touchAndGo ?? undefined,
        landingSeq: event.landingSeq ?? landing?.seq ?? undefined,
        lastLandingAt: event.lastLandingAt ?? landing?.at ?? undefined,
        // score-preview.md §4: источник и «предварительность» балла для тоста.
        scorePreliminary: event.scorePreliminary ?? landing?.scorePreliminary,
        scoreSource: event.scoreSource ?? landing?.scoreSource,
      });
    } catch (error) {
      this.logger.warn('status listener failed', { error: errorMessage(error) });
    }
  }

  /** Поля источника телеметрии из активной сессии/последнего connect. */
  private simStatus(): {
    sim?: SimSourceId;
    simConnected?: boolean;
    simPinned?: boolean;
    simVersion?: string;
    simTransport?: string;
    simTransportDegraded?: boolean;
    lastSampleAt?: string;
  } {
    const snapshot = this.deps.simDiscovery?.snapshot();
    const info = this.lastOpenInfo;
    const sim = snapshot?.sourceId ?? info?.sim ?? this.deps.simSourceId;
    const connected = snapshot?.connected ?? this.deps.adapter.connected;
    const version = info?.simVersion ?? undefined;
    const transport = info?.adapter ?? undefined;
    return {
      sim,
      simConnected: connected,
      simPinned: snapshot?.pinned,
      simVersion: version ?? undefined,
      simTransport: transport,
      simTransportDegraded: info?.transportDegraded === true ? true : undefined,
      lastSampleAt: snapshot?.lastSampleAt ?? undefined,
    };
  }

  /**
   * CD-3.4: удаляет synced-строки старше retention (pending не трогает) и делает
   * `PRAGMA wal_checkpoint(TRUNCATE)`, если что-то удалилось. Ошибки гигиены
   * буфера не фатальны для агента.
   */
  private pruneBuffer(): void {
    const buffer = this.deps.buffer;
    if (typeof buffer.pruneSyncedBefore !== 'function') return;
    const retentionDays = this.config.bufferRetentionDays ?? DEFAULT_BUFFER_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    try {
      const pruned = buffer.pruneSyncedBefore(cutoff);
      const removed = pruned.flights + pruned.points + pruned.events;
      if (removed > 0) {
        this.logger.info('outbox pruned', { ...pruned, retention_days: retentionDays });
        try {
          buffer.checkpoint?.();
        } catch (error) {
          this.logger.warn('wal checkpoint failed', { error: errorMessage(error) });
        }
      }
    } catch (error) {
      this.logger.warn('outbox prune failed', { error: errorMessage(error) });
    }
  }

  /** CD-3.4: предупреждение, если pending-очередь превысила порог. */
  private checkBufferLimit(): void {
    const limit = this.config.bufferMaxPending ?? DEFAULT_BUFFER_MAX_PENDING;
    if (limit <= 0) return;
    const counts = this.pendingCounts();
    if (!counts) return;
    const pending = counts.pendingFlights + counts.pendingPoints + counts.pendingEvents;
    if (pending <= limit) {
      this.bufferLimitWarned = false;
      return;
    }
    if (this.bufferLimitWarned) return;
    this.bufferLimitWarned = true;
    this.logger.warn('outbox pending exceeds limit', { pending, limit });
    this.emitStatus({
      state: 'sync_error',
      quality: 'retryable',
      message: `Очередь синка переполнена (${pending})`,
    });
  }

  private pendingCounts(): OutboxCounts | undefined {
    try {
      return this.deps.buffer.pendingCounts();
    } catch {
      return undefined;
    }
  }
}
