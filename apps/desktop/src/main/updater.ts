import type { AgentLogger } from '@flightlog/agent';
import type { AppUpdater } from 'electron-updater';

import type { UpdateStatus } from '../shared/update-status.js';

/** Задержка первой авто-проверки: сеть/DNS и регистрация AppUserModelId успевают. */
export const DEFAULT_INITIAL_CHECK_DELAY_MS = 25_000;
/** Повторы после сбоя: 5 мин → 15 мин → обычный интервал (без «плотных» циклов). */
export const DEFAULT_BACKOFF_DELAYS_MS: readonly number[] = [5 * 60 * 1000, 15 * 60 * 1000];
/**
 * Фокус/resume/показ окна/меню трея: перепроверяем, если прошло больше
 * `focusRecheckMinIntervalMs`. 15 мин — чтобы свежий релиз всплывал при любом
 * взаимодействии, не дожидаясь 30-минутного периодического цикла.
 */
export const DEFAULT_FOCUS_RECHECK_MIN_INTERVAL_MS = 15 * 60 * 1000;
/** UPDATE-AUTO-INSTALL: пауза перед тихой установкой (сим может отключиться не сразу). */
export const AUTO_INSTALL_DELAY_MS = 10_000;

export interface UpdaterOptions {
  feedUrl: string | null;
  channel: 'latest' | 'beta';
  isPackaged: boolean;
  isRecording: () => boolean;
  /** UPDATE-AUTO-INSTALL: сим подключён (устанавливать нельзя — не мешаем полёту). */
  isSimConnected?(): boolean;
  logger: AgentLogger;
  /** Периодичность фоновых проверок (`config.updateCheckIntervalMs`). */
  intervalMs: number;
  /** UPDATE-AUTO-INSTALL: версия уже скачана до старта (тесты/восстановление). */
  initialReadyVersion?: string | null;
  /** Опционально: задержка первой авто-проверки после старта. */
  initialDelayMs?: number;
  /** Опционально: задержки повторов после сбоя (по умолчанию `DEFAULT_BACKOFF_DELAYS_MS`). */
  backoffDelaysMs?: readonly number[];
  /** Опционально: минимальный интервал между проверками по фокусу/resume. */
  focusRecheckMinIntervalMs?: number;
  /** Инъекция времени (детерминированные тесты). */
  now?(): number;
  /** Инъекция таймера (детерминированные тесты). */
  setTimer?(callback: () => void, delayMs: number): unknown;
  /** Инъекция отмены таймера (детерминированные тесты). */
  clearTimer?(handle: unknown): void;
  onUpdateReady(version: string): void;
  /** FIX-UPDATE-CHECK-FEEDBACK: структурированный статус проверки для UI. */
  onStatus?(status: UpdateStatus): void;
  onStatusText?(text: string): void;
}

export type InstallResult = 'no-update' | 'deferred' | 'installing';
export type AutoInstallState = 'none' | 'deferred' | 'scheduled';

/**
 * Чистая функция следующего интервала фоновой проверки. Пока есть подряд идущие
 * сбои — берём backoff (`5 мин`, `15 мин`), иначе — обычный интервал. За
 * пределами списка backoff возвращаем базовый интервал (bound, без зацикливания).
 */
export function nextCheckDelayMs(
  consecutiveFailures: number,
  baseIntervalMs: number,
  backoffDelaysMs: readonly number[] = DEFAULT_BACKOFF_DELAYS_MS,
): number {
  if (consecutiveFailures <= 0) return baseIntervalMs;
  const index = consecutiveFailures - 1;
  const delay = backoffDelaysMs[index];
  return delay === undefined ? baseIntervalMs : delay;
}

/** Чистое решение «пора ли перепроверить по фокусу/resume» (последняя проверка устарела). */
export function shouldRecheckOnFocus(
  lastCheckAt: number | null,
  now: number,
  minIntervalMs: number,
): boolean {
  if (lastCheckAt === null) return true;
  return now - lastCheckAt >= minIntervalMs;
}

