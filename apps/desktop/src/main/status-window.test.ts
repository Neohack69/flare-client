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
      getURL: () => 'file:///status.html',
      getZoomFactor: () => 1,
      send: vi.fn(),
      executeJavaScript: vi.fn(() => Promise.resolve(560)),
    };
    bounds = { x: 100, y: 200, width: 420, height: 560 };
    setContentSize = vi.fn((width: number, height: number) => {
      this.bounds = { ...this.bounds, width, height };
    });
    getContentSize = vi.fn(() => [420, 560]);
    getBounds = vi.fn(() => ({ ...this.bounds }));
    setBounds = vi.fn((next: { x: number; y: number; width: number; height: number }) => {
      this.bounds = { ...next };
    });
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
      getDisplayMatching: () => ({ workArea: electronState.workArea }),
    },
    shell: { openExternal: vi.fn() },
    Menu: { buildFromTemplate: () => ({ popup: () => undefined }) },
  };
});

import { UPDATE_STATUS_CHANNEL } from '../shared/update-status';
import type { SecurityContext } from './security';
import {
  clampStatusWindowHeight,
  resolveStatusWindowBounds,
  STATUS_WINDOW_CHANNELS,
  STATUS_WINDOW_MAX_HEIGHT,
  STATUS_WINDOW_MIN_HEIGHT,
  STATUS_WINDOW_WORK_AREA_MARGIN,
  StatusWindowController,
  statusContentHeightDip,
} from './status-window';

const security: SecurityContext = {
  webOrigin: 'https://app.flightlog.app',
  localFiles: ['H:/app/out/renderer/status.html'],
  isDev: false,
};

function makeController() {
  const onHidden = vi.fn();
  const controller = new StatusWindowController({
    statusFile: 'H:/app/out/renderer/status.html',
    preloadPath: 'preload.js',
    security,
    isDev: false,
    locale: () => 'ru',
    runtimeInfo: () => ({
      appVersion: '0.1.0',
      agentVersion: null,
      electron: '33',
      node: '22',
      chromium: '130',
      protocol: 'sunrise',
      channel: 'latest',
      deviceId: null,
      deviceName: null,
      agentRunning: false,
      locale: 'ru',
      openStatusHotkey: null,
      errorReporting: { configured: false, enabled: false },
    }),
    onHidden,
  });
  controller.create();
  const win = electronState.last as unknown as {
    emit: (event: string, ...args: unknown[]) => void;
    visible: boolean;
    webContents: { send: ReturnType<typeof vi.fn> };
    webContentsListeners: Map<string, Array<(...args: unknown[]) => void>>;
  };
  const emitWebContents = (event: string, ...args: unknown[]): void => {
    for (const listener of win.webContentsListeners.get(event) ?? []) listener(...args);
  };
  return { controller, win, onHidden, emitWebContents };
}

describe('clampStatusWindowHeight', () => {
  it('держит высоту в диапазоне 560–900', () => {
    expect(clampStatusWindowHeight(400)).toBe(STATUS_WINDOW_MIN_HEIGHT);
    expect(clampStatusWindowHeight(560)).toBe(560);
    expect(clampStatusWindowHeight(720.4)).toBe(721);
    expect(clampStatusWindowHeight(900)).toBe(STATUS_WINDOW_MAX_HEIGHT);
    expect(clampStatusWindowHeight(1_500)).toBe(STATUS_WINDOW_MAX_HEIGHT);
  });

  it('некорректное измерение → дефолт 560', () => {
    expect(clampStatusWindowHeight(Number.NaN)).toBe(STATUS_WINDOW_MIN_HEIGHT);
    expect(clampStatusWindowHeight('720')).toBe(STATUS_WINDOW_MIN_HEIGHT);
    expect(clampStatusWindowHeight(null)).toBe(STATUS_WINDOW_MIN_HEIGHT);
    expect(clampStatusWindowHeight(-10)).toBe(STATUS_WINDOW_MIN_HEIGHT);
  });
});

