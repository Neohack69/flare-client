import type {
  AgentStatusEvent,
  DesktopLocale,
  DesktopOutboxCounts,
  DesktopRuntimeInfo,
} from '@flightlog/contracts';
import { BrowserWindow, screen, type WebContents } from 'electron';

import { getDesktopMessages } from '../shared/i18n.js';
import { UPDATE_STATUS_CHANNEL, type UpdateStatus } from '../shared/update-status.js';
import { applyWindowIcon } from './app-identity.js';
import type { DeviceIssue } from './device-error.js';
import { attachEditContextMenu } from './edit-context-menu.js';
import { applyWebContentsSecurity, type SecurityContext } from './security.js';

export interface StatusWindowOptions {
  statusFile: string;
  /** dev: базовый URL vite renderer-сервера. */
  statusUrl?: string;
  preloadPath: string;
  security: SecurityContext;
  isDev: boolean;
  /** Иконка окна/таскбара: Windows — `.ico`, прочие — `.png` (dev: `build/`, packaged: `resources/`). */
  iconPath?: string;
  locale(): DesktopLocale;
  runtimeInfo(): DesktopRuntimeInfo;
  onHidden?(): void;
}

export const STATUS_WINDOW_CHANNELS = {
  status: 'desktop:status',
  agentRunning: 'desktop:agent-running',
  agentError: 'desktop:agent-error',
  outbox: 'desktop:outbox',
  /** T132: готовая версия обновления (или null) — строка «установить» в окне. */
  updateReady: 'desktop:update-ready',
  /** T-CLIENT3: мгновенная смена языка окна (без перезагрузки). */
  locale: 'desktop:locale',
  /** CD-4.3: распознанная проблема устройства (lim/mismatch). */
  deviceIssue: 'desktop:device-issue',
} as const;

export const STATUS_WINDOW_WIDTH = 420;
export const STATUS_WINDOW_MIN_HEIGHT = 560;
export const STATUS_WINDOW_MAX_HEIGHT = 900;
/** Нижняя кромка окна — на 8 px выше рабочей области (панель задач). */
export const STATUS_WINDOW_WORK_AREA_MARGIN = 8;
/** Реагируем только на реальную разницу высот (антидребезг ResizeObserver). */
export const STATUS_WINDOW_FIT_THRESHOLD_PX = 8;

/**
 * T4: высота окна = высота контента, но не меньше 560 и не больше 900.
 * Некорректное измерение (NaN/строка/отрицательное) — дефолт 560.
 */
export function clampStatusWindowHeight(measured: unknown): number {
  const value =
    typeof measured === 'number' && Number.isFinite(measured)
      ? Math.ceil(measured)
      : STATUS_WINDOW_MIN_HEIGHT;
  return Math.min(STATUS_WINDOW_MAX_HEIGHT, Math.max(STATUS_WINDOW_MIN_HEIGHT, value));
}

/**
 * CSS px → DIP: Electron меряет контент в DIP, а zoom влияет на CSS px.
 * Некорректное значение — 0 (fit не применяется).
 */
export function statusContentHeightDip(heightCss: unknown, zoomFactor: unknown): number {
  const css =
    typeof heightCss === 'number' && Number.isFinite(heightCss) && heightCss > 0 ? heightCss : 0;
  const zoom =
    typeof zoomFactor === 'number' && Number.isFinite(zoomFactor) && zoomFactor > 0
      ? zoomFactor
      : 1;
  return Math.ceil(css * zoom);
}

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * DESKTOP-UPDATE-CARD: окно растёт вверх от трея — нижняя кромка закреплена на
 * 8 px выше рабочей области, `x` не меняется, окно не наползает на панель задач.
 */
export function resolveStatusWindowBounds(
  bounds: WindowRect,
  workArea: WindowRect,
  targetHeight: unknown,
  bottomMargin: number = STATUS_WINDOW_WORK_AREA_MARGIN,
): WindowRect {
  const width = STATUS_WINDOW_WIDTH;
  const height = clampStatusWindowHeight(targetHeight);
  const margin =
    typeof bottomMargin === 'number' && Number.isFinite(bottomMargin) && bottomMargin >= 0
      ? bottomMargin
      : STATUS_WINDOW_WORK_AREA_MARGIN;
  const bottom = workArea.y + workArea.height - margin;
  // Верхняя кромка не выше начала рабочей области (высокое окно не уезжает за экран).
  const y = Math.round(Math.max(workArea.y, bottom - height));
  return { x: Math.round(bounds.x), y, width, height };
}

/**
 * Компактное окно «Состояние агента» 420×560 (desktop-client.md §2): локальная
 * страница, работает офлайн, открывается из трея. Крестик = hide; живёт всё
 * время работы приложения.
 */
export class StatusWindowController {
  private win: BrowserWindow | null = null;
  private quitting = false;
  /** Последняя известная готовая версия: отдаём и при (пере)загрузке страницы. */
  private updateReadyVersion: string | null = null;
  /** CD-4.3: последняя распознанная проблема устройства (для перезагрузки). */
  private deviceIssue: DeviceIssue | null = null;

  constructor(private readonly options: StatusWindowOptions) {}

