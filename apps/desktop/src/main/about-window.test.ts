import { describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({
  last: null as unknown,
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
}));

vi.mock('electron', () => {
  class BrowserWindow {
    listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    webContentsListeners = new Map<string, Array<(...args: unknown[]) => void>>();
    webContents = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const list = this.webContentsListeners.get(event) ?? [];
        list.push(listener);
        this.webContentsListeners.set(event, list);
      }),
      once: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      getURL: () => 'file:///about.html',
      send: vi.fn(),
      executeJavaScript: vi.fn(() => Promise.resolve({ titlebar: 36, about: 684 })),
      getZoomFactor: vi.fn(() => 1),
    };
    setContentSize = vi.fn();
    getContentSize = vi.fn(() => [480, 620]);
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 480, height: 620 }));
    setPosition = vi.fn();
    visible = false;
    constructor(public readonly options: unknown) {
      electronState.last = this;
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }
    once(): this {
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
    setIcon(): void {}
    hide(): void {
      this.visible = false;
    }
    show(): void {
      this.visible = true;
    }
    focus(): void {}
    setTitle(): void {}
    isVisible(): boolean {
      return this.visible;
    }
    isMinimized(): boolean {
      return false;
    }
    isDestroyed(): boolean {
      return false;
    }
    loadURL(): Promise<void> {
      return Promise.resolve();
    }
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
    destroy(): void {}
  }
  return {
    BrowserWindow,
    screen: {
      getDisplayMatching: vi.fn(() => ({ workArea: electronState.workArea })),
    },
    shell: { openExternal: vi.fn() },
    Menu: { buildFromTemplate: () => ({ popup: () => undefined }) },
  };
});

import type { SecurityContext } from './security';
import {
  ABOUT_WINDOW_MIN_HEIGHT,
  ABOUT_WINDOW_WIDTH,
  ABOUT_WINDOW_WORK_AREA_MARGIN,
  AboutWindowController,
  aboutContentHeightDip,
  clampAboutWindowHeight,
  measureAboutContentDip,
  resolveAboutMaxHeight,
} from './about-window';

const security: SecurityContext = {
  webOrigin: 'https://app.flightlog.app',
  localFiles: ['H:/app/out/renderer/about.html'],
  isDev: false,
};

function makeController() {
  electronState.workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const onHidden = vi.fn();
  const controller = new AboutWindowController({
    aboutFile: 'H:/app/out/renderer/about.html',
    preloadPath: 'preload.js',
    security,
    locale: () => 'ru',
    onHidden,
  });
  controller.show();
  const win = electronState.last as unknown as {
    emit: (event: string, ...args: unknown[]) => void;
    webContentsListeners: Map<string, Array<(...args: unknown[]) => void>>;
    webContents: {
      send: ReturnType<typeof vi.fn>;
      executeJavaScript: ReturnType<typeof vi.fn>;
      getZoomFactor: ReturnType<typeof vi.fn>;
    };
    setContentSize: ReturnType<typeof vi.fn>;
    setPosition: ReturnType<typeof vi.fn>;
    getBounds: ReturnType<typeof vi.fn>;
  };
  const emitWebContents = (event: string, ...args: unknown[]): void => {
    for (const listener of win.webContentsListeners.get(event) ?? []) listener(...args);
  };
  return { controller, win, onHidden, emitWebContents };
}

