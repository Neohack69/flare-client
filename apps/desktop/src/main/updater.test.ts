import type { AgentLogger } from '@flightlog/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateStatus } from '../shared/update-status.js';
import {
  AUTO_INSTALL_DELAY_MS,
  DEFAULT_FOCUS_RECHECK_MIN_INTERVAL_MS,
  DesktopUpdater,
  nextCheckDelayMs,
  shouldRecheckOnFocus,
  type UpdaterOptions,
} from './updater.js';

/**
 * FIX-UPDATE-CHECK-FEEDBACK: статус-флоу проверки обновлений.
 * Реальный апдейт/сеть не трогаем — `electron-updater` замокан.
 */
const updaterMock = vi.hoisted(() => {
  class FakeAutoUpdater {
    autoDownload = false;
    autoInstallOnAppQuit = false;
    allowPrerelease = false;
    channel = '';
    feedUrl: unknown = null;
    listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    checkForUpdates = vi.fn(async () => null);
    quitAndInstall = vi.fn();
    setFeedURL = vi.fn((config: unknown) => {
      this.feedUrl = config;
    });
    on(event: string, listener: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }
  return { instance: new FakeAutoUpdater() };
});

vi.mock('electron-updater', () => ({
  autoUpdater: updaterMock.instance,
  default: { autoUpdater: updaterMock.instance },
}));

function makeOptions(overrides: Partial<UpdaterOptions> = {}) {
  const statuses: UpdateStatus[] = [];
  const ready: string[] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as AgentLogger;
  const options: UpdaterOptions = {
    feedUrl: 'https://updates.example.com',
    channel: 'latest',
    isPackaged: true,
    isRecording: () => false,
    isSimConnected: () => false,
    logger,
    intervalMs: 6 * 60 * 60 * 1000,
    onUpdateReady: (version) => ready.push(version),
    onStatus: (status) => statuses.push(status),
    ...overrides,
  };
  return { options, statuses, ready, logger };
}

/** Детерминированный клок+таймеры; реальные таймеры не используются. */
function makeFakeTimers() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer(callback: () => void, delayMs: number): unknown {
      const id = ++seq;
      timers.set(id, { at: now + delayMs, fn: callback });
      return id;
    },
    clearTimer(handle: unknown): void {
      timers.delete(handle as number);
    },
    advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    nextDelay(): number | null {
      let min: number | null = null;
      for (const timer of timers.values()) {
        const delay = timer.at - now;
        if (min === null || delay < min) min = delay;
      }
      return min;
    },
    pendingCount(): number {
      return timers.size;
    },
  };
}

