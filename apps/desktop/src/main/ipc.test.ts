import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (event: unknown, payload: unknown) => unknown>());
const listeners = vi.hoisted(
  () => new Map<string, (event: unknown, payload: unknown) => unknown>(),
);

const electronState = vi.hoisted(() => ({
  window: { minimize: vi.fn(), close: vi.fn() },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
    on: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      listeners.set(channel, handler);
    },
    removeAllListeners: (channel: string) => listeners.delete(channel),
  },
  BrowserWindow: { fromWebContents: () => electronState.window },
  shell: { openExternal: vi.fn() },
}));

import { STATUS_FIT_CHANNEL } from '../shared/status-fit';
import {
  IPC_CLOSE_WINDOW,
  IPC_COMMAND,
  IPC_GET_ACCOUNT,
  IPC_GET_PLAN,
  IPC_GET_STATUS,
  IPC_INSTALL_UPDATE,
  IPC_MINIMIZE_WINDOW,
  IPC_OPEN_MANAGE_DEVICES,
  IPC_RUNTIME_INFO,
  IPC_SEND_DIAGNOSTICS,
  IPC_SET_LOCALE,
  registerIpc,
  removeIpc,
} from './ipc';
import type { SecurityContext } from './security';

const STATUS_URL = 'file:///H:/app/out/renderer/status.html';

const context: SecurityContext = {
  webOrigin: 'https://app.flightlog.app',
  localFiles: ['H:/app/out/renderer/status.html', 'H:/app/out/renderer/about.html'],
  isDev: false,
};

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function sender(url: string) {
  return { senderFrame: { url }, sender: { getURL: () => url } };
}

function makeHandlers() {
  const onCommand = vi.fn();
  const installUpdate = vi.fn();
  const setLocale = vi.fn();
  const openManageDevices = vi.fn();
  const getRuntimeInfo = vi.fn(() => ({
    appVersion: '0.1.0',
    agentVersion: null,
    electron: '33',
    node: '22',
    chromium: '130',
    protocol: 'sunrise' as const,
    channel: 'latest' as const,
    deviceId: null,
    deviceName: null,
    agentRunning: false,
    locale: 'ru' as const,
    openStatusHotkey: null,
    errorReporting: { configured: false, enabled: false },
  }));
  registerIpc(context, logger, {
    getStatus: () => null,
    getRuntimeInfo,
    getAccount: () => ({ email: 'pilot@example.com', displayName: null, planName: 'Pro' }),
    onCommand,
    installUpdate,
    setLocale,
    openManageDevices,
  });
  return { onCommand, getRuntimeInfo, installUpdate, setLocale, openManageDevices };
}

beforeEach(() => {
  handlers.clear();
  listeners.clear();
  vi.clearAllMocks();
});

