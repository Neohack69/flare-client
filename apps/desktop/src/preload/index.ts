import { contextBridge, ipcRenderer } from 'electron';

import type {
  AgentMePlan,
  AgentStatusEvent,
  DesktopAccount,
  DesktopLocale,
  DesktopOutboxCounts,
  DesktopRuntimeInfo,
} from '@flightlog/contracts';

import { ABOUT_FIT_CHANNEL } from '../shared/about-fit.js';
import { STATUS_FIT_CHANNEL } from '../shared/status-fit.js';
import { UPDATE_STATUS_CHANNEL, type UpdateStatus } from '../shared/update-status.js';

const STATUS_CHANNEL = 'desktop:status';
const AGENT_RUNNING_CHANNEL = 'desktop:agent-running';
const AGENT_ERROR_CHANNEL = 'desktop:agent-error';
const OUTBOX_CHANNEL = 'desktop:outbox';
const UPDATE_READY_CHANNEL = 'desktop:update-ready';
const COMMAND_CHANNEL = 'desktop:command';
const INSTALL_UPDATE_CHANNEL = 'desktop:install-update';
const SEND_DIAGNOSTICS_CHANNEL = 'desktop:send-diagnostics';
const GET_STATUS_CHANNEL = 'desktop:get-status';
const RUNTIME_INFO_CHANNEL = 'desktop:runtime-info';
const GET_ACCOUNT_CHANNEL = 'desktop:get-account';
const GET_PLAN_CHANNEL = 'desktop:get-plan';
/** T-CLIENT3: смена языка окна (main → renderer и renderer → main). */
const LOCALE_CHANNEL = 'desktop:locale';
const SET_LOCALE_CHANNEL = 'desktop:set-locale';
/** CD-4.3: проблема устройства (main → renderer) и ссылка на управление. */
const DEVICE_ISSUE_CHANNEL = 'desktop:device-issue';
const OPEN_MANAGE_DEVICES_CHANNEL = 'desktop:open-manage-devices';
/** DESKTOP-UX-POLISH: кнопки кастомного тайтлбара (frame:false). */
const MINIMIZE_WINDOW_CHANNEL = 'desktop:minimize-window';
const CLOSE_WINDOW_CHANNEL = 'desktop:close-window';

type DeviceIssueKind = 'device-limit' | 'machine-mismatch';

function readLocale(): DesktopLocale {
  const arg = process.argv.find((value) => value.startsWith('--flightlog-locale='));
  const raw = arg?.slice('--flightlog-locale='.length);
  if (raw === 'en' || raw === 'ru') return raw;
  return 'ru';
}