/** Прогон микротасков после `advance` (promise checkForUpdates → планирование). */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('DesktopUpdater — статус проверки обновлений (FIX-UPDATE-CHECK-FEEDBACK)', () => {
  const fake = updaterMock.instance;

  beforeEach(() => {
    fake.listeners.clear();
    fake.autoDownload = false;
    fake.autoInstallOnAppQuit = false;
    fake.allowPrerelease = false;
    fake.channel = '';
    fake.feedUrl = null;
    fake.checkForUpdates.mockClear();
    fake.quitAndInstall.mockClear();
    fake.setFeedURL.mockClear();
  });

  it('setup не меняет автозагрузку/автоустановку и настраивает generic-feed', async () => {
    const { options } = makeOptions();
    await new DesktopUpdater(options).setup();
    expect(fake.autoDownload).toBe(true);
    expect(fake.autoInstallOnAppQuit).toBe(true);
    expect(fake.channel).toBe('latest');
    expect(fake.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://updates.example.com',
      channel: 'latest',
    });
  });

  it('checking-for-update → status checking', async () => {
    const { options, statuses } = makeOptions();
    await new DesktopUpdater(options).setup();
    fake.emit('checking-for-update');
    expect(statuses).toContainEqual({ kind: 'checking' });
  });

  it('update-not-available → status not-available', async () => {
    const { options, statuses } = makeOptions();
    await new DesktopUpdater(options).setup();
    fake.emit('update-not-available', { version: '0.0.1' });
    expect(statuses).toContainEqual({ kind: 'not-available' });
  });

  it('update-available → status available с версией', async () => {
    const { options, statuses } = makeOptions();
    await new DesktopUpdater(options).setup();
    fake.emit('update-available', { version: '1.2.3' });
    expect(statuses).toContainEqual({ kind: 'available', version: '1.2.3' });
  });

  it('update-downloaded → status downloaded + onUpdateReady (без изменений)', async () => {
    const { options, statuses, ready } = makeOptions();
    const updater = new DesktopUpdater(options);
    await updater.setup();
    fake.emit('update-downloaded', { version: '1.2.3' });
    expect(statuses).toContainEqual({ kind: 'downloaded', version: '1.2.3' });
    expect(ready).toEqual(['1.2.3']);
    expect(updater.readyVersion).toBe('1.2.3');
  });

  it('error → status error с сообщением', async () => {
    const { options, statuses } = makeOptions();
    await new DesktopUpdater(options).setup();
    fake.emit('error', new Error('boom'));
    expect(statuses).toContainEqual({ kind: 'error', message: 'boom' });
  });

  it('check() без настроенного апдейтера даёт видимый error, а не молчание', async () => {
    const { options, statuses } = makeOptions({ isPackaged: false, feedUrl: null });
    const updater = new DesktopUpdater(options);
    await updater.setup();
    updater.check();
    expect(statuses).toEqual([{ kind: 'error', message: 'auto-update unavailable' }]);
  });

  it('check() передаёт ошибку сети через error-событие', async () => {
    const { options, statuses } = makeOptions();
    const updater = new DesktopUpdater(options);
    await updater.setup();
    fake.checkForUpdates.mockImplementationOnce(async () => {
      fake.emit('error', new Error('offline'));
      throw new Error('offline');
    });
    updater.check();
    await Promise.resolve();
    expect(statuses).toContainEqual({ kind: 'error', message: 'offline' });
  });

  it('install при записи откладывается и не вызывает quitAndInstall', async () => {
    const { options } = makeOptions({ isRecording: () => true });
    const updater = new DesktopUpdater(options);
    await updater.setup();
    fake.emit('update-downloaded', { version: '1.2.3' });
    expect(updater.install()).toBe('deferred');
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it('install без загруженного обновления → no-update (quitAndInstall не вызывается)', async () => {
    const { options } = makeOptions();
    const updater = new DesktopUpdater(options);
    await updater.setup();
    expect(updater.install()).toBe('no-update');
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it('SILENT-MANUAL-INSTALL: install после загрузки → quitAndInstall(true, true)', async () => {
    const { options } = makeOptions();
    const updater = new DesktopUpdater(options);
    await updater.setup();
    fake.emit('update-downloaded', { version: '1.2.3' });
    expect(updater.install()).toBe('installing');
    // isSilent=true (NSIS `/S`, без мастера) + isForceRunAfter=true (`--force-run`).
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true);
  });
});

describe('DesktopUpdater — расписание/backoff/фокус (DECISION-логика)', () => {
  it('T-UPD-CADENCE: staleness-интервал фокус/взаимодействие = 15 мин', () => {
    expect(DEFAULT_FOCUS_RECHECK_MIN_INTERVAL_MS).toBe(15 * 60 * 1000);
  });

  it('nextCheckDelayMs: backoff 5/15 мин, затем базовый интервал', () => {
    expect(nextCheckDelayMs(0, 100, [5, 15])).toBe(100);
    expect(nextCheckDelayMs(1, 100, [5, 15])).toBe(5);
    expect(nextCheckDelayMs(2, 100, [5, 15])).toBe(15);
    expect(nextCheckDelayMs(3, 100, [5, 15])).toBe(100);
  });

  it('shouldRecheckOnFocus: null/устарело → true, свежее → false', () => {
    expect(shouldRecheckOnFocus(null, 1_000, 500)).toBe(true);
    expect(shouldRecheckOnFocus(1_000, 1_400, 500)).toBe(false);
    expect(shouldRecheckOnFocus(1_000, 1_500, 500)).toBe(true);
  });
});

describe('DesktopUpdater — авто-установка при простое (UPDATE-AUTO-INSTALL)', () => {
  const fake = updaterMock.instance;

  beforeEach(() => {
    fake.listeners.clear();
    fake.checkForUpdates.mockClear();
    fake.checkForUpdates.mockResolvedValue(null);
    fake.quitAndInstall.mockClear();
    fake.setFeedURL.mockClear();
  });

  it('idle: после update-downloaded ставит через 10 c (silent quitAndInstall)', async () => {
    const clock = makeFakeTimers();
    const { options, logger } = makeOptions({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const updater = new DesktopUpdater(options);
    await updater.setup();
    fake.emit('update-downloaded', { version: '1.2.3' });

    expect(clock.nextDelay()).toBe(AUTO_INSTALL_DELAY_MS);
    clock.advance(AUTO_INSTALL_DELAY_MS - 1);
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    clock.advance(1);

    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(logger.info).toHaveBeenCalledWith('auto-install scheduled', {
      version: '1.2.3',
      delayMs: AUTO_INSTALL_DELAY_MS,
    });
    expect(logger.info).toHaveBeenCalledWith('auto-install started', { version: '1.2.3' });
  });

  it('recording: установка отложена, таймера нет', async () => {
    const clock = makeFakeTimers();
    const { options, logger } = makeOptions({
      isRecording: () => true,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const updater = new DesktopUpdater(options);
    await updater.setup();
    fake.emit('update-downloaded', { version: '1.2.3' });

    expect(clock.pendingCount()).toBe(0);
    clock.advance(AUTO_INSTALL_DELAY_MS);
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('auto-install deferred', {
      version: '1.2.3',
      reason: 'recording',
    });
  });

  it('сим подключён: установка отложена; после отключения — ставится', async () => {
    let simConnected = true;
    const clock = makeFakeTimers();
    const { options } = makeOptions({
      isSimConnected: () => simConnected,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const updater = new DesktopUpdater(options);
    await updater.setup();
    fake.emit('update-downloaded', { version: '1.2.3' });

    clock.advance(AUTO_INSTALL_DELAY_MS);
    expect(fake.quitAndInstall).not.toHaveBeenCalled();

    simConnected = false;
    updater.retryAutoInstall();
    expect(clock.nextDelay()).toBe(AUTO_INSTALL_DELAY_MS);
    clock.advance(AUTO_INSTALL_DELAY_MS);
    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('сим подключается в окне 10 c → cancelled; позже — снова scheduled', async () => {
    let simConnected = false;
    const clock = makeFakeTimers();
    const { options, logger } = makeOptions({
      isSimConnected: () => simConnected,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const updater = new DesktopUpdater(options);
    await updater.setup();
    fake.emit('update-downloaded', { version: '1.2.3' });
    expect(clock.nextDelay()).toBe(AUTO_INSTALL_DELAY_MS);

    clock.advance(3_000);
    simConnected = true;
    updater.retryAutoInstall();
    expect(clock.pendingCount()).toBe(0);
    expect(logger.info).toHaveBeenCalledWith('auto-install cancelled', {
      version: '1.2.3',
      reason: 'flight-started',
    });

    clock.advance(AUTO_INSTALL_DELAY_MS);
    expect(fake.quitAndInstall).not.toHaveBeenCalled();

    simConnected = false;
    updater.retryAutoInstall();
    clock.advance(AUTO_INSTALL_DELAY_MS);
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('началась запись в окне 10 c → cancelled, установки нет', async () => {
    let recording = false;
    const clock = makeFakeTimers();
    const { options } = makeOptions({
      isRecording: () => recording,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const updater = new DesktopUpdater(options);
    await updater.setup();
    fake.emit('update-downloaded', { version: '1.2.3' });

    recording = true;
    updater.retryAutoInstall();
    clock.advance(AUTO_INSTALL_DELAY_MS);
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it('старт с готовой версией (readyVersion) → scheduled и установка', async () => {
    const clock = makeFakeTimers();
    const { options } = makeOptions({
      initialReadyVersion: '1.2.3',
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const updater = new DesktopUpdater(options);
    await updater.setup();

    expect(updater.readyVersion).toBe('1.2.3');
    expect(clock.nextDelay()).toBe(AUTO_INSTALL_DELAY_MS);
    clock.advance(AUTO_INSTALL_DELAY_MS);
    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('без готовой версии — nothing to install', async () => {
    const clock = makeFakeTimers();
    const { options } = makeOptions({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const updater = new DesktopUpdater(options);
    await updater.setup();
    expect(updater.scheduleAutoInstall()).toBe('none');
    expect(clock.pendingCount()).toBe(0);
  });

  it('ручная установка при подключённом симе продолжает работать', async () => {
    const clock = makeFakeTimers();
    const { options } = makeOptions({
      isSimConnected: () => true,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const updater = new DesktopUpdater(options);
    await updater.setup();
    fake.emit('update-downloaded', { version: '1.2.3' });
    expect(updater.install()).toBe('installing');
    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('dispose отменяет запланированную авто-установку', async () => {
    const clock = makeFakeTimers();
    const { options } = makeOptions({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const updater = new DesktopUpdater(options);
    await updater.setup();
    fake.emit('update-downloaded', { version: '1.2.3' });
    expect(clock.pendingCount()).toBe(1);

    updater.dispose();
    clock.advance(AUTO_INSTALL_DELAY_MS);
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe('DesktopUpdater — авто-проверки (startAutoChecks)', () => {
  const fake = updaterMock.instance;

  beforeEach(() => {
    fake.listeners.clear();
    fake.checkForUpdates.mockClear();
    fake.checkForUpdates.mockResolvedValue(null);
    fake.quitAndInstall.mockClear();
    fake.setFeedURL.mockClear();
  });

  it('первая проверка НЕ мгновенная: только после initialDelay', async () => {
    const clock = makeFakeTimers();
    const { options } = makeOptions({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      initialDelayMs: 25_000,
    });
    const updater = new DesktopUpdater(options);
    await updater.setup();
    updater.startAutoChecks();

    expect(fake.checkForUpdates).not.toHaveBeenCalled();
    clock.advance(24_999);
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
    clock.advance(1);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    // Успех → следующая проверка через базовый интервал.
    expect(clock.nextDelay()).toBe(options.intervalMs);
  });

  it('сбой → повтор 5 мин, затем 15 мин, затем базовый интервал; успех сбрасывает backoff', async () => {
    const clock = makeFakeTimers();
    const { options } = makeOptions({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      initialDelayMs: 0,
    });
    const updater = new DesktopUpdater(options);
    await updater.setup();

    fake.checkForUpdates.mockRejectedValue(new Error('offline'));
    updater.startAutoChecks();

    clock.advance(0);
    await flushMicrotasks();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(clock.nextDelay()).toBe(5 * 60 * 1000);

    clock.advance(5 * 60 * 1000);
    await flushMicrotasks();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(clock.nextDelay()).toBe(15 * 60 * 1000);

    clock.advance(15 * 60 * 1000);
    await flushMicrotasks();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(3);
    expect(clock.nextDelay()).toBe(options.intervalMs);

    // Успешная проверка после сбоев возвращает обычную периодичность.
    fake.checkForUpdates.mockResolvedValue(null);
    clock.advance(options.intervalMs);
    await flushMicrotasks();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(4);
    expect(clock.nextDelay()).toBe(options.intervalMs);
  });

  it('recheckIfStale: свежую проверку не повторяет, а старше 15 мин — повторяет', async () => {
    const clock = makeFakeTimers();
    const { options } = makeOptions({ now: clock.now });
    const updater = new DesktopUpdater(options);
    await updater.setup();

    // Ни разу не проверяли → stale.
    expect(updater.recheckIfStale()).toBe(true);
    await flushMicrotasks();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);

    // Сразу после проверки — не stale.
    expect(updater.recheckIfStale()).toBe(false);
    clock.advance(14 * 60 * 1000);
    expect(updater.recheckIfStale()).toBe(false);

    // Больше 15 мин — снова stale (граница нового интервала).
    clock.advance(1 * 60 * 1000);
    expect(updater.recheckIfStale()).toBe(true);
    await flushMicrotasks();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('recheckIfStale: пока проверка в полёте, повтор не запускается (in-flight guard)', async () => {
    // checkForUpdates висит незавершённым → checkInFlight остаётся true.
    const pending: { resolve: (() => void) | null } = { resolve: null };
    fake.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          pending.resolve = () => resolve(null);
        }),
    );

    const clock = makeFakeTimers();
    const { options } = makeOptions({ now: clock.now });
    const updater = new DesktopUpdater(options);
    await updater.setup();

    updater.check();
    // Даже если прошлая проверка формально устарела, in-flight guard не даёт
    // запустить вторую параллельно.
    clock.advance(60 * 60 * 1000);
    expect(updater.recheckIfStale()).toBe(false);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);

    pending.resolve?.();
    await flushMicrotasks();
  });

  it('dispose отменяет запланированную авто-проверку', async () => {
    const clock = makeFakeTimers();
    const { options } = makeOptions({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      initialDelayMs: 25_000,
    });
    const updater = new DesktopUpdater(options);
    await updater.setup();
    updater.startAutoChecks();
    expect(clock.pendingCount()).toBe(1);

    updater.dispose();
    expect(clock.pendingCount()).toBe(0);
    clock.advance(60 * 60 * 1000);
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
  });
});
