import type {
  AgentMePlan,
  AgentStatusEvent,
  DesktopAccount,
  DesktopLocale,
  DesktopOutboxCounts,
  DesktopRuntimeInfo,
} from '@flightlog/contracts';

import type { UpdateStatus } from '../shared/update-status.js';

export type DeviceIssueKind = 'device-limit' | 'machine-mismatch';

export interface FlightlogBridge {
  isDesktop: true;
  platform: string;
  locale: DesktopLocale;
  getStatus(): Promise<AgentStatusEvent | null>;
  onStatus(callback: (event: AgentStatusEvent) => void): () => void;
  getRuntimeInfo(): Promise<DesktopRuntimeInfo>;
  /** T-CLIENT2: аккаунт привязки (best-effort). */
  getAccount(): Promise<DesktopAccount | null>;
  /** iter77: план для premium-скина (null — базовый скин). */
  getPlan(): Promise<AgentMePlan | null>;
  /** T-CLIENT3: сменить язык окна (мгновенно, сохраняется в settings.json). */
  setLocale(locale: DesktopLocale): Promise<void>;
  onLocale(callback: (locale: DesktopLocale) => void): () => void;
  onAgentRunning(callback: (running: boolean) => void): () => void;
  onAgentError(callback: (error: string | null) => void): () => void;
  onOutbox(callback: (counts: DesktopOutboxCounts) => void): () => void;
  onUpdateReady(callback: (version: string | null) => void): () => void;
  /** FIX-UPDATE-CHECK-FEEDBACK: статус ручной проверки (checking → итог/ошибка). */
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  /** About: передать main высоту контента (CSS px) для авто-подгонки окна. */
  fitAboutWindow(heightCss: number): void;
  /** Status: передать main высоту окна статуса (CSS px) для авто-подгонки окна. */
  fitStatusWindow(heightCss: number): void;
  /** CD-4.3: проблема устройства (лимит/несовпадение) или null. */
  onDeviceIssue(callback: (issue: DeviceIssueKind | null) => void): () => void;
  /** CD-4.3: открыть `/settings/devices` во внешнем браузере. */
  openManageDevices(): Promise<void>;
  installUpdate(): Promise<void>;
  /** DESKTOP-UX-POLISH: кнопки кастомного тайтлбара. */
  minimizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  startAgent(): Promise<void>;
  stopAgent(): Promise<void>;
  syncNow(): Promise<void>;
  openAbout(): Promise<void>;
  /** «Открыть сайт» — всегда во внешнем браузере (сайт в клиенте не грузится). */
  openSite(): Promise<void>;
  openLogs(): Promise<void>;
  copyLogs(): Promise<void>;
  sendDiagnostics(): Promise<boolean>;
  copyDiagnostics(): Promise<void>;
  checkUpdates(): Promise<void>;
  openDeviceInBrowser(): Promise<void>;
  copyUserCode(): Promise<void>;
  requestDeviceCode(): Promise<void>;
  setErrorReporting(enabled: boolean): Promise<void>;
}

declare global {
  interface Window {
    flightlog?: FlightlogBridge;
  }
}
