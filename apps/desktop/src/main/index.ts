import { existsSync } from 'node:fs';
import { arch, hostname, platform, release } from 'node:os';
import { join } from 'node:path';

import type { SimSourcePreference } from '@flightlog/agent';
import { createConsoleLogger, type Logger as AgentLogger } from '@flightlog/agent/logging';
import {
  resolveStatusKind,
  type AgentStatusEvent,
  type DesktopAccount,
  type DesktopAgentConfig,
  type DesktopLocale,
  type DesktopOutboxCounts,
  type DesktopRendererCommand,
  type DesktopRuntimeInfo,
} from '@flightlog/contracts';
import {
  app,
  clipboard,
  dialog,
  globalShortcut,
  nativeTheme,
  powerMonitor,
  session,
  shell,
} from 'electron';

import { AgentHostManager } from './agent-host-manager.js';
import { buildAgentEnv } from './agent-env.js';
import { AccountResolver } from './account.js';
import { PlanResolver } from './plan.js';
import { applyAppIdentity, registerAppUserModelId, resolveAppIconPath } from './app-identity.js';
import { buildDiagnosticsText } from './about.js';
import { AboutWindowController } from './about-window.js';
import {
  loadSettings,
  resolveDesktopConfig,
  resolveInitialLocale,
  saveSettings,
  type DesktopConfig,
  type DesktopSettings,
  type NotificationPreferences,
} from './config.js';
import {
  buildClientErrorPayload,
  initErrorReporting,
  resolveErrorReporting,
  sendClientErrorReport,
} from './error-reporting.js';
import { createFileLog, formatLogLine, type FileLogSink } from './file-log.js';
import { registerIpc, removeIpc } from './ipc.js';
import { isHiddenLaunch, loginItemArgs, shouldRevealOnSecondInstance } from './lifecycle.js';
import { DeviceFlow } from './device-flow.js';
import { DeviceCodeRequestGuard } from './device-code-guard.js';
import { classifyDeviceIssue, type DeviceIssue } from './device-error.js';
import { MachineIdStore, machineIdPath } from './machine-id.js';
import { removeApplicationMenu } from './menu.js';
import {
  activateNotification,
  Notifier,
  type NotificationTarget,
  type UpdateInstallResult,
} from './notifications.js';
import { applySessionSecurity, openSameOriginExternal, type SecurityContext } from './security.js';
import {
  nextSimConnected,
  readSimSourcePreferenceFromEnv,
  resolveSimSourceKind,
  type SimSourceKind,
} from './sim-source-status.js';
import { StatusWindowController } from './status-window.js';
import { SafeStorageTokenStore } from './token-store.js';
import { TrayController } from './tray.js';
import { selectTrayVariant, type TrayIconVariant } from './tray-icons.js';
import { DesktopUpdater } from './updater.js';
import { getDesktopMessages } from '../shared/i18n.js';
import type { UpdateStatus } from '../shared/update-status.js';

// Идентичность клиента — до `whenReady`, иначе ОС видит «Electron».
applyAppIdentity(app, process.platform);

const baseLogger = createConsoleLogger({ level: 'info' });

/** Иконка окна/таскбара: Windows — `.ico`, прочие — `.png` (dev: `build/`, packaged: `resources/`). */
const appIconPath = (() => {
  const candidate = resolveAppIconPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: join(__dirname, '../..'),
    platform: process.platform,
  });
  return candidate && existsSync(candidate) ? candidate : undefined;
})();

