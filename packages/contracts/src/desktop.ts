import { z } from 'zod';

import { emailSchema, httpsUrlSchema, utcDateTimeSchema, uuidSchema } from './primitives.js';
import { scoreGradeSchema } from './scoring.js';

/**
 * Desktop-контракты (ADR-0011): статус агента для трея/офлайн-страницы и
 * JSON-RPC сообщения между main-процессом Electron и agent-host.
 *
 * Аддитивный модуль: веб/API его не используют, но он живёт в общем пакете,
 * чтобы main/host/preload валидировали один и тот же протокол.
 */

/**
 * Состояние агента, производное от событий рантайма (ADR-0011 §6.1).
 * `authorized` — транзиентное событие реальной авторизации (ADR-0011 §2.3.1),
 * не UI-состояние: `resolveStatusKind` маппит его в `connected_idle`.
 */
export const agentStatusStateSchema = z.enum([
  'auth_required',
  'authorized',
  'sim_waiting',
  'connected_idle',
  'recording',
  'touchdown',
  'syncing',
  'sync_ok',
  'sync_error',
]);
export type AgentStatusState = z.output<typeof agentStatusStateSchema>;

/** Счётчики локального outbox (структурно совпадают с `OutboxCounts` агента). */
export const outboxCountsSchema = z
  .object({
    flights: z.number().int().nonnegative(),
    points: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    pendingFlights: z.number().int().nonnegative(),
    pendingPoints: z.number().int().nonnegative(),
    pendingEvents: z.number().int().nonnegative(),
  })
  .strict();
export type DesktopOutboxCounts = z.output<typeof outboxCountsSchema>;

export const desktopAgentProtocolSchema = z.enum(['sunrise', 'kittyhawk', 'fsx_sp2']);
export type DesktopAgentProtocol = z.output<typeof desktopAgentProtocolSchema>;

/** Канонический id симулятора-источника (ADR-0023); аддитивно для UI-статуса. */
export const desktopSimSourceIdSchema = z.enum(['msfs2024', 'xplane12']);
export type DesktopSimSourceId = z.output<typeof desktopSimSourceIdSchema>;

/** Качество ошибки синка: `retryable` — сеть/офлайн, `fatal` — auth/permission. */
export const agentStatusQualitySchema = z.enum(['retryable', 'fatal']);
export type AgentStatusQuality = z.output<typeof agentStatusQualitySchema>;

/**
 * Причина инициированного синка (T126). Автоматические прогоны
 * (`interval`/`startup`/`flight_ended`/`shutdown`) не показывают уведомлений;
 * системное уведомление о результате положено только явному `manual`
 * (трей «Синхронизировать сейчас» / кнопка в окне «Состояние агента»).
 */
export const agentSyncReasonSchema = z.enum([
  'interval',
  'manual',
  'startup',
  'flight_ended',
  'shutdown',
  'other',
]);
export type AgentSyncReason = z.output<typeof agentSyncReasonSchema>;

