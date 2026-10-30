import {
  agentStatusMap,
  resolveStatusKind,
  type AgentMePlan,
  type AgentStatusEvent,
  type AgentStatusKind,
  type DesktopLocale,
  type DesktopOutboxCounts,
} from '@flightlog/contracts';
import {
  Menu,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';

import {
  formatClock,
  formatTrayTooltip,
  getDesktopMessages,
  interpolate,
  statusLabel,
} from '../shared/i18n.js';
import { planTrayPrefix } from '../shared/plan.js';
import type { NotificationPreferences } from './config.js';
import type { SimSourceKind } from './sim-source-status.js';
import {
  renderTrayBitmap,
  TRAY_STATE_COLORS,
  type TrayIconVariant,
  type TrayState,
} from './tray-icons.js';

export interface TrayCallbacks {
  onOpenStatus(): void;
  /**
   * Tray-меню открыто (Windows: right-click показывает контекстное меню).
   * Дешёвый сигнал «пользователь взаимодействует»: перепроверить обновление,
   * если прошлая проверка устарела (`DesktopUpdater.recheckIfStale`).
   */
  onMenuOpen(): void;
  onOpenSite(path?: string): void;
  onToggleAgent(): void;
  onSyncNow(): void;
  onCheckUpdates(): void;
  onInstallUpdate(): void;
  onAbout(): void;
  onQuit(): void;
  onToggleAutostart(enabled: boolean): void;
  /** Единственное OS-уведомление: предупреждать о потере авторизации. */
  onToggleAuthAlerts(enabled: boolean): void;
  /** CD-4.1: вкл/выкл отдельных Windows-тостов. */
  onToggleNotification(kind: keyof NotificationPreferences, enabled: boolean): void;
  /** T-CLIENT2: скопировать user_code в буфер обмена. */
  onCopyUserCode(): void;
  /** T-CLIENT2: подтверждение устройства — во внешнем браузере (вручную). */
  onOpenDeviceInBrowser(): void;
  /** T-CLIENT3: явный выбор языка из подменю трея (RU/EN). */
  onSetLocale(locale: DesktopLocale): void;
}

export interface TrayStateSnapshot {
  agentRunning: boolean;
  recording: boolean;
  autostart: boolean;
  /** Трей-тумблер action-required «потеря авторизации» (default true). */
  authAlerts: boolean;
  /** CD-4.1: префы тостов (touchdown/syncError/updates). */
  notifications: NotificationPreferences;
  updateReady: string | null;
  locale: DesktopLocale;
  /** ADR-0023: отображаемый источник телеметрии (read-only, без управления). */
  simSource: SimSourceKind;
  /** T117: вариант глифа под тему ОС. */
  iconVariant: TrayIconVariant;
  /** T118: акселератор hotkey для показа в меню/About (только для чтения). */
  openStatusAccelerator: string | null;
  /** F2: известный план для префикса статус-строки меню. */
  plan?: AgentMePlan | null;
}

type TrayDiagnostics = {
  __flightlogTrayCreated?: boolean;
  __flightlogTrayState?: TrayState;
  __flightlogTrayTooltip?: string;
  __flightlogTrayIconBytes?: number;
  __flightlogTrayVariant?: TrayIconVariant;
  __flightlogTrayIconPng?: string;
  /** T-CLIENT3: подписи текущего контекстного меню трея (для QA языка). */
  __flightlogTrayMenuLabels?: string[];
  /** T-CLIENT3: акселераторы текущего меню трея (для QA). */
  __flightlogTrayAccelerators?: string[];
};

/** Событие агента + рантайм-флаги → состояние трея (единый `resolveStatusKind`). */
export function deriveTrayState(
  status: AgentStatusEvent | null,
  agentRunning: boolean,
  recording: boolean,
  agentError: boolean,
): TrayState {
  const kind = resolveStatusKind(status, { agentRunning, recording, agentError });
  return kind === 'sync_error_fatal' ? 'sync_error' : kind;
}

/**
 * Трей: статус-иконка с точкой, меню управления и тултип (ADR-0011 §6.2,
 * desktop-client.md §3–§4). Палитра/иконки — только из `agentStatusMap`.
 */
export class TrayController {
  private tray: Tray | null = null;
  private status: AgentStatusEvent | null = null;
  private outbox: DesktopOutboxCounts | null = null;
  private agentError = false;
  private agentRunning = false;
  private recording = false;
  private authAlerts: boolean;
  private notifications: NotificationPreferences;
  private userCode: string | null = null;
  private userCodeExpiresAt: number | null = null;
  private iconVariant: TrayIconVariant;
  private simSourceKind: SimSourceKind;
  private plan: AgentMePlan | null;
  private readonly icons = new Map<string, NativeImage>();

  constructor(
    private readonly callbacks: TrayCallbacks,
    private state: TrayStateSnapshot,
  ) {
    this.agentRunning = state.agentRunning;
    this.recording = state.recording;
    this.authAlerts = state.authAlerts;
    this.notifications = state.notifications;
    this.iconVariant = state.iconVariant;
    this.simSourceKind = state.simSource;
    this.plan = state.plan ?? null;
  }

  create(): void {
    const state = this.currentState();
    const icon = this.icon(state);
    this.tray = new Tray(icon);
    this.tray.on('click', () => this.callbacks.onOpenStatus());
    // Правая кнопка на Windows показывает контекстное меню трея — используем
    // это как дешёвый триггер перепроверки обновления (не чаще интервала stale).
    this.tray.on('right-click', () => this.callbacks.onMenuOpen());
    const diagnostics = globalThis as TrayDiagnostics;
    diagnostics.__flightlogTrayCreated = true;
    diagnostics.__flightlogTrayVariant = this.iconVariant;
    diagnostics.__flightlogTrayIconBytes = icon.toPNG().length;
    diagnostics.__flightlogTrayIconPng = icon.toPNG().toString('base64');
    this.rebuild();
  }

  setStatus(event: AgentStatusEvent): void {
    this.status = event;
    if (event.state === 'sync_error') this.agentError = false;
    this.rebuild();
  }

  setAgentRunning(running: boolean): void {
    if (running) this.agentError = false;
    this.agentRunning = running;
    this.state = { ...this.state, agentRunning: running };
    this.rebuild();
  }

  setRecording(recording: boolean): void {
    this.recording = recording;
    this.state = { ...this.state, recording };
    this.rebuild();
  }

  setAgentError(error: string | null): void {
    this.agentError = error !== null;
    if (error) this.status = { state: 'sim_waiting', message: error };
    this.rebuild();
  }

  setUserCode(code: string | null, expiresAt: number | null = null): void {
    this.userCode = code;
    this.userCodeExpiresAt = code ? expiresAt : null;
    this.rebuild();
  }

  setOutbox(counts: DesktopOutboxCounts): void {
    this.outbox = counts;
    this.rebuild();
  }

  setUpdateReady(version: string | null): void {
    this.state = { ...this.state, updateReady: version };
    this.rebuild();
  }

  setAutostart(enabled: boolean): void {
    this.state = { ...this.state, autostart: enabled };
    this.rebuild();
  }

  setAuthAlerts(enabled: boolean): void {
    this.authAlerts = enabled;
    this.state = { ...this.state, authAlerts: enabled };
    this.rebuild();
  }

  /** CD-4.1: обновить префы тостов (после переключения в меню). */
  setNotifications(notifications: NotificationPreferences): void {
    this.notifications = notifications;
    this.state = { ...this.state, notifications };
    this.rebuild();
  }

  /** F2: план известен/сменился — префикс статус-строки меню. */
  setPlan(plan: AgentMePlan | null): void {
    this.plan = plan;
    this.rebuild();
  }

  /** T-CLIENT3: мгновенно перевести меню трея и тултип. */
  setLocale(locale: DesktopLocale): void {
    if (this.state.locale === locale) return;
    this.state = { ...this.state, locale };
    this.rebuild();
  }

  /** ADR-0023: обновить отображаемый источник телеметрии (display-only). */
  setSimSource(kind: SimSourceKind): void {
    if (this.simSourceKind === kind) return;
    this.simSourceKind = kind;
    this.rebuild();
  }

  /** T117: тема ОС изменилась — переключаем глиф на инверсный. */
  setIconVariant(variant: TrayIconVariant): void {
    if (this.iconVariant === variant) return;
    this.iconVariant = variant;
    const diagnostics = globalThis as TrayDiagnostics;
    diagnostics.__flightlogTrayVariant = variant;
    if (!this.tray) return;
    const image = this.icon(this.currentState());
    this.tray.setImage(image);
    diagnostics.__flightlogTrayIconBytes = image.toPNG().length;
    diagnostics.__flightlogTrayIconPng = image.toPNG().toString('base64');
    this.rebuild();
  }

  private currentState(): TrayState {
    return deriveTrayState(this.status, this.agentRunning, this.recording, this.agentError);
  }

  private icon(state: TrayState): NativeImage {
    const key = `${state}:${this.iconVariant}`;
    const cached = this.icons.get(key);
    if (cached) return cached;
    const base = renderTrayBitmap(state, 16, this.iconVariant);
    const image = nativeImage.createFromBitmap(base.buffer, {
      width: base.width,
      height: base.height,
      scaleFactor: 1,
    });
    const retina = renderTrayBitmap(state, 32, this.iconVariant);
    image.addRepresentation({
      scaleFactor: 2,
      width: retina.width,
      height: retina.height,
      buffer: retina.buffer,
    });
    this.icons.set(key, image);
    return image;
  }

  private tooltipValues(): Record<string, string | number> {
    const status = this.status;
    const counts = this.outbox ?? status?.pendingCounts;
    const aircraft = status?.aircraftIcao ?? '—';
    const codeTime = this.userCodeExpiresAt
      ? formatClock(this.state.locale, new Date(this.userCodeExpiresAt).toISOString())
      : '';
    return {
      code: this.userCode ?? '—',
      aircraft,
      points: counts?.pendingPoints ?? '—',
      flights: counts?.pendingFlights ?? '—',
      score: status?.score ?? '—',
      fpm: status?.vsFpm != null ? Math.round(status.vsFpm) : '—',
      time: codeTime || formatClock(this.state.locale, status?.lastSyncAt) || '—',
    };
  }

  private tooltip(kind: AgentStatusKind): string {
    return formatTrayTooltip(this.state.locale, kind, this.tooltipValues());
  }

  private rebuild(): void {
    if (!this.tray) return;
    const { agentRunning, autostart, authAlerts, updateReady, locale } = this.state;
    const state = this.currentState();
    const recording = this.recording;
    const messages = getDesktopMessages(locale).tray;
    const statusCopy = statusLabel(locale, state, this.status?.message);
    const prefix = planTrayPrefix(this.plan, getDesktopMessages(locale));
    const statusLine = prefix
      ? interpolate(messages.statusWithPlan, { plan: prefix, status: statusCopy })
      : statusCopy;
    const tooltip = this.tooltip(state);

    const template: MenuItemConstructorOptions[] = [
      {
        label: statusLine,
        enabled: false,
        icon: this.icon(state),
      },
      { type: 'separator' },
      {
        label: messages.menu.openStatus,
        ...(this.state.openStatusAccelerator
          ? {
              accelerator: this.state.openStatusAccelerator,
              registerAccelerator: false,
            }
          : {}),
        click: () => this.callbacks.onOpenStatus(),
      },
      {
        label: messages.menu.openSite,
        submenu: [
          { label: messages.menu.dashboard, click: () => this.callbacks.onOpenSite('/') },
          {
            label: messages.menu.recentFlights,
            click: () => this.callbacks.onOpenSite('/flights'),
          },
        ],
      },
      { type: 'separator' },
      // T-CLIENT3 (канон §1.5/§4.3): выбор языка, синхронизирован с шапкой окна.
      {
        label: messages.menu.language,
        submenu: [
          {
            label: getDesktopMessages(locale).status.language.ru,
            type: 'radio',
            checked: locale === 'ru',
            click: () => this.callbacks.onSetLocale('ru'),
          },
          {
            label: getDesktopMessages(locale).status.language.en,
            type: 'radio',
            checked: locale === 'en',
            click: () => this.callbacks.onSetLocale('en'),
          },
        ],
      },
      // CD-4.1: Windows-тосты настраиваются по отдельности (вкл/выкл).
      {
        label: messages.menu.notifications,
        submenu: [
          this.notificationItem('touchdown', messages.menu.notifTouchdown),
          this.notificationItem('syncError', messages.menu.notifSyncError),
          this.notificationItem('updates', messages.menu.notifUpdates),
        ],
      },
      ...this.deviceMenuItems(state),
      { type: 'separator' },
      {
        label: agentRunning ? messages.menu.stopAgent : messages.menu.startAgent,
        click: () => this.callbacks.onToggleAgent(),
      },
      {
        label: messages.menu.syncNow,
        enabled: agentRunning && state !== 'syncing',
        toolTip: agentRunning ? undefined : messages.menu.syncNowDisabled,
        click: () => this.callbacks.onSyncNow(),
      },
      { type: 'separator' },
      {
        // Единственное OS-уведомление (action-required); включено по умолчанию.
        // Прочих уведомлений нет — состояние живёт в тултипе и окне статуса.
        label: messages.menu.authAlertsToggle,
        type: 'checkbox',
        checked: authAlerts,
        click: () => this.callbacks.onToggleAuthAlerts(!authAlerts),
      },
      {
        label: messages.menu.autostart,
        type: 'checkbox',
        checked: autostart,
        click: () => this.callbacks.onToggleAutostart(!autostart),
      },
      { type: 'separator' },
      { label: messages.menu.checkUpdates, click: () => this.callbacks.onCheckUpdates() },
      // Пока файл качается в фоне, трей ничего не показывает: пункт появляется
      // только когда версия ГОТОВА (`updateReady`).
      {
        label: updateReady
          ? recording
            ? messages.menu.updateDeferred
            : messages.menu.updateReady.replace('{version}', updateReady)
          : messages.menu.updateNone,
        enabled: updateReady !== null && !recording,
        toolTip: recording ? messages.menu.updateDeferred : undefined,
        click: () => this.callbacks.onInstallUpdate(),
      },
      { label: messages.menu.about, click: () => this.callbacks.onAbout() },
      { type: 'separator' },
      { label: messages.menu.quit, click: () => this.callbacks.onQuit() },
    ];

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
    this.tray.setToolTip(tooltip);
    const diagnostics = globalThis as TrayDiagnostics;
    diagnostics.__flightlogTrayState = state;
    diagnostics.__flightlogTrayTooltip = tooltip;
    diagnostics.__flightlogTrayMenuLabels = template.map((item) =>
      String(item.label ?? item.type ?? ''),
    );
    diagnostics.__flightlogTrayAccelerators = template
      .map((item) => item.accelerator)
      .filter((value): value is string => typeof value === 'string');
  }

  /** CD-4.1: checkbox-пункт тоста с текущим состоянием префы. */
  private notificationItem(
    kind: keyof NotificationPreferences,
    label: string,
  ): MenuItemConstructorOptions {
    return {
      label,
      type: 'checkbox',
      checked: this.notifications[kind],
      click: () => this.callbacks.onToggleNotification(kind, !this.notifications[kind]),
    };
  }

  /**
   * Пункты device-flow, видимые только при `auth_required` (T116): код, in-app
   * подтверждение, копирование и вторичный браузерный fallback.
   */
  private deviceMenuItems(state: TrayState): MenuItemConstructorOptions[] {
    if (state !== 'auth_required' || !this.userCode) return [];
    const messages = getDesktopMessages(this.state.locale);
    const expired = this.userCodeExpiresAt !== null && Date.now() >= this.userCodeExpiresAt;
    const time = this.userCodeExpiresAt
      ? formatClock(this.state.locale, new Date(this.userCodeExpiresAt).toISOString())
      : '';
    const detail = expired
      ? messages.status.deviceCode.expired
      : interpolate(messages.status.deviceCode.expiresAt, { time: time || '—' });
    return [
      {
        label: `${messages.status.deviceCode.overline}: ${this.userCode}`,
        enabled: false,
      },
      { label: detail, enabled: false },
      { label: messages.tray.menu.copyCode, click: () => this.callbacks.onCopyUserCode() },
      {
        label: messages.tray.menu.openInBrowser,
        click: () => this.callbacks.onOpenDeviceInBrowser(),
      },
      { type: 'separator' },
    ];
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}

export { TRAY_STATE_COLORS, agentStatusMap };
export type { TrayState };