// Windows: имя/иконка в тостах берутся из AppUserModelId. Установленный билд
// получает их из ярлыка; dev/портативный запуск — регистрацией в HKCU.
if (process.platform === 'win32') {
  void registerAppUserModelId({
    iconPath: appIconPath,
    // Relaunch-значения имеют смысл только у установленного приложения:
    // в dev `getPath('exe')` указывает на `electron.exe` (без appRoot).
    executablePath: app.isPackaged ? app.getPath('exe') : undefined,
  }).catch((error: unknown) => {
    baseLogger.warn('AppUserModelId registration failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

const MAX_LOG_LINES = 80;
const logBuffer: string[] = [];

/** T123: файловый лог (создаётся в `init`, пишет info/warn/error и статусы). */
let fileLog: FileLogSink | null = null;
let lastStatusLogSignature: string | null = null;

function pushLog(level: string, message: string): void {
  logBuffer.push(`${new Date().toISOString()} ${level} ${message}`);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
}

function writeToFile(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  meta?: unknown,
): void {
  // Debug-поток во время записи слишком шумный для durable-лога.
  if (level === 'debug') return;
  fileLog?.write(formatLogLine(level, message, meta));
}

const logger: AgentLogger = {
  debug: (message, meta) => {
    baseLogger.debug(message, meta);
    pushLog('debug', message);
  },
  info: (message, meta) => {
    baseLogger.info(message, meta);
    pushLog('info', message);
    writeToFile('info', message, meta);
  },
  warn: (message, meta) => {
    baseLogger.warn(message, meta);
    pushLog('warn', message);
    writeToFile('warn', message, meta);
  },
  error: (message, meta) => {
    baseLogger.error(message, meta);
    pushLog('error', message);
    writeToFile('error', message, meta);
  },
};

/** Статусы пишем только при смене (state/score/vsFpm/message) — без спама на 10 Гц. */
function logStatusToFile(event: AgentStatusEvent): void {
  if (!fileLog) return;
  const signature = `${event.state}|${event.score ?? ''}|${event.vsFpm ?? ''}|${event.message ?? ''}`;
  if (signature === lastStatusLogSignature) return;
  lastStatusLogSignature = signature;
  fileLog.write(
    formatLogLine('status', event.state, {
      score: event.score,
      vsFpm: event.vsFpm,
      aircraft: event.aircraftIcao,
      pendingPoints: event.pendingCounts?.pendingPoints,
      // T125: фактические счётчики выгрузки — видно, что пустой интервал = 0/0.
      uploadedFlights: event.uploadedFlights,
      uploadedPoints: event.uploadedPoints,
      uploadedEvents: event.uploadedEvents,
      // T126: причина синка — доказательство, что интервальные не уведомляют.
      syncReason: event.syncReason,
      message: event.message,
    }),
  );
}

interface DesktopDiagnostics {
  __flightlogAgentRunning?: boolean;
  __flightlogStatusCount?: number;
  __flightlogStartHidden?: boolean;
  __flightlogWindowVisible?: boolean;
  __flightlogStatusWindowVisible?: boolean;
  __flightlogStatusWindowCreated?: boolean;
  __flightlogAutostart?: boolean;
  __flightlogOnboardingShown?: boolean;
  __flightlogCommands?: Record<string, number>;
  /** T117: активный вариант иконки трея (по теме ОС). */
  __flightlogTrayVariant?: TrayIconVariant;
  /** T118: акселератор зарегистрированного hotkey окна статуса. */
  __flightlogHotkey?: string | null;
  /** Dev/smoke-хук: показать окно статуса без клика по трею. */
  __flightlogOpenStatus?: () => void;
  /** Dev/smoke-хук: подмешать статус в окно для скриншотов состояний. */
  __flightlogEmitStatus?: (event: AgentStatusEvent) => void;
  /** Dev/smoke-хук: снимок состояния device-flow (T116). */
  __flightlogDeviceState?: () => {
    pending: boolean;
    userCode: string | null;
    verificationUri: string | null;
  };
  /** Dev/smoke-хук: сэмулировать `auth:userCode` от agent-host. */
  __flightlogHandleUserCode?: (info: {
    user_code: string;
    verification_uri: string;
    expires_in: number;
  }) => void;
  /** Dev/smoke: счётчик ручных запросов открытия внешнего браузера. */
  __flightlogExternalOpenRequests?: number;
  /** T123: путь файлового лога main-процесса (или null, если отключён). */
  __flightlogLogFile?: string | null;
  /** T125: сколько системных уведомлений реально показано (анти-спам проверка). */
  __flightlogNotificationsShown?: number;
  /** T125: показанные уведомления (kind/title/body) — доказательство анти-спама. */
  __flightlogNotifications?: Array<{ kind: string; title: string; body: string }>;
  /** T125: последнее показанное уведомление (kind/title/body). */
  __flightlogLastNotification?: { kind: string; title: string; body: string } | null;
  /** Единственный OS-выход включён (env + трей-тумблер). */
  __flightlogAuthAlerts?: boolean;
  /** Dev/smoke-хук: эмулировать готовность обновления (без диалога). */
  __flightlogSetUpdateReady?: (version: string | null) => void;
  /** FIX-UPDATE-CHECK-FEEDBACK: снимок последнего статуса проверки обновлений. */
  __flightlogUpdateStatus?: UpdateStatus | null;
  /** FIX-UPDATE-CHECK-FEEDBACK: эмулировать статус проверки (без сети). */
  __flightlogEmitUpdateStatus?: (status: UpdateStatus) => void;
  /** T-CLIENT2: best-effort снимок аккаунта привязки. */
  __flightlogAccount?: DesktopAccount | null;
  /** T-CLIENT3: активный язык клиента. */
  __flightlogLocale?: DesktopLocale;
  /** CD-3.2: путь отдельного файла machine-id (не значение!). */
  __flightlogMachineIdFile?: string | null;
  /** CD-4.3: распознанная проблема устройства (lim/mismatch) или null. */
  __flightlogDeviceIssue?: DeviceIssue | null;
}

const diagnostics = globalThis as DesktopDiagnostics;

let config: DesktopConfig;
let settings: DesktopSettings;
let locale: DesktopLocale = 'ru';
let securityContext: SecurityContext;
let tokenStore: SafeStorageTokenStore;
let accountResolver: AccountResolver;
let planResolver: PlanResolver;
let manager: AgentHostManager | null = null;
let statusWindow: StatusWindowController | null = null;
let aboutWindow: AboutWindowController | null = null;
let tray: TrayController | null = null;
let notifier: Notifier | null = null;
let updater: DesktopUpdater | null = null;
let deviceFlow: DeviceFlow | null = null;
const deviceCodeGuard = new DeviceCodeRequestGuard();
let nativeThemeListener: (() => void) | null = null;

let lastStatus: AgentStatusEvent | null = null;
let lastOutbox: DesktopOutboxCounts | null = null;
let lastAgentError: string | null = null;
let agentRunning = false;
let recording = false;
let machineIdStore: MachineIdStore | null = null;

// ADR-0023 (решение 3): источник выбирает агент; клиент лишь показывает
// предпочтение из env (`auto` по умолчанию) и состояние подключения. Управления нет.
let simSourcePreference: SimSourcePreference = 'auto';
let simConnected = false;

function currentSimSourceKind(): SimSourceKind {
  return resolveSimSourceKind({
    preference: simSourcePreference,
    connected: simConnected,
    source: lastStatus?.sim ?? null,
  });
}

function refreshSimSource(): void {
  tray?.setSimSource(currentSimSourceKind());
}

function markAgentRunning(running: boolean): void {
  agentRunning = running;
  diagnostics.__flightlogAgentRunning = running;
}

function markStatusCount(): void {
  diagnostics.__flightlogStatusCount = (diagnostics.__flightlogStatusCount ?? 0) + 1;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

app.enableSandbox();

app.on('second-instance', (_event, commandLine) => {
  // Автозапуск/повторный `--hidden` (T123): клиент уже работает, окно не
  // показываем — single-instance не превращает фоновый старт в popup.
  if (!shouldRevealOnSecondInstance(commandLine)) return;
  showStatusWindow();
});

function buildAgentConfig(desktop: DesktopConfig): DesktopAgentConfig {
  const agentDir = join(desktop.dataDir, 'agent');
  return {
    apiUrl: desktop.apiUrl,
    outboxPath: join(agentDir, 'agent-outbox.sqlite'),
    tokenStorePath: join(agentDir, 'tokens.enc'),
    clientName: `Flare Desktop @ ${hostname()}`,
    platform: 'win32',
    aircraftIcao: null,
    protocol: desktop.agentProtocol,
    maxSampleHz: desktop.agentMaxSampleHz,
    logLevel: 'info',
  };
}

function buildRuntimeInfo(): DesktopRuntimeInfo {
  return {
    appVersion: app.getVersion(),
    agentVersion: lastStatus?.agentVersion ?? null,
    electron: process.versions.electron ?? '?',
    node: process.versions.node ?? '?',
    chromium: process.versions.chrome ?? '?',
    protocol: config.agentProtocol,
    channel: config.channel,
    deviceId: lastStatus?.deviceId ?? null,
    deviceName: hostname(),
    agentRunning,
    locale,
    // W1b: глобальный hotkey убран; поле оставлено для совместимости контракта.
    openStatusHotkey: null,
    // W1b: отправка идёт в собственный API (`POST /v1/client-errors`), поэтому
    // транспорт всегда доступен; включает её только согласие пользователя.
    errorReporting: { configured: true, enabled: settings.errorReportingConsent },
  };
}

function updateSettings(patch: Partial<DesktopSettings>): void {
  settings = { ...settings, ...patch };
  saveSettings(config.dataDir, settings);
}

/**
 * T-CLIENT3: мгновенная смена языка из окна. Сохраняется как явный выбор
 * (`settings.locale`), поэтому переживает перезапуск и не перетирается
 * системной локалью. Переводит окна, трей-меню/тултип и уведомления
 * (Notifier/DeviceFlow читают язык через геттер `locale`).
 */
function handleSetLocale(next: DesktopLocale): void {
  updateSettings({ locale: next });
  diagnostics.__flightlogLocale = next;
  if (next === locale) return;
  locale = next;
  tray?.setLocale(next);
  statusWindow?.setLocale(next);
  aboutWindow?.setLocale(next);
  // Переопубликовать активный код устройства в новом языке (окно/трей/тост).
  deviceFlow?.republish();
}

/**
 * T-CLIENT2: URL страницы сайта с локалью (`/` → `/<locale>/dashboard`).
 * Открывается ТОЛЬКО во внешнем браузере; внутрь окна клиента сайт не грузим.
 */
function webPageUrl(path: string): string {
  const base = config.webUrl.replace(/\/+$/, '');
  const route =
    path === '' || path === '/' ? '/dashboard' : path.startsWith('/') ? path : `/${path}`;
  return `${base}/${locale}${route}`;
}

/** Best-effort снимок аккаунта привязки (без секретов наружу). */
async function refreshAccount(): Promise<DesktopAccount | null> {
  const account = await accountResolver.refresh();
  diagnostics.__flightlogAccount = account;
  return account;
}

/** iter77: premium-скин клиента; fail-safe — базовый скин (renderer не ставит data-plan). */
async function refreshPlan() {
  const plan = (await planResolver?.refresh()) ?? null;
  tray?.setPlan(plan);
  return plan;
}

/** «Открыть сайт» — системный браузер (дашборд/рейсы), не окно клиента. */
function openSiteInBrowser(path = '/'): void {
  if (!openSameOriginExternal(securityContext, webPageUrl(path))) return;
  diagnostics.__flightlogExternalOpenRequests =
    (diagnostics.__flightlogExternalOpenRequests ?? 0) + 1;
}

/**
 * T-UPD-CADENCE: показ окна статуса — пользователь взаимодействует, поэтому
 * заодно перепроверяем обновление, если прошлая проверка устарела (15 мин,
 * in-flight guard внутри апдейтера). Единый фаннел для всех путей показа окна.
 */
function showStatusWindow(): void {
  statusWindow?.show();
  updater?.recheckIfStale();
}

function applyAutostart(enabled: boolean): void {
  updateSettings({ autostart: enabled });
  diagnostics.__flightlogAutostart = enabled;
  if (config.isPackaged || process.env.FLIGHTLOG_ALLOW_LOGIN_ITEM === '1') {
    app.setLoginItemSettings({ openAtLogin: enabled, args: loginItemArgs() });
  }
}

function handleStatus(event: AgentStatusEvent): void {
  lastStatus = event;
  // SIM-STATUS-1: heartbeat (раз в секунду при живом соединении) обновляет
  // только окно статуса; трей/уведомления/лог не перестраиваем — иначе меню
  // трея и файловый лог молотят на 1 Гц без изменения состояния.
  if (event.heartbeat === true) {
    statusWindow?.sendStatus(event);
    return;
  }
  markStatusCount();
  logStatusToFile(event);
  // ADR-0023: держим флаг «сим подключён» по sim-событиям (синк его не сбрасывает).
  simConnected = nextSimConnected(simConnected, event.state);
  // F-102: закрываем device-flow только по явному событию реальной авторизации,
  // а не по эвристике sim_waiting/connected_idle/sync_ok (ADR-0011 §2.3.1).
  if (event.state === 'authorized') {
    if (deviceFlow?.isPending()) deviceFlow.markAuthorized();
    clearDeviceIssue();
  }
  if (event.state === 'recording' || event.state === 'touchdown') recording = true;
  if (
    event.state === 'connected_idle' ||
    event.state === 'sim_waiting' ||
    event.state === 'auth_required'
  ) {
    recording = false;
  }
  if (event.state === 'sync_error') {
    lastAgentError = null;
    // `needsRepair` (CD-6.2) — машиночитаемый сигнал MACHINE_MISMATCH; код в
    // тексте — дополнительный канал (в т.ч. DEVICE_LIMIT_REACHED).
    const needsRepair = (event as { needsRepair?: unknown }).needsRepair === true;
    const issue = needsRepair ? 'machine-mismatch' : classifyDeviceIssue(event.message);
    if (issue) handleDeviceIssue(issue);
  }
  if (event.state === 'authorized' || event.state === 'sync_ok') {
    // T-CLIENT2: после входа/синка best-effort обновляем аккаунт привязки.
    void refreshAccount();
    void refreshPlan();
  }
  if (event.pendingCounts) {
    lastOutbox = event.pendingCounts;
    tray?.setOutbox(event.pendingCounts);
  }
  tray?.setStatus(event);
  tray?.setRecording(recording);
  refreshSimSource();
  statusWindow?.sendStatus(event);
  if (event.pendingCounts) statusWindow?.sendOutbox(event.pendingCounts);
  notifier?.onStatus(event);
  // UPDATE-AUTO-INSTALL: после изменения `simConnected`/`recording` отменяем
  // отложенную установку, если начался полёт, или планируем, когда сим свободен.
  updater?.retryAutoInstall();
}

function startAgent(): void {
  if (!manager || agentRunning) return;
  if (!tokenStore.isEncryptionAvailable() && !tokenStore.allowsPlaintext()) {
    handleStatus({
      state: 'auth_required',
      message: getDesktopMessages(locale).status.safeStorageUnavailable,
    });
    return;
  }
  markAgentRunning(true);
  tray?.setAgentRunning(true);
  statusWindow?.sendAgentRunning(true);
  manager.start(buildAgentConfig(config));
  manager.requestOutboxStats();
}

function stopAgent(): void {
  if (!manager) return;
  markAgentRunning(false);
  deviceFlow?.reset();
  tray?.setAgentRunning(false);
  statusWindow?.sendAgentRunning(false);
  manager.stop();
  handleStatus({
    state: 'sim_waiting',
    message: getDesktopMessages(locale).status.agentStoppedMessage,
  });
}

async function confirmRecordingStop(): Promise<boolean> {
  const messages = getDesktopMessages(locale).tray.menu;
  const parent = statusWindow?.window() ?? null;
  const options = {
    type: 'warning' as const,
    title: messages.recordingConfirmTitle,
    message: messages.recordingConfirmTitle,
    detail: messages.recordingConfirmBody,
    buttons: [messages.recordingConfirmStop, messages.stopConfirmCancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return result.response === 0;
}

async function toggleAgent(): Promise<void> {
  if (agentRunning && recording) {
    if (!(await confirmRecordingStop())) return;
  }
  if (agentRunning) stopAgent();
  else startAgent();
}

/**
 * CD-4.3: 409 `DEVICE_LIMIT_REACHED` / `MACHINE_MISMATCH` → понятная RU/EN-
 * инструкция в окне + тост, клик ведёт на `/settings/devices`.
 */
function handleDeviceIssue(issue: DeviceIssue): void {
  diagnostics.__flightlogDeviceIssue = issue;
  statusWindow?.sendDeviceIssue(issue);
  showStatusWindow();
  notifier?.deviceIssue(issue);
}

/** Сброс баннера проблемы устройства после успешной (re-)привязки. */
function clearDeviceIssue(): void {
  if (diagnostics.__flightlogDeviceIssue == null) return;
  diagnostics.__flightlogDeviceIssue = null;
  statusWindow?.sendDeviceIssue(null);
}

function handleFatal(error: string): void {
  markAgentRunning(false);
  deviceFlow?.reset();
  lastAgentError = error;
  tray?.setAgentRunning(false);
  tray?.setAgentError(error);
  simConnected = false;
  refreshSimSource();
  statusWindow?.sendAgentRunning(false);
  statusWindow?.sendAgentError(error);
  notifier?.agentStopped(error);
  const issue = classifyDeviceIssue(error);
  if (issue) handleDeviceIssue(issue);
  logger.error('agent-host fatal', { error });
}

function installUpdate(): UpdateInstallResult {
  if (!updater) return 'no-update';
  const result = updater.install();
  if (result === 'deferred') {
    handleStatus({
      state: recording ? 'recording' : 'sync_ok',
      message: getDesktopMessages(locale).tray.menu.updateDeferred,
    });
  }
  return result;
}

/**
 * Готовность обновления — неинтрузивно (T132): пункт трея + строка в окне
 * «Состояние агента». Никаких модальных диалогов и перехвата фокуса.
 */
function handleUpdateReady(version: string | null): void {
  tray?.setUpdateReady(version);
  statusWindow?.sendUpdateReady(version);
  // CD-4.1: тост «обновление готово» (один раз на версию, silent).
  if (version) notifier?.updateReady(version);
}

/**
 * FIX-UPDATE-CHECK-FEEDBACK: статус проверки обновлений наружу в окна клиента
 * (status + about), чтобы кнопка «Проверить обновления» давала видимый итог.
 */
function handleUpdateStatus(status: UpdateStatus): void {
  diagnostics.__flightlogUpdateStatus = status;
  statusWindow?.sendUpdateStatus(status);
  aboutWindow?.sendUpdateStatus(status);
}

function toggleAutostart(enabled: boolean): void {
  applyAutostart(enabled);
  tray?.setAutostart(enabled);
}

/** T132: единственный OS-выход (action-required). Трей-тумблер, default true. */
function toggleAuthAlerts(enabled: boolean): void {
  updateSettings({ authAlerts: enabled });
  tray?.setAuthAlerts(enabled);
  diagnostics.__flightlogAuthAlerts = config.authAlertsEnabled && enabled;
}

/** CD-4.1: вкл/выкл отдельного Windows-тоста (касание/синк/обновление). */
function toggleNotification(kind: keyof NotificationPreferences, enabled: boolean): void {
  updateSettings({ notifications: { ...settings.notifications, [kind]: enabled } });
  tray?.setNotifications(settings.notifications);
}

/** T118: opt-in согласие на краш-диагностику; без DSN ничего не отправляем. */
function setErrorReportingConsent(enabled: boolean): void {
  updateSettings({ errorReportingConsent: enabled });
  initErrorReporting(resolveErrorReporting(config.errorReportingDsn, enabled), (message) =>
    logger.info(message),
  );
}

function openLogs(): void {
  const target = app.getPath('logs');
  void shell.openPath(target).then((error) => {
    if (error) logger.warn('failed to open logs directory', { error });
  });
}

function copyLogs(): void {
  clipboard.writeText(logBuffer.join('\n'));
}

function copyDiagnostics(): void {
  const kind = resolveStatusKind(lastStatus, {
    agentRunning,
    recording,
    agentError: lastAgentError !== null,
  });
  const text = buildDiagnosticsText({
    runtime: buildRuntimeInfo(),
    statusKind: kind,
    outbox: lastOutbox,
    logs: logBuffer,
  });
  clipboard.writeText(text);
}

/**
 * W1b: диагностика уходит в `POST /v1/client-errors` (logs-only) и только при
 * явном согласии. В тело попадают версии/ОС/язык и хвост лога без токенов,
 * e-mail и путей (`error-reporting.ts`).
 */
async function sendDiagnostics(): Promise<boolean> {
  if (!settings.errorReportingConsent) return false;
  const payload = buildClientErrorPayload({
    appVersion: app.getVersion(),
    agentVersion: lastStatus?.agentVersion ?? null,
    os: `${platform()} ${release()} ${arch()}`,
    locale,
    logs: logBuffer,
  });
  const sent = await sendClientErrorReport({
    endpoint: `${config.apiUrl}/v1/client-errors`,
    payload,
    fetchImpl: globalThis.fetch.bind(globalThis),
  });
  logger[sent ? 'info' : 'warn'](sent ? 'diagnostics sent' : 'diagnostics send failed');
  return sent;
}

function handleUserCode(info: {
  user_code: string;
  verification_uri: string;
  expires_in: number;
}): void {
  // T116: подтверждение — В ОКНЕ КЛИЕНТА (same-origin), системный браузер не
  // открываем автоматически. Браузер — только вторичный fallback по команде.
  deviceFlow?.handleUserCode({
    user_code: info.user_code,
    verification_uri: info.verification_uri,
    expires_in: info.expires_in,
  });
}

/** T-CLIENT2: подтверждение — во внешнем браузере, внутрь окна сайт не грузим. */
function openDeviceInBrowser(): void {
  openSiteInBrowser('/device');
}

function copyUserCode(): void {
  const code = deviceFlow?.state?.userCode;
  if (code) clipboard.writeText(code);
}

/**
 * Истёк код → просим агента получить новый (перезапуск runtime).
 * F-101: только если кода нет или он истёк, не чаще cooldown и в пределах
 * лимита за окно — иначе XSS/same-origin renderer зациклит рестарт агента.
 */
function requestDeviceCode(): void {
  if (!manager || recording) return;
  const allowed = deviceCodeGuard.tryRequest({
    hasPendingCode: deviceFlow?.isPending() ?? false,
    codeExpired: deviceFlow?.isExpired() ?? false,
  });
  if (!allowed) {
    logger.warn('request-device-code throttled');
    return;
  }
  deviceFlow?.reset();
  manager.restart(buildAgentConfig(config));
}

/**
 * Клик по тосту (CD-4.1/CD-4.3). Маршрутизация — чистая `activateNotification`;
 * здесь только проводка к main (окно/браузер/установка обновления).
 */
function handleNotificationActivate(target: NotificationTarget): void {
  activateNotification(target, {
    showStatusWindow,
    openSite: (path) => openSiteInBrowser(path),
  });
}

function handleCommand(command: DesktopRendererCommand): void {
  const counts = (diagnostics.__flightlogCommands ??= {});
  counts[command] = (counts[command] ?? 0) + 1;
  switch (command) {
    case 'start-agent':
      startAgent();
      break;
    case 'stop-agent':
      void toggleAgent();
      break;
    case 'sync-now':
      manager?.syncNow();
      break;
    case 'open-about':
      aboutWindow?.show();
      break;
    case 'open-site':
      openSiteInBrowser('/');
      break;
    case 'open-device-browser':
      openDeviceInBrowser();
      break;
    case 'copy-user-code':
      copyUserCode();
      break;
    case 'request-device-code':
      requestDeviceCode();
      break;
    case 'open-logs':
      openLogs();
      break;
    case 'copy-log':
      copyLogs();
      break;
    case 'copy-diagnostics':
      copyDiagnostics();
      break;
    case 'check-updates':
      updater?.check();
      break;
    case 'enable-error-reporting':
      setErrorReportingConsent(true);
      break;
    case 'disable-error-reporting':
      setErrorReportingConsent(false);
      break;
    default:
      break;
  }
}

async function init(): Promise<void> {
  config = resolveDesktopConfig({
    env: process.env,
    isPackaged: app.isPackaged,
    userDataDir: app.getPath('userData'),
  });
  settings = loadSettings(config.dataDir);
  if (settings.channel !== config.channel && !process.env.FLIGHTLOG_CHANNEL) {
    config = { ...config, channel: settings.channel };
  }
  locale = resolveInitialLocale(settings, app.getLocale());
  diagnostics.__flightlogLocale = locale;
  diagnostics.__flightlogAuthAlerts = config.authAlertsEnabled && settings.authAlerts;
  fileLog = config.logFile
    ? createFileLog(config.logFile, {
        onError: (message, error) =>
          baseLogger.warn(message, {
            error: error instanceof Error ? error.message : String(error),
          }),
      })
    : null;
  diagnostics.__flightlogLogFile = fileLog?.path ?? null;
  logger.info('desktop client starting', {
    version: app.getVersion(),
    dataDir: config.dataDir,
    apiUrl: config.apiUrl,
    logFile: fileLog?.path ?? null,
  });
  initErrorReporting(
    resolveErrorReporting(config.errorReportingDsn, settings.errorReportingConsent),
    (message) => logger.info(message),
  );

  // CD-3.2/CD-6.2: machine-id — отдельный файл, создаётся один раз. Raw-значение
  // уходит только в env agent-host и больше нигде не логируется/не отдаётся.
  machineIdStore = new MachineIdStore(machineIdPath(config.dataDir), {
    onWarn: (message) => logger.warn(message),
  });
  const resolvedMachineId = await machineIdStore.getOrCreate();
  diagnostics.__flightlogMachineIdFile = machineIdStore.path;
  // ADR-0023 (решение 3): предпочтение источника — только из env; UI-тумблера нет.
  simSourcePreference = readSimSourcePreferenceFromEnv(process.env);
  // Env agent-host: machine-id/source/version + явный pass-through
  // `AGENT_SIM_SOURCE` и opt-in FOQA SimVars (владелец включает через env).
  const agentEnv = buildAgentEnv({
    baseEnv: process.env,
    machineId: resolvedMachineId,
    source: 'electron',
    version: app.getVersion(),
    foqaSimvars: process.env.FLIGHTLOG_FOQA_SIMVARS,
  });

  const preloadPath = join(__dirname, '../preload/index.js');
  const statusFile = join(__dirname, '../renderer/status.html');
  const aboutFile = join(__dirname, '../renderer/about.html');
  const hostScriptPath = join(__dirname, 'agent-host.js');

  const rendererDevUrl = process.env.ELECTRON_RENDERER_URL;
  const devBase = rendererDevUrl?.replace(/\/+$/, '');
  const statusUrl = devBase ? `${devBase}/status.html` : undefined;
  const aboutUrl = devBase ? `${devBase}/about.html` : undefined;
  const extraOrigins = rendererDevUrl ? [new URL(rendererDevUrl).origin] : [];

  securityContext = {
    webOrigin: new URL(config.webUrl).origin,
    localFiles: [statusFile, aboutFile],
    extraOrigins,
    isDev: !app.isPackaged,
  };

  applySessionSecurity(session.defaultSession);

  const allowPlaintext = config.isPackaged
    ? false
    : process.env.FLIGHTLOG_ALLOW_FILE_TOKEN_STORE === '1';
  tokenStore = new SafeStorageTokenStore(
    join(config.dataDir, 'agent', 'tokens.enc'),
    allowPlaintext,
    (message) => logger.warn(message),
  );

  // T-CLIENT2: best-effort аккаунт привязки для окна (без токенов в renderer).
  accountResolver = new AccountResolver({
    apiUrl: config.apiUrl,
    loadAccessToken: async () => (await tokenStore.load())?.access_token ?? null,
    fetchImpl: globalThis.fetch.bind(globalThis),
  });
  planResolver = new PlanResolver({
    apiUrl: config.apiUrl,
    loadAccessToken: async () => (await tokenStore.load())?.access_token ?? null,
    fetchImpl: globalThis.fetch.bind(globalThis),
  });
  // Startup: последний известный/свежий план до первого показа окна.
  void refreshPlan();

  notifier = new Notifier({
    onActivate: handleNotificationActivate,
    onShown: ({ target, title, body }) => {
      const shown = { kind: target.kind, title, body };
      diagnostics.__flightlogNotificationsShown =
        (diagnostics.__flightlogNotificationsShown ?? 0) + 1;
      (diagnostics.__flightlogNotifications ??= []).push(shown);
      diagnostics.__flightlogLastNotification = shown;
    },
    onSuppressed: ({ reason, flightId, landingSeq }) =>
      logger.info('touchdown toast suppressed', {
        reason,
        flight_id: flightId,
        landing_seq: landingSeq,
      }),
    // Политика: action-required включён, если разрешён развёртыванием (env
    // default true) и не выключен трей-тумблером. Тосты — по префам settings.
    enabled: () => config.authAlertsEnabled && settings.authAlerts,
    preferences: () => settings.notifications,
    locale: () => locale,
  });

  manager = new AgentHostManager({
    hostScriptPath,
    tokenStore,
    logger,
    env: agentEnv,
    handlers: {
      onStatus: handleStatus,
      onUserCode: handleUserCode,
      onFatal: handleFatal,
      onLog: (level, message, meta) =>
        logger[level](message, meta as Record<string, unknown> | undefined),
      onOutboxStats: (counts) => {
        lastOutbox = counts;
        tray?.setOutbox(counts);
        statusWindow?.sendOutbox(counts);
      },
      onRunningChange: (running) => {
        markAgentRunning(running);
        tray?.setAgentRunning(running);
        statusWindow?.sendAgentRunning(running);
        if (!running) {
          simConnected = false;
          refreshSimSource();
        }
      },
    },
  });

  statusWindow = new StatusWindowController({
    statusFile,
    statusUrl,
    preloadPath,
    security: securityContext,
    isDev: !app.isPackaged,
    iconPath: appIconPath,
    locale: () => locale,
    runtimeInfo: buildRuntimeInfo,
    onHidden: () => {
      diagnostics.__flightlogStatusWindowVisible = false;
      diagnostics.__flightlogWindowVisible = false;
      // Окно свернули в трей, а код ещё в силе — напомним (единственный
      // допустимый OS-выход, с троттлингом внутри Notifier).
      deviceFlow?.notifyIfHidden(false);
    },
  });

  aboutWindow = new AboutWindowController({
    aboutFile,
    aboutUrl,
    preloadPath,
    security: securityContext,
    iconPath: appIconPath,
    locale: () => locale,
  });

  const initialIconVariant = selectTrayVariant(nativeTheme.shouldUseDarkColors);
  diagnostics.__flightlogHotkey = null;
  diagnostics.__flightlogTrayVariant = initialIconVariant;

  tray = new TrayController(
    {
      onOpenStatus: () => showStatusWindow(),
      // Tray-меню открыто → дешёвая перепроверка обновления (та же stale-логика).
      onMenuOpen: () => updater?.recheckIfStale(),
      onOpenSite: (path) => openSiteInBrowser(path),
      onToggleAgent: () => void toggleAgent(),
      onSyncNow: () => manager?.syncNow(),
      onCheckUpdates: () => updater?.check(),
      onInstallUpdate: installUpdate,
      onAbout: () => aboutWindow?.show(),
      onQuit: () => {
        void (async () => {
          if (recording && !(await confirmRecordingStop())) return;
          app.quit();
        })();
      },
      onToggleAutostart: toggleAutostart,
      onToggleAuthAlerts: toggleAuthAlerts,
      onToggleNotification: toggleNotification,
      onCopyUserCode: () => copyUserCode(),
      onOpenDeviceInBrowser: () => openDeviceInBrowser(),
      onSetLocale: handleSetLocale,
    },
    {
      agentRunning: false,
      recording: false,
      autostart: settings.autostart,
      authAlerts: settings.authAlerts,
      notifications: settings.notifications,
      updateReady: null,
      locale,
      iconVariant: initialIconVariant,
      simSource: currentSimSourceKind(),
      openStatusAccelerator: null,
    },
  );
  tray.create();
  // F2: стартовый снимок плана мог прийти до создания трея.
  tray.setPlan(planResolver?.value ?? null);

  nativeThemeListener = () => {
    const variant = selectTrayVariant(nativeTheme.shouldUseDarkColors);
    diagnostics.__flightlogTrayVariant = variant;
    tray?.setIconVariant(variant);
  };
  nativeTheme.on('updated', nativeThemeListener);

  deviceFlow = new DeviceFlow({
    locale: () => locale,
    isWindowVisible: () => statusWindow?.isVisible() ?? false,
    // T-CLIENT2: код показываем в окне; браузер открывает пользователь кнопкой.
    showWindow: () => showStatusWindow(),
    setTrayUserCode: (code, expiresAt) => tray?.setUserCode(code, expiresAt),
    publishStatus: (event) => handleStatus(event),
    notifyPending: (state) => notifier?.deviceCodePending(state.userCode),
    onAuthorized: () => {
      // Подтверждение прошло: окно само переходит в «привязано» по статусу,
      // БЕЗ перезагрузки и без открытия дашборда.
      void refreshAccount();
    },
  });
  diagnostics.__flightlogDeviceState = () => {
    const state = deviceFlow?.state ?? null;
    return {
      pending: state !== null,
      userCode: state?.userCode ?? null,
      verificationUri: state?.verificationUri ?? null,
    };
  };
  diagnostics.__flightlogHandleUserCode = (info) => handleUserCode(info);

  registerIpc(securityContext, logger, {
    getStatus: () => lastStatus,
    getRuntimeInfo: buildRuntimeInfo,
    getAccount: () => accountResolver?.value ?? null,
    getPlan: () => planResolver?.value ?? null,
    onCommand: handleCommand,
    installUpdate: () => installUpdate(),
    sendDiagnostics: () => sendDiagnostics(),
    setLocale: handleSetLocale,
    openManageDevices: () => openSiteInBrowser('/settings/devices'),
    fitAboutWindow: (sender, heightCss) => aboutWindow?.fitFromRenderer(sender, heightCss),
    fitStatusWindow: (sender, heightCss) => statusWindow?.fitFromRenderer(sender, heightCss),
  });

  statusWindow.create();
  statusWindow.loadStatus();
  diagnostics.__flightlogStatusWindowCreated = true;
  // Диагностические хуки main-контекста (недоступны renderer; только test/smoke).
  diagnostics.__flightlogOpenStatus = () => showStatusWindow();
  diagnostics.__flightlogEmitStatus = (event) => handleStatus(event);
  diagnostics.__flightlogSetUpdateReady = (version) => handleUpdateReady(version);
  diagnostics.__flightlogEmitUpdateStatus = (status) => handleUpdateStatus(status);

  const explicitHidden = isHiddenLaunch(process.argv);
  const showOnboarding = !settings.onboardingDone && !explicitHidden;
  const hidden = explicitHidden || settings.startHidden;

  diagnostics.__flightlogAutostart = settings.autostart;
  if (config.isPackaged || process.env.FLIGHTLOG_ALLOW_LOGIN_ITEM === '1') {
    app.setLoginItemSettings({ openAtLogin: settings.autostart, args: loginItemArgs() });
  }

  if (showOnboarding) {
    updateSettings({ onboardingDone: true });
    diagnostics.__flightlogOnboardingShown = true;
    showStatusWindow();
  } else if (!hidden) {
    showStatusWindow();
  }
  diagnostics.__flightlogStartHidden = hidden && !showOnboarding;
  diagnostics.__flightlogWindowVisible = showOnboarding || !hidden;
  diagnostics.__flightlogStatusWindowVisible = showOnboarding || !hidden;

  setInterval(() => {
    if (agentRunning) manager?.requestOutboxStats();
  }, 15_000).unref?.();

  // FIX-UPDATE-CHECK-FEEDBACK: апдейтер создаётся всегда, чтобы ручная проверка
  // давала видимый результат и в dev/offline (status.error), а не молчала.
  updater = new DesktopUpdater({
    feedUrl: config.updateFeedUrl,
    channel: config.channel,
    isPackaged: config.isPackaged,
    isRecording: () => recording,
    isSimConnected: () => simConnected,
    logger,
    intervalMs: config.updateCheckIntervalMs,
    onUpdateReady: (version) => {
      // Неинтрузивно: трей + окно статуса. Модальный диалог убран (T132):
      // трей-приложение не перехватывает фокус и не беспокоит пользователя.
      handleUpdateReady(version);
    },
    onStatus: (status) => handleUpdateStatus(status),
    onStatusText: (text) => logger.info(text),
  });
  await updater.setup();
  if (config.isPackaged) {
    // Первая проверка с задержкой (сеть/DNS + AppUserModelId), далее по
    // интервалу (30 мин по умолчанию); при сбое — backoff внутри апдейтера (не ждём 30 мин).
    updater.startAutoChecks();
  }
  // Фокус окна / выход из сна / показ окна (`showStatusWindow`) / открытие меню
  // трея — перепроверяем обновление, если прошлая проверка устарела (15 мин,
  // in-flight guard внутри апдейтера).
  app.on('browser-window-focus', () => {
    updater?.recheckIfStale();
  });
  powerMonitor.on('resume', () => {
    updater?.recheckIfStale();
  });

  if (config.agentAutostart || showOnboarding) {
    // Первый запуск всегда показывает онбординг (вход → код → готово), поэтому
    // агент стартует и получает device-code, даже если автостарт выключен.
    startAgent();
  }
  if (agentRunning) void refreshAccount();
}

app.whenReady().then(
  () => {
    if (!gotSingleInstanceLock) return;
    // Linux/macOS: PowerMonitor 'shutdown' (на Windows — `session-end`).
    // Best-effort: у Electron 44 listener без `preventDefault`, ОС может
    // завершить процесс раньше финального flush.
    if (process.platform !== 'win32') {
      powerMonitor.on('shutdown', () => {
        void beginShutdown();
      });
    }
    // T-CLIENT3: у клиента нет строки меню — Alt ничего не открывает.
    removeApplicationMenu();
    void init().catch((error: unknown) => {
      logger.error('desktop init failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  },
  (error) => {
    logger.error('app failed to become ready', {
      error: error instanceof Error ? error.message : String(error),
    });
  },
);

app.on('window-all-closed', () => {
  // Трей-приложение: не выходим при закрытии окна.
});

let shutdownPromise: Promise<void> | null = null;

/**
 * CD-3.1/CD-3.7: единая graceful-остановка. Дожидается финального flush/
 * `complete` в agent-host (dispose ждёт `exit`, таймаут ≥ `shutdownFlushMs`).
 * Идемпотентна: повторные вызовы (session-end → before-quit) переиспользуют
 * одну операцию.
 */
function beginShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  statusWindow?.markQuitting();
  aboutWindow?.markQuitting();
  // W1b: глобальный hotkey больше не регистрируется; снимаем legacy-сочетание,
  // если оно осталось от прошлой версии.
  globalShortcut.unregisterAll();
  if (nativeThemeListener) {
    nativeTheme.removeListener('updated', nativeThemeListener);
    nativeThemeListener = null;
  }
  removeIpc();
  updater?.dispose();
  shutdownPromise = (manager?.dispose() ?? Promise.resolve()).catch((error: unknown) => {
    logger.warn('graceful shutdown failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return shutdownPromise;
}

app.on('before-quit', (event) => {
  if (shutdownPromise) return;
  event.preventDefault();
  void beginShutdown().finally(() => app.exit(0));
});

// Windows logoff/shutdown: ОС может прервать нас в любой момент — финальный
// flush делаем best-effort (CD-3.7), не блокируя завершение сеанса. Событие
// приходит на каждое BrowserWindow (в т.ч. созданное лениво — About).
app.on('browser-window-created', (_event, window) => {
  window.on('session-end', () => {
    void beginShutdown();
  });
});