function on<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: unknown, value: T): void => callback(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/**
 * Единственный мост renderer ↔ main (ADR-0011 §7): замороженный минимальный API.
 * Ни сырого `ipcRenderer`, ни путей ФС, ни доступа к токену.
 */
const api = Object.freeze({
  isDesktop: true as const,
  platform: process.platform,
  locale: readLocale(),
  getStatus: (): Promise<AgentStatusEvent | null> =>
    ipcRenderer.invoke(GET_STATUS_CHANNEL) as Promise<AgentStatusEvent | null>,
  onStatus: (callback: (event: AgentStatusEvent) => void): (() => void) =>
    on<AgentStatusEvent>(STATUS_CHANNEL, callback),
  getRuntimeInfo: (): Promise<DesktopRuntimeInfo> =>
    ipcRenderer.invoke(RUNTIME_INFO_CHANNEL) as Promise<DesktopRuntimeInfo>,
  /** T-CLIENT2: аккаунт, к которому привязано устройство (или null). */
  getAccount: (): Promise<DesktopAccount | null> =>
    ipcRenderer.invoke(GET_ACCOUNT_CHANNEL) as Promise<DesktopAccount | null>,
  /** iter77: plan для premium-скина (agent-scope, best-effort; null = базовый). */
  getPlan: (): Promise<AgentMePlan | null> =>
    ipcRenderer.invoke(GET_PLAN_CHANNEL) as Promise<AgentMePlan | null>,
  /** T-CLIENT3: явный выбор языка (мгновенно, без перезапуска). */
  setLocale: (locale: DesktopLocale): Promise<void> =>
    ipcRenderer.invoke(SET_LOCALE_CHANNEL, { locale }) as Promise<void>,
  onLocale: (callback: (locale: DesktopLocale) => void): (() => void) =>
    on<DesktopLocale>(LOCALE_CHANNEL, callback),
  onAgentRunning: (callback: (running: boolean) => void): (() => void) =>
    on<boolean>(AGENT_RUNNING_CHANNEL, callback),
  onAgentError: (callback: (error: string | null) => void): (() => void) =>
    on<string | null>(AGENT_ERROR_CHANNEL, callback),
  onOutbox: (callback: (counts: DesktopOutboxCounts) => void): (() => void) =>
    on<DesktopOutboxCounts>(OUTBOX_CHANNEL, callback),
  // T132: готовая версия обновления (строка «установить» в окне статуса).
  onUpdateReady: (callback: (version: string | null) => void): (() => void) =>
    on<string | null>(UPDATE_READY_CHANNEL, callback),
  /** FIX-UPDATE-CHECK-FEEDBACK: статус ручной проверки (checking → итог/ошибка). */
  onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) =>
    on<UpdateStatus>(UPDATE_STATUS_CHANNEL, callback),
  /** About: сообщить main фактическую высоту контента (CSS px) для авто-подгонки. */
  fitAboutWindow: (heightCss: number): void => {
    ipcRenderer.send(ABOUT_FIT_CHANNEL, heightCss);
  },
  /** Status: сообщить main фактическую высоту окна статуса (CSS px) для авто-подгонки. */
  fitStatusWindow: (heightCss: number): void => {
    ipcRenderer.send(STATUS_FIT_CHANNEL, heightCss);
  },
  /** CD-4.3: распознанная проблема устройства (лимит/несовпадение) или null. */
  onDeviceIssue: (callback: (issue: DeviceIssueKind | null) => void): (() => void) =>
    on<DeviceIssueKind | null>(DEVICE_ISSUE_CHANNEL, callback),
  /** CD-4.3: открыть `/settings/devices` во внешнем браузере. */
  openManageDevices: (): Promise<void> =>
    ipcRenderer.invoke(OPEN_MANAGE_DEVICES_CHANNEL) as Promise<void>,
  installUpdate: (): Promise<void> =>
    ipcRenderer.invoke(INSTALL_UPDATE_CHANNEL) as Promise<void>,
  // DESKTOP-UX-POLISH: управление окном из кастомного тайтлбара.
  minimizeWindow: (): Promise<void> =>
    ipcRenderer.invoke(MINIMIZE_WINDOW_CHANNEL) as Promise<void>,
  closeWindow: (): Promise<void> =>
    ipcRenderer.invoke(CLOSE_WINDOW_CHANNEL) as Promise<void>,
  startAgent: (): Promise<void> => ipcRenderer.invoke(COMMAND_CHANNEL, { command: 'start-agent' }),
  stopAgent: (): Promise<void> => ipcRenderer.invoke(COMMAND_CHANNEL, { command: 'stop-agent' }),
  syncNow: (): Promise<void> => ipcRenderer.invoke(COMMAND_CHANNEL, { command: 'sync-now' }),
  openAbout: (): Promise<void> => ipcRenderer.invoke(COMMAND_CHANNEL, { command: 'open-about' }),
  openSite: (): Promise<void> => ipcRenderer.invoke(COMMAND_CHANNEL, { command: 'open-site' }),
  openLogs: (): Promise<void> => ipcRenderer.invoke(COMMAND_CHANNEL, { command: 'open-logs' }),
  copyLogs: (): Promise<void> => ipcRenderer.invoke(COMMAND_CHANNEL, { command: 'copy-log' }),
  /** W1b: отправить обезличенную диагностику в API (только при согласии). */
  sendDiagnostics: (): Promise<boolean> =>
    ipcRenderer.invoke(SEND_DIAGNOSTICS_CHANNEL) as Promise<boolean>,
  copyDiagnostics: (): Promise<void> =>
    ipcRenderer.invoke(COMMAND_CHANNEL, { command: 'copy-diagnostics' }),
  checkUpdates: (): Promise<void> =>
    ipcRenderer.invoke(COMMAND_CHANNEL, { command: 'check-updates' }),
  // T-CLIENT2: подтверждение устройства — только во внешнем браузере.
  openDeviceInBrowser: (): Promise<void> =>
    ipcRenderer.invoke(COMMAND_CHANNEL, { command: 'open-device-browser' }),
  copyUserCode: (): Promise<void> =>
    ipcRenderer.invoke(COMMAND_CHANNEL, { command: 'copy-user-code' }),
  requestDeviceCode: (): Promise<void> =>
    ipcRenderer.invoke(COMMAND_CHANNEL, { command: 'request-device-code' }),
  // T118: opt-in согласие на краш-диагностику (About).
  setErrorReporting: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(COMMAND_CHANNEL, {
      command: enabled ? 'enable-error-reporting' : 'disable-error-reporting',
    }),
});

export type FlightlogBridge = typeof api;

contextBridge.exposeInMainWorld('flightlog', api);
