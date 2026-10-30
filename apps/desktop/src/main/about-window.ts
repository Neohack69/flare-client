import type { DesktopLocale } from '@flightlog/contracts';
import { BrowserWindow, screen, type WebContents } from 'electron';

import { getDesktopMessages } from '../shared/i18n.js';
import { UPDATE_STATUS_CHANNEL, type UpdateStatus } from '../shared/update-status.js';
import { applyWindowIcon } from './app-identity.js';
import { attachEditContextMenu } from './edit-context-menu.js';
import { applyWebContentsSecurity, type SecurityContext } from './security.js';

/** T-CLIENT3: мгновенная смена языка окна (совпадает с status-window). */
const LOCALE_CHANNEL = 'desktop:locale';

export const ABOUT_WINDOW_WIDTH = 480;
export const ABOUT_WINDOW_MIN_HEIGHT = 620;
/** Отступ от рабочей области, чтобы окно не упиралось в панель задач. */
export const ABOUT_WINDOW_WORK_AREA_MARGIN = 64;
const ABOUT_WINDOW_FALLBACK_MAX_HEIGHT = 900;
const REFIT_DELAY_MS = 150;
const FIT_SCRIPT = `(() => {
  const titlebar = document.getElementById('titlebar');
  const about = document.querySelector('.about');
  if (!titlebar || !about) return null;
  return { titlebar: titlebar.getBoundingClientRect().height, about: about.scrollHeight };
})()`;

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** CSS px → DIP: Electron отдаёт размеры контента в DIP, а zoom влияет на CSS px. */
export function aboutContentHeightDip(heightCss: unknown, zoomFactor: unknown): number {
  const css = nonNegative(heightCss) ?? 0;
  const zoom = nonNegative(zoomFactor);
  return Math.ceil(css * (zoom && zoom > 0 ? zoom : 1));
}

/** Высота контента About: titlebar + фактическая высота `.about` (CSS px). */
export function measureAboutContentDip(
  titlebarHeight: unknown,
  aboutScrollHeight: unknown,
  zoomFactor: unknown,
): number {
  return aboutContentHeightDip(
    (nonNegative(titlebarHeight) ?? 0) + (nonNegative(aboutScrollHeight) ?? 0),
    zoomFactor,
  );
}

/** Максимальная высота окна: рабочая область минус отступ, но не меньше минимума. */
export function resolveAboutMaxHeight(workAreaHeight: unknown): number {
  const area = nonNegative(workAreaHeight);
  if (area === null) return ABOUT_WINDOW_FALLBACK_MAX_HEIGHT;
  return Math.max(ABOUT_WINDOW_MIN_HEIGHT, Math.floor(area) - ABOUT_WINDOW_WORK_AREA_MARGIN);
}

/**
 * Высота окна About = высота контента, но не меньше 620 и не больше `maxHeight`.
 * Некорректное измерение (NaN/строка/отрицательное) — дефолт 620.
 */
export function clampAboutWindowHeight(
  measured: unknown,
  maxHeight: number = ABOUT_WINDOW_FALLBACK_MAX_HEIGHT,
): number {
  const value = nonNegative(measured);
  const max = nonNegative(maxHeight);
  const upper = Math.max(
    ABOUT_WINDOW_MIN_HEIGHT,
    Math.floor(max ?? ABOUT_WINDOW_FALLBACK_MAX_HEIGHT),
  );
  return Math.min(upper, Math.max(ABOUT_WINDOW_MIN_HEIGHT, value === null ? 0 : Math.ceil(value)));
}

export interface AboutWindowOptions {
  aboutFile: string;
  aboutUrl?: string;
  preloadPath: string;
  security: SecurityContext;
  locale(): DesktopLocale;
  /** Иконка окна/таскбара: Windows — `.ico`, прочие — `.png` (dev: `build/`, packaged: `resources/`). */
  iconPath?: string;
  onHidden?(): void;
}

/**
 * «О программе» — локальная страница 480×620 (desktop-client.md §6.5): версии,
 * `device_id`, лицензии, диагностика без секретов. Создаётся лениво, офлайн.
 * После загрузки высота подгоняется под контент (620 — рабочая область − 64).
 */
