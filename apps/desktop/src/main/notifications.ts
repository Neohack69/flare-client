import type { AgentStatusEvent, DesktopLocale } from '@flightlog/contracts';
import { Notification } from 'electron';

import { getDesktopMessages, interpolate } from '../shared/i18n.js';
import type { NotificationPreferences } from './config.js';
import type { DeviceIssue } from './device-error.js';

/**
 * Windows-тосты клиента 0.2.0 (CD-4.1, ADR-0021 §4).
 *
 * Все тосты — `silent: true` (ноль звуков) и с анти-спамом:
 *   * касание с баллом/грейдом      — не чаще `TOUCHDOWN_MIN_INTERVAL_MS`
 *                                     и не повторно для той же посадки
 *                                     (`flightId:landingSeq`; без `landingSeq`
 *                                     — как раньше, дедуп по рейсу);
 *   * готовность обновления         — один раз на версию (только после
 *                                     скачивания: пока файл качается в фоне,
 *                                     пользователю ничего не показываем);
 *   * action-required (вход/лимит)  — не чаще `ACTION_REQUIRED_THROTTLE_MS`.
 *
 * Каждый повод можно выключить (`settings.notifications.*`); action-required
 * дополнительно управляется мастер-флагом «Предупреждать о потере авторизации».
 * Клик ведёт в нужный экран — маршрутизацию делает main по `NotificationTarget`.
 */

/** Троттл action-required: не чаще 1 раза в 24 ч. */
export const ACTION_REQUIRED_THROTTLE_MS = 24 * 60 * 60 * 1000;
/** Анти-спам касаний: не чаще 1 раза в 20 c (T&G, серии). */
export const TOUCHDOWN_MIN_INTERVAL_MS = 20 * 1000;
/** Проблема устройства (лимит/несовпадение): не чаще 1 раза в 24 ч. */
export const DEVICE_ISSUE_THROTTLE_MS = 24 * 60 * 60 * 1000;

/** Легаси-префа из `settings.json` (обратная совместимость). */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  touchdown: true,
  syncError: true,
  updates: true,
};

export type NotificationTarget =
  | { kind: 'action-required' }
  | { kind: 'touchdown'; flightId: string | null }
  | { kind: 'update-ready'; version: string }
  | { kind: DeviceIssue };

/**
 * Результат установки обновления (зеркало `InstallResult` из `updater.ts`;
 * локально, чтобы маршрутизация не зависела от electron-updater).
 */
export type UpdateInstallResult = 'no-update' | 'deferred' | 'installing';

/** Действия main, к которым ведёт клик по тосту (dependency injection). */
export interface NotificationActivateHandlers {
  showStatusWindow(): void;
  openSite(path: string): void;
}

/**
 * Клик по тосту → действие main (CD-4.1/CD-4.3). Вынесено из `index.ts`, чтобы
 * маршрутизация покрывалась детерминированными тестами без поднятия Electron.
 *
 * `update-ready`: клик открывает окно статуса (кнопка «Обновить» там ручная).
 * Установка по клику на тост больше не запускается.
 */
export function activateNotification(
  target: NotificationTarget,
  handlers: NotificationActivateHandlers,
): void {
  switch (target.kind) {
    case 'action-required':
      handlers.showStatusWindow();
      break;
    case 'update-ready':
      handlers.showStatusWindow();
      break;
    case 'touchdown':
      handlers.openSite(target.flightId ? `/flights/${target.flightId}` : '/flights');
      break;
    case 'device-limit':
    case 'machine-mismatch':
      handlers.openSite('/settings/devices');
      break;
    default:
      break;
  }
}

export interface ShownNotification {
  target: NotificationTarget;
  title: string;
  body: string;
}

/** Диагностика анти-спама: тост подавлен и почему (info-лог в `index.ts`). */
export interface SuppressedNotification {
  reason: 'dedupe' | 'throttle';
  flightId: string | null;
  landingSeq: number | null;
}

export interface NotifierOptions {
  onActivate?(target: NotificationTarget): void;
  /** Диагностика: уведомление реально показано (счётчик спама в smoke/verify). */
  onShown?(info: ShownNotification): void;
  /** Диагностика: тост подавлен анти-спамом (`dedupe`/`throttle`). */
  onSuppressed?(info: SuppressedNotification): void;
  /** Мастер-флаг action-required (default `true`). */
  enabled?(): boolean;
  /** Префы тостов из `settings.json` (default — всё включено). */
  preferences?(): NotificationPreferences;
  locale?(): DesktopLocale;
  /** Инъекция времени — детерминированные тесты троттла. */
  now?(): number;
}

export class Notifier {
  private lastActionRequiredAt = Number.NEGATIVE_INFINITY;
  private lastDeviceIssueAt = Number.NEGATIVE_INFINITY;
  private lastTouchdownAt = Number.NEGATIVE_INFINITY;
  private lastTouchdownKey: string | null = null;
  private lastUpdateVersion: string | null = null;

  constructor(private readonly options: NotifierOptions = {}) {}

  private enabled(): boolean {
    return this.options.enabled?.() ?? true;
  }

  private preferences(): NotificationPreferences {
    return this.options.preferences?.() ?? DEFAULT_NOTIFICATION_PREFERENCES;
  }