  create(): BrowserWindow {
    const win = new BrowserWindow({
      width: STATUS_WINDOW_WIDTH,
      height: STATUS_WINDOW_MIN_HEIGHT,
      resizable: false,
      maximizable: false,
      minimizable: true,
      fullscreenable: false,
      // DESKTOP-UX-POLISH: своя рамка — кастомный тайтбар в status.html
      // (`-webkit-app-region: drag`), кнопки minimize/close шлют IPC.
      frame: false,
      show: false,
      title: getDesktopMessages(this.options.locale()).status.windowTitle,
      icon: this.options.iconPath,
      backgroundColor: '#060910',
      alwaysOnTop: false,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webviewTag: false,
        experimentalFeatures: false,
        allowRunningInsecureContent: false,
        webSecurity: true,
        spellcheck: false,
        additionalArguments: [`--flightlog-locale=${this.options.locale()}`],
      },
    });

    applyWebContentsSecurity(win.webContents, this.options.security);
    attachEditContextMenu(win.webContents, () => this.options.locale());
    // Belt-and-braces: не полагаемся только на конструктор `icon`.
    applyWindowIcon(win, this.options.iconPath);

    win.webContents.on('did-finish-load', () => {
      this.send(STATUS_WINDOW_CHANNELS.updateReady, this.updateReadyVersion);
      this.send(STATUS_WINDOW_CHANNELS.deviceIssue, this.deviceIssue);
      void this.fitContentHeight(win);
    });

    win.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      win.hide();
      this.options.onHidden?.();
    });

    this.win = win;
    return win;
  }

  loadStatus(): void {
    const win = this.win;
    if (!win) return;
    if (this.options.statusUrl) {
      void win.loadURL(this.options.statusUrl);
    } else {
      void win.loadFile(this.options.statusFile);
    }
  }

  show(): void {
    const win = this.win;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  hide(): void {
    this.win?.hide();
  }

  isVisible(): boolean {
    return this.win?.isVisible() ?? false;
  }

  sendStatus(event: AgentStatusEvent): void {
    this.send(STATUS_WINDOW_CHANNELS.status, event);
  }

  sendAgentRunning(running: boolean): void {
    this.send(STATUS_WINDOW_CHANNELS.agentRunning, running);
  }

  sendAgentError(error: string | null): void {
    this.send(STATUS_WINDOW_CHANNELS.agentError, error);
  }

  sendOutbox(counts: DesktopOutboxCounts): void {
    this.send(STATUS_WINDOW_CHANNELS.outbox, counts);
  }

  /** T132: готовность обновления — неинтрузивная строка вместо диалога. */
  sendUpdateReady(version: string | null): void {
    this.updateReadyVersion = version;
    this.send(STATUS_WINDOW_CHANNELS.updateReady, version);
  }

  /** FIX-UPDATE-CHECK-FEEDBACK: статус проверки обновлений (checking → итог). */
  sendUpdateStatus(status: UpdateStatus): void {
    this.send(UPDATE_STATUS_CHANNEL, status);
  }

  /** CD-4.3: проблема устройства — баннер с инструкцией и ссылкой. */
  sendDeviceIssue(issue: DeviceIssue | null): void {
    this.deviceIssue = issue;
    this.send(STATUS_WINDOW_CHANNELS.deviceIssue, issue);
  }

  /** T-CLIENT3: смена языка — заголовок окна + мгновенный апдейт строк renderer. */
  setLocale(locale: DesktopLocale): void {
    const win = this.win;
    if (win && !win.isDestroyed()) {
      win.setTitle(getDesktopMessages(locale).status.windowTitle);
    }
    this.send(STATUS_WINDOW_CHANNELS.locale, locale);
  }

  markQuitting(): void {
    this.quitting = true;
  }

  window(): BrowserWindow | null {
    return this.win;
  }

  /**
   * DESKTOP-UPDATE-CARD: renderer (ResizeObserver) присылает фактическую высоту
   * контента в CSS px; применяем только к окну-отправителю.
   */
  fitFromRenderer(sender: WebContents, heightCss: unknown): void {
    const win = this.win;
    if (!win || win.isDestroyed() || win.webContents !== sender) return;
    const measured = statusContentHeightDip(heightCss, this.zoomFactor(win));
    if (measured <= 0) return;
    this.applyContentHeight(win, measured);
  }

  /**
   * T4: после загрузки подгоняем высоту окна под контент (без скроллбара).
   * Окно остаётся non-resizable; при ошибке измерения — исходные 560.
   */
  private async fitContentHeight(win: BrowserWindow): Promise<void> {
    try {
      const measured = await win.webContents.executeJavaScript(
        'document.documentElement.scrollHeight',
      );
      if (win.isDestroyed()) return;
      this.applyContentHeight(win, measured);
    } catch {
      // Измерение недоступно (страница выгружена/ошибка) — оставляем дефолт.
    }
  }

  private zoomFactor(win: BrowserWindow): number {
    try {
      const zoom = win.webContents.getZoomFactor();
      return typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    } catch {
      return 1;
    }
  }

  private applyContentHeight(win: BrowserWindow, measuredDip: unknown): void {
    if (win.isDestroyed()) return;
    const height = clampStatusWindowHeight(measuredDip);
    const bounds = win.getBounds();
    if (Math.abs(bounds.height - height) < STATUS_WINDOW_FIT_THRESHOLD_PX) return;

    const workArea = screen.getDisplayMatching(bounds).workArea;
    const next = resolveStatusWindowBounds(bounds, workArea, height);
    win.setBounds(next);
  }

  private send(channel: string, payload: unknown): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  }
}