describe('About measurement helpers', () => {
  it('складывает titlebar и scrollHeight и переводит CSS px → DIP по zoom', () => {
    expect(measureAboutContentDip(36, 724, 1)).toBe(760);
    expect(measureAboutContentDip(36, 724, 1.25)).toBe(950);
    expect(aboutContentHeightDip(760.2, 1)).toBe(761);
    expect(measureAboutContentDip(Number.NaN, -5, 1)).toBe(0);
  });

  it('clamp по рабочей области: min 620, max = workArea − 64', () => {
    expect(resolveAboutMaxHeight(1080)).toBe(1080 - ABOUT_WINDOW_WORK_AREA_MARGIN);
    expect(resolveAboutMaxHeight(600)).toBe(ABOUT_WINDOW_MIN_HEIGHT);
    expect(clampAboutWindowHeight(400)).toBe(ABOUT_WINDOW_MIN_HEIGHT);
    expect(clampAboutWindowHeight(620)).toBe(620);
    expect(clampAboutWindowHeight(720.4)).toBe(721);
    expect(clampAboutWindowHeight(1_500, 900)).toBe(900);
    expect(clampAboutWindowHeight(1_500, 500)).toBe(ABOUT_WINDOW_MIN_HEIGHT);
  });

  it('некорректное измерение → дефолт 620', () => {
    expect(clampAboutWindowHeight(Number.NaN)).toBe(ABOUT_WINDOW_MIN_HEIGHT);
    expect(clampAboutWindowHeight('720')).toBe(ABOUT_WINDOW_MIN_HEIGHT);
    expect(clampAboutWindowHeight(null)).toBe(ABOUT_WINDOW_MIN_HEIGHT);
    expect(clampAboutWindowHeight(-10)).toBe(ABOUT_WINDOW_MIN_HEIGHT);
  });
});

describe('AboutWindowController (desktop-client.md §6.5)', () => {
  it('создаётся 480×620 и не resize', () => {
    const { win } = makeController();
    const options = (win as unknown as { options: Record<string, unknown> }).options;
    expect(options.width).toBe(ABOUT_WINDOW_WIDTH);
    expect(options.height).toBe(ABOUT_WINDOW_MIN_HEIGHT);
    expect(options.resizable).toBe(false);
  });

  it('после did-finish-load подгоняет высоту по titlebar + .about.scrollHeight', async () => {
    const { win, emitWebContents } = makeController();
    const contents = win.webContents as unknown as {
      executeJavaScript: ReturnType<typeof vi.fn>;
    };
    contents.executeJavaScript.mockResolvedValueOnce({ titlebar: 36, about: 724 });

    emitWebContents('did-finish-load');

    await vi.waitFor(() => expect(win.setContentSize).toHaveBeenCalledWith(480, 760));
    expect(contents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('.about'));
  });

  it('высота ограничена рабочей областью и окно остаётся в ней', async () => {
    const { win, emitWebContents } = makeController();
    electronState.workArea = { x: 100, y: 50, width: 1920, height: 700 };
    win.getBounds.mockReturnValue({ x: 0, y: 2_000, width: 480, height: 620 });
    win.webContents.executeJavaScript.mockResolvedValueOnce({ titlebar: 36, about: 1_500 });

    emitWebContents('did-finish-load');

    await vi.waitFor(() => expect(win.setContentSize).toHaveBeenCalledWith(480, 636));
    expect(win.setPosition).toHaveBeenCalledWith(820, 130);
  });

  it('renderer-триггер подгоняет окно и учитывает zoom', () => {
    const { controller, win } = makeController();
    win.webContents.getZoomFactor.mockReturnValueOnce(1.25);

    controller.fitFromRenderer(win.webContents as never, 720);

    expect(win.setContentSize).toHaveBeenCalledWith(480, 900);
  });

  it('sendUpdateStatus перезамеряет контент после обновления строки', async () => {
    vi.useFakeTimers();
    try {
      const { controller, win } = makeController();
      win.webContents.executeJavaScript.mockClear();

      controller.sendUpdateStatus({ kind: 'checking' });
      await vi.advanceTimersByTimeAsync(200);

      expect(win.webContents.executeJavaScript).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('close = hide (окно живёт в трее)', () => {
    const { win, onHidden } = makeController();
    const event = { preventDefault: vi.fn() };
    win.emit('close', event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onHidden).toHaveBeenCalledTimes(1);
  });
});