export class AboutWindowController {
  private win: BrowserWindow | null = null;
  private quitting = false;

  constructor(private readonly options: AboutWindowOptions) {}

  show(): void {
    if (!this.win || this.win.isDestroyed()) {
      this.create();
    }
    const win = this.win;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  markQuitting(): void {
    this.quitting = true;
    this.win?.destroy();
    this.win = null;
  }

  /** T-CLIENT3: смена языка — заголовок окна + мгновенный апдейт строк renderer. */
  setLocale(locale: DesktopLocale): void {
    const win = this.win;
    if (win && !win.isDestroyed()) {
      win.setTitle(getDesktopMessages(locale).about.title);
      win.webContents.send(LOCALE_CHANNEL, locale);
      void this.fitContentHeight(win);
    }
  }

  /** FIX-UPDATE-CHECK-FEEDBACK: статус проверки обновлений (checking → итог). */
  sendUpdateStatus(status: UpdateStatus): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    win.webContents.send(UPDATE_STATUS_CHANNEL, status);
    this.scheduleRefit(win);
  }

  /** Renderer сообщает фактическую высоту контента (CSS px) после ResizeObserver. */
  fitFromRenderer(sender: WebContents, heightCss: unknown): void {
    const win = this.win;
    if (!win || win.isDestroyed() || win.webContents !== sender) return;
    this.applyContentHeight(win, aboutContentHeightDip(heightCss, this.zoomFactor(win)));
  }

  window(): BrowserWindow | null {
    return this.win;
  }

  private create(): void {
    const win = new BrowserWindow({
      width: ABOUT_WINDOW_WIDTH,
      height: ABOUT_WINDOW_MIN_HEIGHT,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      // DESKTOP-UX-POLISH: своя рамка — кастомный тайтбар в about.html
      // (`-webkit-app-region: drag`), кнопка close шлёт IPC.
      frame: false,
      show: false,
      title: getDesktopMessages(this.options.locale()).about.title,
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
      void this.fitContentHeight(win);
    });

    win.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      win.hide();
      this.options.onHidden?.();
    });

    win.once('ready-to-show', () => win.show());
    if (this.options.aboutUrl) {
      void win.loadURL(this.options.aboutUrl);
    } else {
      void win.loadFile(this.options.aboutFile);
    }

    this.win = win;
  }

  private zoomFactor(win: BrowserWindow): number {
    try {
      const zoom = win.webContents.getZoomFactor();
      return nonNegative(zoom) ?? 1;
    } catch {
      return 1;
    }
  }

  private scheduleRefit(win: BrowserWindow): void {
    setTimeout(() => {
      if (!win.isDestroyed()) void this.fitContentHeight(win);
    }, REFIT_DELAY_MS);
  }

  /**
   * Авто-высота: после загрузки подгоняем окно под контент, измеряя его в renderer.
   * `document.documentElement.scrollHeight` здесь бесполезен (body тянется на 100vh).
   */
  private async fitContentHeight(win: BrowserWindow): Promise<void> {
    try {
      const measured = await win.webContents.executeJavaScript(FIT_SCRIPT);
      if (win.isDestroyed()) return;
      if (typeof measured !== 'object' || measured === null) return;
      const { titlebar, about } = measured as { titlebar?: unknown; about?: unknown };
      this.applyContentHeight(
        win,
        measureAboutContentDip(titlebar, about, this.zoomFactor(win)),
      );
    } catch {
      // Измерение недоступно (страница выгружена/ошибка) — оставляем текущий размер.
    }
  }

  private applyContentHeight(win: BrowserWindow, measuredDip: number): void {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const height = clampAboutWindowHeight(measuredDip, resolveAboutMaxHeight(workArea.height));
    win.setContentSize(ABOUT_WINDOW_WIDTH, height);

    const next = win.getBounds();
    const x = Math.round(workArea.x + Math.max(0, (workArea.width - next.width) / 2));
    const bottomLimit = workArea.y + workArea.height - next.height;
    const y = Math.round(
      Math.min(Math.max(next.y, workArea.y), Math.max(workArea.y, bottomLimit)),
    );
    if (next.x !== x || next.y !== y) win.setPosition(x, y);
  }
}