function defaultSetTimer(callback: () => void, delayMs: number): unknown {
  const handle = setTimeout(callback, delayMs);
  // Не держим event loop узла: жизнью процесса управляет Electron.
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/**
 * `electron-updater` generic-feed (ADR-0011 §8.3). Установка **откладывается**,
 * пока агент в состоянии `recording`: нельзя прерывать активный полёт.
 *
 * Авто-проверки идут не мгновенно после старта, а с небольшой задержкой
 * (`initialDelayMs`), и повторяются с backoff при сбое — чтобы сетевой/DNS-сбой
 * на старте не откладывал проверку на весь `intervalMs` (30 мин).
 */
export class DesktopUpdater {
  private updater: AppUpdater | null = null;
  private downloadedVersion: string | null = null;
  private lastCheckAt: number | null = null;
  private consecutiveFailures = 0;
  private checkInFlight = false;
  private autoEnabled = false;
  private autoTimer: unknown = null;
  /** UPDATE-AUTO-INSTALL: таймер тихой установки (10 c) и анти-спам лога. */
  private autoInstallTimer: unknown = null;
  private autoInstallDeferredLogged = false;

  constructor(private readonly options: UpdaterOptions) {
    this.downloadedVersion = options.initialReadyVersion ?? null;
  }

  get readyVersion(): string | null {
    return this.downloadedVersion;
  }

  async setup(): Promise<void> {
    if (!this.options.isPackaged || !this.options.feedUrl) {
      this.options.logger.info('auto-update disabled', {
        reason: this.options.isPackaged ? 'no feed url' : 'not packaged',
      });
      return;
    }
    // electron-updater — CommonJS. При `await import()` Node может не выставить
    // `autoUpdater` как named export (модуль реэкспортирует его динамически,
    // cjs-lexer его не видит) → `autoUpdater` = undefined и упакованный клиент
    // падал: «Cannot set properties of undefined (setting 'autoDownload')».
    // Берём named export, иначе — из default (module.exports). Это и делает
    // автообновление РЕАЛЬНО работающим в prod-сборке (T-DEP4).
    const mod = (await import('electron-updater')) as unknown as {
      autoUpdater?: AppUpdater;
      default?: { autoUpdater?: AppUpdater };
    };
    const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater;
    if (!autoUpdater) {
      this.options.logger.error('auto-update unavailable', {
        reason: 'electron-updater export not resolved',
      });
      return;
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = this.options.channel === 'beta';
    autoUpdater.channel = this.options.channel;
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: this.options.feedUrl,
      channel: this.options.channel,
    });
    autoUpdater.on('error', (error) => {
      this.options.logger.warn('auto-update error', { error: error.message });
      this.emitStatus({ kind: 'error', message: error.message });
    });
    autoUpdater.on('checking-for-update', () => this.emitStatus({ kind: 'checking' }));
    autoUpdater.on('update-available', (info) => {
      this.options.logger.info('update available', { version: info.version });
      this.emitStatus({ kind: 'available', version: info.version });
    });
    autoUpdater.on('update-not-available', () => {
      this.options.logger.debug('no update available');
      this.emitStatus({ kind: 'not-available' });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.downloadedVersion = info.version;
      this.options.logger.info('update ready', { version: info.version });
      this.emitStatus({ kind: 'downloaded', version: info.version });
      this.options.onUpdateReady(info.version);
      this.scheduleAutoInstall();
    });
    this.updater = autoUpdater;
    // UPDATE-AUTO-INSTALL: версия, уже готовая к установке на старте.
    this.scheduleAutoInstall();
  }

  /**
   * Запускает фоновые авто-проверки: первая — через `initialDelayMs` (сеть/DNS и
   * AppUserModelId готовы), далее с `intervalMs`; при сбое — с backoff.
   */
  startAutoChecks(): void {
    if (!this.updater) return;
    this.autoEnabled = true;
    this.scheduleNext(this.options.initialDelayMs ?? DEFAULT_INITIAL_CHECK_DELAY_MS);
  }

  /**
   * Проверка по возврату фокуса/из сна: только если прошлый раз был больше
   * `focusRecheckMinIntervalMs` назад и сейчас нет проверки в полёте.
   * Возвращает `true`, если проверка действительно запущена.
   */
  recheckIfStale(): boolean {
    if (!this.updater || this.checkInFlight) return false;
    const minInterval =
      this.options.focusRecheckMinIntervalMs ?? DEFAULT_FOCUS_RECHECK_MIN_INTERVAL_MS;
    if (!shouldRecheckOnFocus(this.lastCheckAt, this.now(), minInterval)) return false;
    this.check();
    return true;
  }

  /** Отменяет запланированные авто-проверку и авто-установку (вызывается на выходе). */
  dispose(): void {
    this.autoEnabled = false;
    this.clearScheduled();
    this.cancelAutoInstall('dispose');
  }

  check(): void {
    const updater = this.updater;
    if (!updater) {
      // Видимый результат даже без настроенного автообновления (dev/offline):
      // иначе кнопка «Проверить обновления» молчит.
      this.options.logger.warn('checkForUpdates skipped', { reason: 'auto-update unavailable' });
      this.emitStatus({ kind: 'error', message: 'auto-update unavailable' });
      return;
    }
    this.lastCheckAt = this.now();
    this.checkInFlight = true;
    void updater.checkForUpdates().then(
      () => this.onCheckSettled(true),
      (error: unknown) => {
        // `error`-событие уже эмитится самим updater'ом (и даёт статус в UI),
        // здесь только лог + планирование повтора — без дублирования статуса.
        this.options.logger.warn('checkForUpdates failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.onCheckSettled(false);
      },
    );
  }

  install(): InstallResult {
    const updater = this.updater;
    if (!updater || !this.downloadedVersion) return 'no-update';
    if (this.options.isRecording()) {
      // Лог, не UI: локаль здесь не применяется (текст пользователю даёт i18n).
      this.options.onStatusText?.('update deferred until the flight ends');
      return 'deferred';
    }
    // Ручная установка должна вести себя как «тихий» путь `autoInstallOnAppQuit`
    // (без NSIS-мастера «запускается установщик пакетов»). Семантика аргументов
    // electron-updater 6.8.9:
    //   isSilent=true      → `BaseUpdater.quitAndInstall` вызывает
    //                        `install(isSilent, …)` → `NsisUpdater.doInstall`
    //                        добавляет инсталлятору NSIS-флаг `/S` (silent);
    //   isForceRunAfter=true → `doInstall` добавляет `--force-run`: silent-установка
    //                        сама приложение не запускает, флаг его перезапускает.
    // Без аргументов (`quitAndInstall()`) isSilent=false → при нашем
    // `nsis.oneClick:false` (electron-builder.yml) открывается assisted-мастер.
    // Источник: node_modules/electron-updater/out/BaseUpdater.js:13-16,
    // NsisUpdater.js `doInstall` (`if (options.isSilent) args.push('/S')`,
    // `if (options.isForceRunAfter) args.push('--force-run')`).
    // Установка per-user (`nsis.perMachine:false`) → без UAC/elevate.
    updater.quitAndInstall(true, true);
    return 'installing';
  }

  /**
   * UPDATE-AUTO-INSTALL: планирует тихую установку, если скачанное обновление
   * есть и сим/запись не активны. Пока идёт полёт — deferred (лог один раз).
   * Таймер 10 c даёт шанс не оборвать сессию на границе touchdown/recording.
   */
  scheduleAutoInstall(): AutoInstallState {
    const version = this.downloadedVersion;
    if (!version) return 'none';
    if (this.autoInstallTimer !== null) return 'scheduled';
    if (!this.isIdle()) {
      if (!this.autoInstallDeferredLogged) {
        this.autoInstallDeferredLogged = true;
        this.options.logger.info('auto-install deferred', {
          version,
          reason: this.options.isRecording() ? 'recording' : 'sim-connected',
        });
      }
      return 'deferred';
    }
    this.autoInstallDeferredLogged = false;
    const setTimer = this.options.setTimer ?? defaultSetTimer;
    this.autoInstallTimer = setTimer(() => {
      this.autoInstallTimer = null;
      this.runAutoInstall();
    }, AUTO_INSTALL_DELAY_MS);
    this.options.logger.info('auto-install scheduled', {
      version,
      delayMs: AUTO_INSTALL_DELAY_MS,
    });
    return 'scheduled';
  }

  /**
   * UPDATE-AUTO-INSTALL: вызывается на каждом статусе (после обновления
   * `simConnected`/`recording`). Отменяет таймер, если начался полёт, и
   * перепланирует установку, когда сим снова свободен.
   */
  retryAutoInstall(): void {
    if (!this.downloadedVersion) return;
    if (this.autoInstallTimer !== null) {
      if (!this.isIdle()) this.cancelAutoInstall('flight-started');
      return;
    }
    this.scheduleAutoInstall();
  }

  private isIdle(): boolean {
    return !this.options.isRecording() && !(this.options.isSimConnected?.() ?? false);
  }

  private runAutoInstall(): void {
    const version = this.downloadedVersion;
    if (!version) return;
    if (!this.isIdle()) {
      this.autoInstallDeferredLogged = true;
      this.options.logger.info('auto-install cancelled', {
        version,
        reason: this.options.isRecording() ? 'recording' : 'sim-connected',
      });
      return;
    }
    this.options.logger.info('auto-install started', { version });
    const result = this.install();
    if (result === 'deferred') {
      this.options.logger.info('auto-install deferred', {
        version,
        reason: 'recording',
      });
      this.autoInstallDeferredLogged = true;
    }
  }

  private cancelAutoInstall(reason: string): void {
    if (this.autoInstallTimer === null) return;
    const clearTimer = this.options.clearTimer ?? defaultClearTimer;
    clearTimer(this.autoInstallTimer);
    this.autoInstallTimer = null;
    this.autoInstallDeferredLogged = true;
    if (this.downloadedVersion) {
      this.options.logger.info('auto-install cancelled', {
        version: this.downloadedVersion,
        reason,
      });
    }
  }

  private onCheckSettled(ok: boolean): void {
    this.checkInFlight = false;
    this.consecutiveFailures = ok ? 0 : this.consecutiveFailures + 1;
    if (!this.autoEnabled) return;
    const delay = nextCheckDelayMs(
      this.consecutiveFailures,
      this.options.intervalMs,
      this.options.backoffDelaysMs ?? DEFAULT_BACKOFF_DELAYS_MS,
    );
    if (!ok) {
      this.options.logger.info('auto-update retry scheduled', {
        attempt: this.consecutiveFailures,
        delayMs: delay,
      });
    }
    this.scheduleNext(delay);
  }

  private scheduleNext(delayMs: number): void {
    this.clearScheduled();
    const setTimer = this.options.setTimer ?? defaultSetTimer;
    this.autoTimer = setTimer(() => {
      this.autoTimer = null;
      this.check();
    }, delayMs);
  }

  private clearScheduled(): void {
    if (this.autoTimer === null) return;
    const clearTimer = this.options.clearTimer ?? defaultClearTimer;
    clearTimer(this.autoTimer);
    this.autoTimer = null;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private emitStatus(status: UpdateStatus): void {
    this.options.onStatus?.(status);
  }
}