describe('StatusWindowController (desktop-client.md §2)', () => {
  it('создаётся 420×560 и не resize', () => {
    const { win } = makeController();
    const options = (win as unknown as { options: Record<string, unknown> }).options;
    expect(options.width).toBe(420);
    expect(options.height).toBe(560);
    expect(options.resizable).toBe(false);
  });

  it('DESKTOP-UX-POLISH: frameless-окно под кастомный тайтлбар', () => {
    const { win } = makeController();
    const options = (win as unknown as { options: Record<string, unknown> }).options;
    expect(options.frame).toBe(false);
    expect(options.minimizable).toBe(true);
    expect(options.maximizable).toBe(false);
  });

  it('close = hide (окно живёт в трее)', () => {
    const { win, onHidden } = makeController();
    const event = { preventDefault: vi.fn() };
    win.emit('close', event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onHidden).toHaveBeenCalledTimes(1);
  });

  it('шлёт статус/счётчики в renderer', () => {
    const { controller, win } = makeController();
    controller.sendStatus({ state: 'recording' });
    controller.sendAgentRunning(true);
    controller.sendOutbox({
      flights: 1,
      points: 10,
      events: 2,
      pendingFlights: 1,
      pendingPoints: 10,
      pendingEvents: 2,
    });
    expect(win.webContents.send).toHaveBeenCalledWith(STATUS_WINDOW_CHANNELS.status, {
      state: 'recording',
    });
    expect(win.webContents.send).toHaveBeenCalledWith(STATUS_WINDOW_CHANNELS.agentRunning, true);
    expect(win.webContents.send).toHaveBeenCalledWith(
      STATUS_WINDOW_CHANNELS.outbox,
      expect.objectContaining({ pendingPoints: 10 }),
    );
  });

  it('T132: шлёт готовность обновления и переотдаёт её при загрузке страницы', () => {
    const { controller, win, emitWebContents } = makeController();
    controller.sendUpdateReady('1.2.3');
    expect(win.webContents.send).toHaveBeenCalledWith(
      STATUS_WINDOW_CHANNELS.updateReady,
      '1.2.3',
    );

    emitWebContents('did-finish-load');
    expect(win.webContents.send).toHaveBeenCalledWith(
      STATUS_WINDOW_CHANNELS.updateReady,
      '1.2.3',
    );

    controller.sendUpdateReady(null);
    expect(win.webContents.send).toHaveBeenLastCalledWith(STATUS_WINDOW_CHANNELS.updateReady, null);
  });

  it('T-CLIENT3: setLocale шлёт смену языка в renderer и обновляет заголовок', () => {
    const { controller, win } = makeController();
    controller.setLocale('en');
    expect(win.webContents.send).toHaveBeenLastCalledWith(STATUS_WINDOW_CHANNELS.locale, 'en');
  });

  it('T4: после did-finish-load подгоняет высоту контента (clamp 560–900)', async () => {
    const { win, emitWebContents } = makeController();
    const contents = win.webContents as unknown as {
      executeJavaScript: ReturnType<typeof vi.fn>;
    };
    const mockWindow = win as unknown as {
      setBounds: ReturnType<typeof vi.fn>;
    };
    contents.executeJavaScript.mockResolvedValueOnce(720);

    emitWebContents('did-finish-load');

    await vi.waitFor(() =>
      expect(mockWindow.setBounds).toHaveBeenCalledWith(
        expect.objectContaining({ x: 100, width: 420, height: 720 }),
      ),
    );
    expect(contents.executeJavaScript).toHaveBeenCalledWith(
      'document.documentElement.scrollHeight',
    );
  });

  it('FIX-UPDATE-CHECK-FEEDBACK: шлёт статус проверки обновлений в renderer', () => {
    const { controller, win } = makeController();
    controller.sendUpdateStatus({ kind: 'checking' });
    controller.sendUpdateStatus({ kind: 'not-available' });
    expect(win.webContents.send).toHaveBeenCalledWith(UPDATE_STATUS_CHANNEL, { kind: 'checking' });
    expect(win.webContents.send).toHaveBeenLastCalledWith(UPDATE_STATUS_CHANNEL, {
      kind: 'not-available',
    });
  });
});

describe('DESKTOP-UPDATE-CARD: высота окна по контенту', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const bounds = { x: 100, y: 200, width: 420, height: 560 };

  it('statusContentHeightDip переводит CSS px в DIP с учётом zoom', () => {
    expect(statusContentHeightDip(663, 1)).toBe(663);
    expect(statusContentHeightDip(663, 1.5)).toBe(995);
    expect(statusContentHeightDip(663, 0)).toBe(663);
    expect(statusContentHeightDip(Number.NaN, 1)).toBe(0);
    expect(statusContentHeightDip('663', 1)).toBe(0);
  });

  it('resolveStatusWindowBounds: нижняя кромка на 8 px выше рабочей области, x не меняется', () => {
    const next = resolveStatusWindowBounds(bounds, workArea, 663);
    expect(next).toEqual({
      x: 100,
      y: 1080 - STATUS_WINDOW_WORK_AREA_MARGIN - 663,
      width: 420,
      height: 663,
    });
  });

  it('resolveStatusWindowBounds: clamp 560–900 и верх не уезжает за экран', () => {
    expect(resolveStatusWindowBounds(bounds, workArea, 120).height).toBe(STATUS_WINDOW_MIN_HEIGHT);
    expect(resolveStatusWindowBounds(bounds, workArea, 5_000).height).toBe(
      STATUS_WINDOW_MAX_HEIGHT,
    );
    expect(
      resolveStatusWindowBounds(bounds, { x: 0, y: 0, width: 1200, height: 400 }, 900).y,
    ).toBe(0);
  });

  it('fitFromRenderer: растит окно вверх, нижняя кромка на месте', () => {
    const { controller, win } = makeController();
    const mockWindow = win as unknown as { setBounds: ReturnType<typeof vi.fn> };
    controller.fitFromRenderer(win.webContents as never, 663);
    expect(mockWindow.setBounds).toHaveBeenCalledWith({
      x: 100,
      y: 409,
      width: 420,
      height: 663,
    });
  });

  it('fitFromRenderer: чужой sender и мусор игнорируются', () => {
    const { controller, win } = makeController();
    const mockWindow = win as unknown as { setBounds: ReturnType<typeof vi.fn> };
    controller.fitFromRenderer({} as never, 663);
    controller.fitFromRenderer(win.webContents as never, Number.NaN);
    controller.fitFromRenderer(win.webContents as never, -10);
    controller.fitFromRenderer(win.webContents as never, '663');
    expect(mockWindow.setBounds).not.toHaveBeenCalled();
  });

  it('fitFromRenderer: разница < 8 px окно не двигает', () => {
    const { controller, win } = makeController();
    const mockWindow = win as unknown as { setBounds: ReturnType<typeof vi.fn> };
    controller.fitFromRenderer(win.webContents as never, 565);
    expect(mockWindow.setBounds).not.toHaveBeenCalled();
  });
});