/** Статус агента, который main отдаёт в трей и в renderer (без секретов). */
export const agentStatusEventSchema = z
  .object({
    state: agentStatusStateSchema,
    /** Момент формирования события (для «свежести» статуса в offline.html). */
    at: utcDateTimeSchema.optional(),
    deviceId: uuidSchema.optional(),
    flightId: uuidSchema.optional(),
    aircraftIcao: z
      .string()
      .regex(/^[A-Z0-9]{2,4}$/, 'must be an ICAO aircraft type code (2-4 chars)')
      .optional(),
    pendingCounts: outboxCountsSchema.optional(),
    /**
     * Фактические счётчики последнего завершённого синка (из `FlushSummary`).
     * Аддитивно (T125): уведомление о результате ручного синка показывает
     * только ненулевые части, а не всю выгрузку.
     */
    uploadedFlights: z.number().int().nonnegative().optional(),
    uploadedPoints: z.number().int().nonnegative().optional(),
    uploadedEvents: z.number().int().nonnegative().optional(),
    /** Причина синка (T126); в уведомлении участвует только `manual`. */
    syncReason: agentSyncReasonSchema.optional(),
    /**
     * CLIENT-FLIGHT-END-FIX: синк вызван завершением сессии без подтверждённого
     * отрыва (стоянка/руление), а не реального полёта. Клиент не показывает по
     * нему тост «Полёт завершён». Аддитивно/опционально для обратной совместимости.
     */
    flightDiscarded: z.boolean().optional(),
    lastSyncAt: utcDateTimeSchema.optional(),
    message: z.string().max(500).optional(),
    // Аддитивно (desktop-client.md §9): grade-цвет, текст уведомления, «Открыть рейс».
    clientFlightId: uuidSchema.optional(),
    /**
     * Последняя зафиксированная посадка (T115). Агент заполняет их по касанию
     * и удерживает в последующих событиях (`connected_idle`/`sync_ok`), чтобы
     * окно статуса не «деградировало» после завершения рейса. Все поля
     * опциональны (обратная совместимость: старые события их не несут).
     */
    score: z.number().int().min(0).max(100).optional(),
    grade: scoreGradeSchema.optional(),
    vsFpm: z.number().finite().optional(),
    bounceCount: z.number().int().nonnegative().optional(),
    touchAndGo: z.boolean().optional(),
    /**
     * Серверный предпросмотр касания (`score-preview.md` §4): `true` — балл
     * клиентский/неразрешённый (метка «предварительно»), `false` — серверный.
     * Аддитивно: старые события поля не несут (трактуется как `true`).
     */
    scorePreliminary: z.boolean().optional(),
    /** Источник балла в `lastLanding`/тосте: клиент или сервер. */
    scoreSource: z.enum(['client', 'server_preview', 'server_final']).optional(),
    /** Порядковый номер последней посадки в сессии (с 1). */
    landingSeq: z.number().int().min(1).optional(),
    /** Время касания последней посадки (ISO 8601 UTC). */
    lastLandingAt: utcDateTimeSchema.optional(),
    // Строка «Устройство» в окне статуса и About.
    deviceName: z.string().trim().min(1).max(64).optional(),
    agentVersion: z.string().trim().min(1).max(32).optional(),
    /**
     * Источник телеметрии (`agent`/`electron`), как он уходит в API (CD-6.1).
     * Аддитивно: старые события его не несут.
     */
    source: z.string().trim().min(1).max(64).optional(),
    /**
     * CD-6.2: устройство требует повторной привязки (`403 MACHINE_MISMATCH`).
     * Загрузка остановлена, офлайн-буфер сохранён; авто-churn `device/code` не запускается.
     */
    needsRepair: z.boolean().optional(),
    protocol: desktopAgentProtocolSchema.optional(),
    quality: agentStatusQualitySchema.optional(),
    // Device-flow (in-app approve, desktop-client.md §9): код показывается
    // пользователю в окне/трее/офлайн-странице. Код не секрет, но не логируется.
    userCode: z
      .string()
      .regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i, 'must be a user code like WXYZ-1234')
      .optional(),
    verificationUri: z.string().url().optional(),
    /** Срок действия кода в секундах, как пришёл от API. */
    expiresIn: z.number().int().positive().max(86_400).optional(),
    /** Абсолютный момент истечения (для таймера в renderer). */
    userCodeExpiresAt: utcDateTimeSchema.optional(),
    /**
     * Состояние источника телеметрии (SIM-STATUS-1, аддитивно). UI показывает
     * конкретный сим, пин источника, деградацию транспорта и свежесть данных.
     * Старые события этих полей не несут — клиент честно деградирует.
     */
    sim: desktopSimSourceIdSchema.optional(),
    /** Транспорт подключён (read-only) в момент события. */
    simConnected: z.boolean().optional(),
    /** `AGENT_SIM_SOURCE` задан явно: авто-переключение запрещено. */
    simPinned: z.boolean().optional(),
    /** Версия сима, если источник её отдал (например `12.1.4`). */
    simVersion: z.string().trim().min(1).max(32).optional(),
    /** Транспорт соединения: `simconnect-sunrise`, `xp-web-api-v1`, `xp-udp-rref`. */
    simTransport: z.string().trim().min(1).max(64).optional(),
    /** X-Plane: Web API недоступен → RREF (деградированный транспорт). */
    simTransportDegraded: z.boolean().optional(),
    /** Идёт повторный поиск источника (re-discovery). */
    simSearching: z.boolean().optional(),
    /** Время последнего полученного кадра телеметрии (для heartbeat в UI). */
    lastSampleAt: utcDateTimeSchema.optional(),
    /** Секунд до следующей попытки подключения (обратный отсчёт в UI). */
    retryInS: z.number().int().min(1).max(3_600).optional(),
    /** Начало текущей записи (для строки «идёт запись · 12:34»). */
    flightStartedAt: utcDateTimeSchema.optional(),
    /**
     * Периодический heartbeat статуса (не меняет пользовательское состояние):
     * main не перестраивает трей и не логирует его, окно обновляет «данные: N с назад».
     */
    heartbeat: z.boolean().optional(),
  })
  .strict();
export type AgentStatusEvent = z.output<typeof agentStatusEventSchema>;

/** Долгоживущие токены устройства (api.md §2.3), как их хранит main. */
export const storedTokensSchema = z
  .object({
    access_token: z.string().min(1),
    device_token: z.string().min(1),
    device_id: uuidSchema,
    access_expires_at: utcDateTimeSchema.optional(),
  })
  .strict();
export type DesktopStoredTokens = z.output<typeof storedTokensSchema>;

