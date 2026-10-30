import type { AgentLogger } from '@flightlog/agent';
import {
  desktopLocaleSchema,
  desktopRendererCommandRequestSchema,
  type AgentMePlan,
  type AgentStatusEvent,
  type DesktopAccount,
  type DesktopLocale,
  type DesktopRendererCommand,
  type DesktopRuntimeInfo,
} from '@flightlog/contracts';
import {
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';

import { ABOUT_FIT_CHANNEL } from '../shared/about-fit.js';
import { STATUS_FIT_CHANNEL } from '../shared/status-fit.js';
import { validateSender, type SecurityContext } from './security.js';

export const IPC_GET_STATUS = 'desktop:get-status';
export const IPC_COMMAND = 'desktop:command';
export const IPC_RUNTIME_INFO = 'desktop:runtime-info';
export const IPC_STATUS_EVENT = 'desktop:status';
/** T-CLIENT2: аккаунт привязки (best-effort снимок `/v1/me`). */
export const IPC_GET_ACCOUNT = 'desktop:get-account';
/** iter77: план для premium-скина (`GET /v1/agent/me`, best-effort). */
export const IPC_GET_PLAN = 'desktop:get-plan';
/** T132: установка готового обновления из окна «Состояние агента». */
export const IPC_INSTALL_UPDATE = 'desktop:install-update';
/** W1b: отправка обезличенной диагностики (About). */
export const IPC_SEND_DIAGNOSTICS = 'desktop:send-diagnostics';
/** T-CLIENT3: явный выбор языка из окна (RU/EN). */
export const IPC_SET_LOCALE = 'desktop:set-locale';
/** CD-4.3: открыть страницу управления устройствами на сайте. */
export const IPC_OPEN_MANAGE_DEVICES = 'desktop:open-manage-devices';
/** DESKTOP-UX-POLISH: кнопки кастомного тайтлбара (frame:false). */
export const IPC_MINIMIZE_WINDOW = 'desktop:minimize-window';
export const IPC_CLOSE_WINDOW = 'desktop:close-window';

export interface IpcHandlers {
  getStatus(): AgentStatusEvent | null;
  getRuntimeInfo(): DesktopRuntimeInfo;
  getAccount?(): DesktopAccount | null;
  getPlan?(): AgentMePlan | null;
  onCommand(command: DesktopRendererCommand): Promise<void> | void;
  /** Установить скачанное обновление (no-op, если обновления нет). */
  installUpdate?(): void;
  /** W1b: отправить диагностику; `false` — нет согласия или ошибка сети. */
  sendDiagnostics?(): Promise<boolean> | boolean;
  /** T-CLIENT3: применить и сохранить выбранный язык. */
  setLocale?(locale: DesktopLocale): void;
  /** CD-4.3: открыть `/settings/devices` во внешнем браузере. */
  openManageDevices?(): void;
  /** About: подогнать окно под фактическую высоту контента (CSS px). */
  fitAboutWindow?(sender: WebContents, heightCss: number): void;
  /** Status: подогнать окно под фактическую высоту контента (CSS px). */
  fitStatusWindow?(sender: WebContents, heightCss: number): void;
}

/**
 * IPC-allowlist renderer → main (ADR-0011 §7): только `getStatus` и фиксированный
 * набор команд; payload валидируется Zod, отправитель — по локальной странице.
 */
export function registerIpc(
  context: SecurityContext,
  logger: AgentLogger,
  handlers: IpcHandlers,
): void {
  ipcMain.handle(IPC_GET_STATUS, (event) => {
    assertSender(context, logger, event);
    return handlers.getStatus();
  });

  ipcMain.handle(IPC_RUNTIME_INFO, (event) => {
    assertSender(context, logger, event);
    return handlers.getRuntimeInfo();
  });

  ipcMain.handle(IPC_GET_ACCOUNT, (event) => {
    assertSender(context, logger, event);
    return handlers.getAccount?.() ?? null;
  });

  ipcMain.handle(IPC_GET_PLAN, (event) => {
    assertSender(context, logger, event);
    return handlers.getPlan?.() ?? null;
  });

  ipcMain.handle(IPC_COMMAND, (event, payload: unknown) => {
    assertSender(context, logger, event);
    const parsed = desktopRendererCommandRequestSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn('renderer sent an invalid command payload');
      throw new Error('invalid desktop command');
    }
    return handlers.onCommand(parsed.data.command);
  });

  // Отдельный канал (не общий allowlist): установка обновления без аргументов.
  ipcMain.handle(IPC_INSTALL_UPDATE, (event) => {
    assertSender(context, logger, event);
    handlers.installUpdate?.();
  });

  // W1b: диагностика отправляется в API, а не копируется в буфер.
  ipcMain.handle(IPC_SEND_DIAGNOSTICS, async (event) => {
    assertSender(context, logger, event);
    return (await handlers.sendDiagnostics?.()) ?? false;
  });

  // T-CLIENT3: смена языка — валидируем payload по общему контракту locale.
  ipcMain.handle(IPC_SET_LOCALE, (event, payload: unknown) => {
    assertSender(context, logger, event);
    const raw =
      typeof payload === 'object' && payload !== null
        ? (payload as { locale?: unknown }).locale
        : undefined;
    const parsed = desktopLocaleSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('renderer sent an invalid locale');
      throw new Error('invalid locale');
    }
    handlers.setLocale?.(parsed.data);
  });

  // CD-4.3: ссылка «Управление устройствами» из окна (без аргументов).
  ipcMain.handle(IPC_OPEN_MANAGE_DEVICES, (event) => {
    assertSender(context, logger, event);
    handlers.openManageDevices?.();
  });

  // DESKTOP-UX-POLISH: управление окном из кастомного тайтлбара. Действуем на
  // окно-отправитель (status/about), не на фиксированный инстанс.
  ipcMain.handle(IPC_MINIMIZE_WINDOW, (event) => {
    assertSender(context, logger, event);
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle(IPC_CLOSE_WINDOW, (event) => {
    assertSender(context, logger, event);
    // `.close()` уважает существующий обработчик close = hide в трей.
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  // About: ResizeObserver в renderer присылает высоту контента; валидируем и
  // применяем только к окну-отправителю (controller сам сверяет webContents).
  ipcMain.on(ABOUT_FIT_CHANNEL, (event, payload: unknown) => {
    if (!validateSender(context, event)) return;
    if (typeof payload !== 'number' || !Number.isFinite(payload) || payload <= 0) return;
    handlers.fitAboutWindow?.(event.sender, payload);
  });

  // Status: тот же контракт — число > 0, только из своего окна.
  ipcMain.on(STATUS_FIT_CHANNEL, (event, payload: unknown) => {
    if (!validateSender(context, event)) return;
    if (typeof payload !== 'number' || !Number.isFinite(payload) || payload <= 0) return;
    handlers.fitStatusWindow?.(event.sender, payload);
  });
}

export function removeIpc(): void {
  ipcMain.removeHandler(IPC_GET_STATUS);
  ipcMain.removeHandler(IPC_RUNTIME_INFO);
  ipcMain.removeHandler(IPC_GET_ACCOUNT);
  ipcMain.removeHandler(IPC_GET_PLAN);
  ipcMain.removeHandler(IPC_COMMAND);
  ipcMain.removeHandler(IPC_INSTALL_UPDATE);
  ipcMain.removeHandler(IPC_SEND_DIAGNOSTICS);
  ipcMain.removeHandler(IPC_SET_LOCALE);
  ipcMain.removeHandler(IPC_OPEN_MANAGE_DEVICES);
  ipcMain.removeHandler(IPC_MINIMIZE_WINDOW);
  ipcMain.removeHandler(IPC_CLOSE_WINDOW);
  ipcMain.removeAllListeners(ABOUT_FIT_CHANNEL);
  ipcMain.removeAllListeners(STATUS_FIT_CHANNEL);
}

function assertSender(
  context: SecurityContext,
  logger: AgentLogger,
  event: IpcMainInvokeEvent,
): void {
  if (validateSender(context, event)) return;
  logger.warn('rejected IPC from an unexpected sender', {
    url: event.senderFrame?.url ?? event.sender.getURL(),
  });
  throw new Error('sender is not allowed');
}