  private locale(): DesktopLocale {
    return this.options.locale?.() ?? 'ru';
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** События статуса: touchdown / fatal-вход. */
  onStatus(event: AgentStatusEvent): void {
    if (event.state === 'sync_error' && event.quality === 'fatal') {
      // `needsRepair` (MACHINE_MISMATCH) ведёт отдельный `deviceIssue`-тост с
      // инструкцией — не дублируем его action-required.
      if ((event as { needsRepair?: unknown }).needsRepair === true) return;
      const messages = getDesktopMessages(this.locale()).notifications;
      this.showActionRequired(messages.syncErrorFatalTitle, messages.syncErrorFatalBody);
      return;
    }
    if (event.state === 'touchdown') {
      this.onTouchdown(event);
    }
  }

  /**
   * Готовность обновления (файл уже скачан) — тост. Клик открывает окно
   * статуса; установка там запускается только вручную.
   */
  updateReady(version: string): void {
    if (!this.preferences().updates) return;
    if (version === this.lastUpdateVersion) return;
    this.lastUpdateVersion = version;
    const messages = getDesktopMessages(this.locale()).notifications;
    this.show(
      { kind: 'update-ready', version },
      messages.updateTitle,
      interpolate(messages.updateBodyReady, { version }),
    );
  }

  /** Fatal агента — только трей/окно, наружу молча. */
  agentStopped(_message: string | null): void {}

  /** Action-required: устройство требует входа/повторной авторизации. */
  deviceCodePending(code: string): void {
    const messages = getDesktopMessages(this.locale()).notifications;
    this.showActionRequired(
      messages.deviceCodeTitle,
      interpolate(messages.deviceCodeBody, { code }),
    );
  }

  /**
   * Проблема устройства (CD-4.3): 409 `DEVICE_LIMIT_REACHED` / `MACHINE_MISMATCH`.
   * Показывает понятную RU/EN-инструкцию; клик открывает `/settings/devices`.
   */
  deviceIssue(issue: DeviceIssue): void {
    const now = this.now();
    if (now - this.lastDeviceIssueAt < DEVICE_ISSUE_THROTTLE_MS) return;
    this.lastDeviceIssueAt = now;
    const messages = getDesktopMessages(this.locale()).notifications;
    const title =
      issue === 'device-limit' ? messages.deviceLimitTitle : messages.machineMismatchTitle;
    const body =
      issue === 'device-limit' ? messages.deviceLimitBody : messages.machineMismatchBody;
    this.show({ kind: issue }, title, body);
  }

  private onTouchdown(event: AgentStatusEvent): void {
    if (!this.preferences().touchdown) return;
    const flightId = event.clientFlightId ?? event.flightId ?? null;
    const landingSeq = event.landingSeq ?? null;
    // Дедуп по ПОСАДКЕ, не по рейсу: go-around → следующее касание (`landingSeq+1`)
    // обязано показать свой тост. `bounce` несёт тот же `landingSeq`, что и его
    // касание, поэтому остаётся подавленным. Без `landingSeq` — как раньше,
    // дедуп только по рейсу (легаси/дубликаты событий).
    const key =
      flightId == null ? null : landingSeq != null ? `${flightId}:${landingSeq}` : flightId;
    if (key != null && key === this.lastTouchdownKey) {
      this.options.onSuppressed?.({ reason: 'dedupe', flightId, landingSeq });
      return;
    }
    const now = this.now();
    if (now - this.lastTouchdownAt < TOUCHDOWN_MIN_INTERVAL_MS) {
      // Троттл гасит тост, но посадку всё равно запоминаем: `bounce` того же
      // касания (тот же `flightId:landingSeq`) не должен позже, когда окно
      // троттла истечёт, проскочить дедуп и показаться тостом «отскок».
      // `lastTouchdownAt` НЕ трогаем — тайминг окна троттла не меняется.
      this.lastTouchdownKey = key;
      this.options.onSuppressed?.({ reason: 'throttle', flightId, landingSeq });
      return;
    }
    this.lastTouchdownAt = now;
    this.lastTouchdownKey = key;

    const messages = getDesktopMessages(this.locale());
    const notification = messages.notifications;
    const grade = event.grade ? messages.status.lastLanding.grade[event.grade] : null;
    // score-preview.md §4: тост выходит сразу с клиентским баллом и меткой
    // «предварительно»; серверный балл догоняет окно статуса (тост не обновить).
    // Поле опционально: старые события его не несут → суффикса нет.
    const suffix =
      event.scorePreliminary === true ? notification.touchdownPreliminarySuffix : '';
    const title =
      grade && event.score != null
        ? `${interpolate(notification.touchdownTitle, { grade, score: event.score })}${suffix}`
        : notification.touchdownGenericTitle;
    const aircraft = event.aircraftIcao ?? '—';
    const fpm = event.vsFpm != null ? Math.round(event.vsFpm) : '—';
    const body =
      event.bounceCount && event.bounceCount > 0
        ? interpolate(notification.touchdownBounce, {
            aircraft,
            fpm,
            count: event.bounceCount,
          })
        : interpolate(notification.touchdownBody, { aircraft, fpm });
    this.show({ kind: 'touchdown', flightId }, title, body);
  }

  private showActionRequired(title: string, body: string): void {
    if (!this.enabled()) return;
    const now = this.now();
    if (now - this.lastActionRequiredAt < ACTION_REQUIRED_THROTTLE_MS) return;
    this.lastActionRequiredAt = now;
    this.show({ kind: 'action-required' }, title, body);
  }

  private show(target: NotificationTarget, title: string, body: string): void {
    if (!Notification.isSupported()) return;
    // `silent: true` — ноль звуков: клиент не должен беспокоить.
    const notification = new Notification({ title, body, silent: true });
    notification.on('click', () => this.options.onActivate?.(target));
    notification.show();
    this.options.onShown?.({ target, title, body });
  }
}