export const desktopLogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type DesktopLogLevel = z.output<typeof desktopLogLevelSchema>;

export const desktopAgentLogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'silent']);
export type DesktopAgentLogLevel = z.output<typeof desktopAgentLogLevelSchema>;

/**
 * Конфиг агента, который main передаёт в host через `agent:start` (ADR-0011 §4).
 * Совместим с `AgentConfig` из `@flightlog/agent`; `tokenStorePath` игнорируется,
 * когда host работает через `HostTokenStoreProxy`.
 */
export const desktopAgentConfigSchema = z
  .object({
    apiUrl: z.string().url(),
    outboxPath: z.string().min(1),
    tokenStorePath: z.string().min(1).optional(),
    clientName: z.string().trim().min(1).max(128),
    platform: z.string().trim().min(1).max(64),
    aircraftIcao: z
      .string()
      .regex(/^[A-Z0-9]{2,4}$/, 'must be an ICAO aircraft type code (2-4 chars)')
      .nullable()
      .optional(),
    protocol: desktopAgentProtocolSchema,
    maxSampleHz: z.number().int().min(1).max(60),
    syncIntervalMs: z.number().int().min(1_000).max(86_400_000).optional(),
    connectPollMs: z.number().int().min(100).max(60_000).optional(),
    reconnectBaseMs: z.number().int().min(100).max(600_000).optional(),
    reconnectMaxMs: z.number().int().min(100).max(3_600_000).optional(),
    shutdownFlushMs: z.number().int().min(0).max(300_000).optional(),
    logLevel: desktopAgentLogLevelSchema.optional(),
  })
  .strict();
export type DesktopAgentConfig = z.output<typeof desktopAgentConfigSchema>;

/** main → host: запустить агент с конфигом. */
export const desktopIpcAgentStartSchema = z
  .object({ type: z.literal('agent:start'), config: desktopAgentConfigSchema })
  .strict();
/** main → host: graceful-остановка агента (финальный flush внутри). */
export const desktopIpcAgentStopSchema = z.object({ type: z.literal('agent:stop') }).strict();
/** main → host: перезапустить агент (свежий device-code при истечении). */
export const desktopIpcAgentRestartSchema = z
  .object({ type: z.literal('agent:restart'), config: desktopAgentConfigSchema })
  .strict();
/** main → host: форсировать синк (кнопка «Синхронизировать сейчас»). */
export const desktopIpcAgentSyncSchema = z.object({ type: z.literal('agent:sync') }).strict();
/** main → host: запросить счётчики outbox. */
export const desktopIpcOutboxStatsSchema = z
  .object({ type: z.literal('outbox:stats'), reqId: z.number().int().optional() })
  .strict();

export const desktopIpcTokenLoadSchema = z
  .object({ type: z.literal('token:load'), reqId: z.number().int() })
  .strict();
export const desktopIpcTokenSaveSchema = z
  .object({ type: z.literal('token:save'), reqId: z.number().int(), tokens: storedTokensSchema })
  .strict();
export const desktopIpcTokenClearSchema = z
  .object({ type: z.literal('token:clear'), reqId: z.number().int() })
  .strict();

/** host → main: статус агента. */
export const desktopIpcStatusSchema = z
  .object({ type: z.literal('status'), event: agentStatusEventSchema })
  .strict();
/** host → main: лог (без секретов; main применяет `redactRecord`). */
export const desktopIpcLogSchema = z
  .object({
    type: z.literal('log'),
    level: desktopLogLevelSchema,
    message: z.string().max(2_000),
    meta: z.record(z.unknown()).optional(),
  })
  .strict();
/**
 * host → main: device-flow требует показать код пользователю.
 * F-105: `expires_in` ограничен сверху (защита от «вечного» таймера),
 * `verification_uri` — только https (loopback-http допустим в dev).
 */
export const desktopIpcAuthUserCodeSchema = z
  .object({
    type: z.literal('auth:userCode'),
    user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i),
    verification_uri: httpsUrlSchema,
    expires_in: z.number().int().min(30).max(3_600),
  })
  .strict();
/** host → main: ответ на `outbox:stats`. */
export const desktopIpcOutboxStatsResultSchema = z
  .object({
    type: z.literal('outbox:stats:result'),
    reqId: z.number().int().optional(),
    counts: outboxCountsSchema,
  })
  .strict();
/** host → main: невосстановимая ошибка host (main перезапускает процесс). */
export const desktopIpcFatalSchema = z
  .object({ type: z.literal('fatal'), error: z.string().max(2_000) })
  .strict();

/** main → host: ответ на `token:load`. */
export const desktopIpcTokenLoadResultSchema = z
  .object({
    type: z.literal('token:load:result'),
    reqId: z.number().int(),
    tokens: storedTokensSchema.nullable(),
  })
  .strict();