describe('IPC allowlist (ADR-0011 §7)', () => {
  it('разрешает валидные команды из локального окна статуса', async () => {
    const { onCommand } = makeHandlers();
    const handler = handlers.get(IPC_COMMAND);
    expect(handler).toBeDefined();
    await handler?.(sender(STATUS_URL), { command: 'open-site' });
    await handler?.(sender(STATUS_URL), { command: 'open-logs' });
    expect(onCommand).toHaveBeenCalledWith('open-site');
    expect(onCommand).toHaveBeenCalledWith('open-logs');
  });

  it('отклоняет неизвестную команду', () => {
    const { onCommand } = makeHandlers();
    const handler = handlers.get(IPC_COMMAND);
    expect(() => handler?.(sender(STATUS_URL), { command: 'shell' })).toThrow(
      /invalid desktop command/,
    );
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('отклоняет IPC с чужого origin', () => {
    const { onCommand } = makeHandlers();
    const handler = handlers.get(IPC_COMMAND);
    expect(() => handler?.(sender('https://evil.example/'), { command: 'open-site' })).toThrow(
      /sender is not allowed/,
    );
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('T132: install-update доступен только своим', () => {
    const { installUpdate } = makeHandlers();
    const handler = handlers.get(IPC_INSTALL_UPDATE);
    expect(handler).toBeDefined();
    handler?.(sender(STATUS_URL), undefined);
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(() => handler?.(sender('https://evil.example/'), undefined)).toThrow(
      /sender is not allowed/,
    );
  });

  it('W1b: send-diagnostics доступен только своим и возвращает результат', async () => {
    const sendDiagnostics = vi.fn(async () => true);
    registerIpc(context, logger, {
      getStatus: () => null,
      getRuntimeInfo: vi.fn(),
      onCommand: vi.fn(),
      sendDiagnostics,
    });
    const handler = handlers.get(IPC_SEND_DIAGNOSTICS);
    expect(handler).toBeDefined();
    await expect(handler?.(sender(STATUS_URL), undefined)).resolves.toBe(true);
    expect(sendDiagnostics).toHaveBeenCalledTimes(1);
    await expect(handler?.(sender('https://evil.example/'), undefined)).rejects.toThrow(
      /sender is not allowed/,
    );
  });

  it('отдаёт runtime info и аккаунт только своим (T-CLIENT2)', async () => {
    const { getRuntimeInfo } = makeHandlers();
    const handler = handlers.get(IPC_RUNTIME_INFO);
    expect(handler?.(sender(STATUS_URL), undefined)).toEqual(getRuntimeInfo());
    expect(() => handler?.(sender('https://evil.example/'), undefined)).toThrow();

    const account = handlers.get(IPC_GET_ACCOUNT);
    expect(account?.(sender(STATUS_URL), undefined)).toEqual({
      email: 'pilot@example.com',
      displayName: null,
      planName: 'Pro',
    });
    expect(() => account?.(sender('https://evil.example/'), undefined)).toThrow(
      /sender is not allowed/,
    );
  });

  it('разрешает только локальные страницы клиента', () => {
    makeHandlers();
    const handler = handlers.get(IPC_GET_STATUS);
    expect(() => handler?.(sender('file:///C:/Windows/System32/calc.exe'), undefined)).toThrow();
    expect(handler?.(sender('file:///H:/app/out/renderer/status.html'), undefined)).toBeNull();
  });

  it('T-CLIENT3: set-locale валидирует payload и принимает только свои', () => {
    const { setLocale } = makeHandlers();
    const handler = handlers.get(IPC_SET_LOCALE);
    expect(handler).toBeDefined();
    handler?.(sender(STATUS_URL), { locale: 'en' });
    expect(setLocale).toHaveBeenCalledWith('en');
    expect(() => handler?.(sender(STATUS_URL), { locale: 'de' })).toThrow(/invalid locale/);
    expect(() => handler?.(sender(STATUS_URL), { locale: 42 })).toThrow(/invalid locale/);
    expect(() => handler?.(sender('https://evil.example/'), { locale: 'en' })).toThrow(
      /sender is not allowed/,
    );
    expect(setLocale).toHaveBeenCalledTimes(1);
  });

  it('CD-4.3: open-manage-devices доступен только своим', () => {
    const { openManageDevices } = makeHandlers();
    const handler = handlers.get(IPC_OPEN_MANAGE_DEVICES);
    expect(handler).toBeDefined();
    handler?.(sender(STATUS_URL), undefined);
    expect(openManageDevices).toHaveBeenCalledTimes(1);
    expect(() => handler?.(sender('https://evil.example/'), undefined)).toThrow(
      /sender is not allowed/,
    );
  });

  it('DESKTOP-UX-POLISH: minimize/close действуют на окно-отправитель', () => {
    makeHandlers();
    const minimize = handlers.get(IPC_MINIMIZE_WINDOW);
    const close = handlers.get(IPC_CLOSE_WINDOW);
    expect(minimize).toBeDefined();
    expect(close).toBeDefined();

    minimize?.(sender(STATUS_URL), undefined);
    close?.(sender(STATUS_URL), undefined);
    expect(electronState.window.minimize).toHaveBeenCalledTimes(1);
    expect(electronState.window.close).toHaveBeenCalledTimes(1);

    expect(() => close?.(sender('https://evil.example/'), undefined)).toThrow(
      /sender is not allowed/,
    );
  });

  it('DESKTOP-UPDATE-CARD: fit-status принимает только число > 0 от своего окна', () => {
    const fitStatusWindow = vi.fn();
    registerIpc(context, logger, {
      getStatus: () => null,
      getRuntimeInfo: vi.fn(),
      onCommand: vi.fn(),
      fitStatusWindow,
    });
    const listener = listeners.get(STATUS_FIT_CHANNEL);
    expect(listener).toBeDefined();

    const own = sender(STATUS_URL);
    listener?.(own, 663);
    expect(fitStatusWindow).toHaveBeenCalledTimes(1);
    expect(fitStatusWindow).toHaveBeenCalledWith(own.sender, 663);

    listener?.(own, '663');
    listener?.(own, Number.NaN);
    listener?.(own, -1);
    listener?.(own, 0);
    expect(fitStatusWindow).toHaveBeenCalledTimes(1);

    listener?.(sender('https://evil.example/'), 663);
    expect(fitStatusWindow).toHaveBeenCalledTimes(1);
  });

  it('removeIpc снимает обработчики', () => {
    makeHandlers();
    registerIpc(context, logger, {
      getStatus: () => null,
      getRuntimeInfo: vi.fn(),
      onCommand: vi.fn(),
    });
    removeIpc();
    expect(handlers.size).toBe(0);
    expect(listeners.size).toBe(0);
  });
});

describe('IPC get-plan (iter77 premium skin)', () => {
  it('отдаёт план только доверенному renderer', () => {
    const plan = { code: 'pro', name: 'Pro' } as const;
    registerIpc(context, logger, {
      getStatus: () => null,
      getRuntimeInfo: vi.fn(),
      getPlan: () => plan,
      onCommand: vi.fn(),
    });
    const handler = handlers.get(IPC_GET_PLAN);
    expect(handler?.(sender(STATUS_URL), undefined)).toEqual(plan);
    expect(() => handler?.(sender('https://evil.example/'), undefined)).toThrow(
      /sender is not allowed/,
    );
  });
});