export const desktopIpcTokenSaveResultSchema = z
  .object({ type: z.literal('token:save:result'), reqId: z.number().int(), ok: z.boolean() })
  .strict();
export const desktopIpcTokenClearResultSchema = z
  .object({ type: z.literal('token:clear:result'), reqId: z.number().int(), ok: z.boolean() })
  .strict();
export const desktopIpcTokenErrorSchema = z
  .object({
    type: z.literal('token:error'),
    reqId: z.number().int(),
    message: z.string().max(500),
  })
  .strict();

export const desktopIpcMainToHostSchema = z.discriminatedUnion('type', [
  desktopIpcAgentStartSchema,
  desktopIpcAgentStopSchema,
  desktopIpcAgentRestartSchema,
  desktopIpcAgentSyncSchema,
  desktopIpcOutboxStatsSchema,
  desktopIpcTokenLoadResultSchema,
  desktopIpcTokenSaveResultSchema,
  desktopIpcTokenClearResultSchema,
  desktopIpcTokenErrorSchema,
]);
export type DesktopIpcMainToHost = z.output<typeof desktopIpcMainToHostSchema>;

export const desktopIpcHostToMainSchema = z.discriminatedUnion('type', [
  desktopIpcStatusSchema,
  desktopIpcLogSchema,
  desktopIpcAuthUserCodeSchema,
  desktopIpcOutboxStatsResultSchema,
  desktopIpcFatalSchema,
  desktopIpcTokenLoadSchema,
  desktopIpcTokenSaveSchema,
  desktopIpcTokenClearSchema,
]);
export type DesktopIpcHostToMain = z.output<typeof desktopIpcHostToMainSchema>;

/** Язык локальных страниц/трея (RU по умолчанию, EN вторым). */
export const desktopLocaleSchema = z.enum(['ru', 'en']);
export type DesktopLocale = z.output<typeof desktopLocaleSchema>;

/** Команды renderer → main через preload (allowlist, ADR-0011 §7). */
export const desktopRendererCommandSchema = z.enum([
  'start-agent',
  'stop-agent',
  'sync-now',
  'open-about',
  'open-site',
  'open-logs',
  'copy-log',
  'copy-diagnostics',
  'check-updates',
  // T-CLIENT2: подтверждение устройства — только во внешнем браузере.
  'open-device-browser',
  'copy-user-code',
  'request-device-code',
  // T118: opt-in согласие на краш-диагностику (About).
  'enable-error-reporting',
  'disable-error-reporting',
]);
export type DesktopRendererCommand = z.output<typeof desktopRendererCommandSchema>;

/** T118: состояние краш-диагностики для About (DSN из env, согласие из settings). */
export const desktopErrorReportingSchema = z
  .object({
    configured: z.boolean(),
    enabled: z.boolean(),
  })
  .strict();
export type DesktopErrorReporting = z.output<typeof desktopErrorReportingSchema>;

/**
 * Снимок версий/устройства для About и окна статуса (без токенов/PII).
 * Отдаётся main по IPC; локальная страница только рендерит.
 */
export const desktopRuntimeInfoSchema = z
  .object({
    appVersion: z.string().trim().min(1).max(32),
    agentVersion: z.string().trim().min(1).max(32).nullable(),
    electron: z.string().trim().min(1).max(32),
    node: z.string().trim().min(1).max(32),
    chromium: z.string().trim().min(1).max(32),
    protocol: desktopAgentProtocolSchema,
    channel: z.enum(['latest', 'beta']),
    deviceId: uuidSchema.nullable(),
    deviceName: z.string().trim().min(1).max(64).nullable(),
    agentRunning: z.boolean(),
    locale: desktopLocaleSchema,
    /** T118: настроенный hotkey окна статуса (человекочитаемо) или `null`. */
    openStatusHotkey: z.string().trim().min(1).max(64).nullable(),
    errorReporting: desktopErrorReportingSchema,
  })
  .strict();
export type DesktopRuntimeInfo = z.output<typeof desktopRuntimeInfoSchema>;

/**
 * T-CLIENT2: аккаунт, к которому привязано устройство. Best-effort снимок из
 * `GET /v1/me` (main подставляет его в окно привязки). Без токенов/PII кроме
 * самого адреса/имени; `null`-поля — если API не ответил.
 */
export const desktopAccountSchema = z
  .object({
    email: emailSchema.nullable(),
    displayName: z.string().trim().min(1).max(64).nullable(),
    planName: z.string().trim().min(1).max(64).nullable(),
  })
  .strict();
export type DesktopAccount = z.output<typeof desktopAccountSchema>;

export const desktopRendererCommandRequestSchema = z
  .object({ command: desktopRendererCommandSchema })
  .strict();
export type DesktopRendererCommandRequest = z.output<typeof desktopRendererCommandRequestSchema>;
