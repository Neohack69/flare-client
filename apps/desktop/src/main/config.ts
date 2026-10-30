import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DesktopLocale } from '@flightlog/contracts';

export type DesktopChannel = 'latest' | 'beta';
export type DesktopProtocol = 'sunrise' | 'kittyhawk' | 'fsx_sp2';

export interface DesktopConfig {
  isPackaged: boolean;
  apiUrl: string;
  webUrl: string;
  /** `null` — автообновление выключено (dev или не задан feed). */
  updateFeedUrl: string | null;
  channel: DesktopChannel;
  dataDir: string;
  agentProtocol: DesktopProtocol;
  agentMaxSampleHz: number;
  /** Стартовать агент сразу при запуске приложения (трей-тумблер). */
  agentAutostart: boolean;
  updateCheckIntervalMs: number;
  /** GlitchTip DSN для краш-диагностики; `null` — не настроено (ничего не отправляем). */
  errorReportingDsn: string | null;
  /**
   * T123: файловый лог main/agent-host. По умолчанию `<dataDir>/agent/client.log`.
   * `FLIGHTLOG_LOG_FILE=off` отключает; иной путь — переопределяет.
   */
  logFile: string | null;
  /**
   * Единственный OS-выход клиента — action-required «потеря авторизации
   * устройства» (без него запись молча не работает). Включён по умолчанию;
   * env `FLIGHTLOG_AUTH_ALERTS_ENABLED=0` глушит его на уровне развёртывания.
   * Прочих OS-уведомлений нет; политика — в `notifications.ts`.
   */
  authAlertsEnabled: boolean;
}

export interface ResolveConfigInput {
  env: Record<string, string | undefined>;
  isPackaged: boolean;
  userDataDir: string;
}

export interface NotificationPreferences {
  /** Уведомление о касании с баллом (T105 §3). */
  touchdown: boolean;
  /** Уведомления об ошибках/повторах синхронизации. */
  syncError: boolean;
  /** Уведомление «обновление готово». */
  updates: boolean;
}

/** T118: глобальный hotkey окна «Состояние агента». */
export interface HotkeyPreferences {
  enabled: boolean;
  accelerator: string;
}

export const DEFAULT_HOTKEY: HotkeyPreferences = {
  enabled: true,
  accelerator: 'CommandOrControl+Alt+T',
};

export interface DesktopSettings {
  /** Автозапуск с ПК; по умолчанию включён (T105 §1). */
  autostart: boolean;
  /** Не открывать окно при старте — приложение живёт в трее (T105 §1). */
  startHidden: boolean;
  channel: DesktopChannel;
  autostartAgent: boolean;
  /** Онбординг показан один раз; больше окно не открывается само (T105 §4). */
  onboardingDone: boolean;
  /**
   * Единственный OS-выход — action-required «потеря авторизации устройства»
   * (трей-тумблер «Предупреждать о потере авторизации»). По умолчанию включён.
   */
  authAlerts: boolean;
  notifications: NotificationPreferences;
  /** T118: настраиваемый/отключаемый hotkey окна статуса. */
  hotkey: HotkeyPreferences;
  /** T118: opt-in согласие на отправку краш-диагностики (по умолчанию — нет). */
  errorReportingConsent: boolean;
  /**
   * T-CLIENT3: явный выбор языка клиента (RU/EN). `null` — пользователь ещё не
   * выбирал: берём системную локаль (`app.getLocale()`), но не сохраняем её,
   * чтобы позднее подхватить системную смену.
   */
  locale: DesktopLocale | null;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  autostart: true,
  startHidden: true,
  channel: 'latest',
  autostartAgent: true,
  onboardingDone: false,
  authAlerts: true,
  notifications: {
    touchdown: true,
    syncError: true,
    updates: true,
  },
  hotkey: { ...DEFAULT_HOTKEY },
  errorReportingConsent: false,
  locale: null,
};

// Прод-домены Flare (T-DEP3: сайт https://flyflare.ru, API api.flyflare.ru).
// ВАЖНО: это дефолты упакованной сборки; env `FLIGHTLOG_*` их переопределяет.
export const PROD_API_URL = 'https://api.flyflare.ru';
export const PROD_WEB_URL = 'https://flyflare.ru';
// T-DEP4/T-UPD1: generic update-feed на своём домене (раздаёт сервис `static`).
// electron-updater для generic-провайдера запрашивает `<base>/<channel>.yml`,
// т.е. в проде `https://flyflare.ru/desktop/updates/latest.yml` (канал latest).
// Канал beta читает `beta.yml` из этого же каталога, поэтому суффикс канала
// в URL НЕ добавляем (иначе был бы `<base>/beta/beta.yml`).
export const PROD_UPDATE_BASE = 'https://flyflare.ru/desktop/updates';
export const DEV_API_URL = 'http://localhost:3000';
export const DEV_WEB_URL = 'http://localhost:3001';

const PROTOCOLS: readonly DesktopProtocol[] = ['sunrise', 'kittyhawk', 'fsx_sp2'];

function readString(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeUrl(raw: string, key: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${key} must be a valid URL (got "${raw}")`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${key} must use http or https`);
  }
  return url.toString().replace(/\/+$/, '');
}

function readBool(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function readInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`${key} must be an integer between ${bounds.min} and ${bounds.max}`);
  }
  return value;
}

export function readChannel(env: Record<string, string | undefined>): DesktopChannel {
  const raw = readString(env, 'FLIGHTLOG_CHANNEL')?.toLowerCase();
  return raw === 'beta' ? 'beta' : 'latest';
}

export function readProtocol(env: Record<string, string | undefined>): DesktopProtocol {
  const raw = readString(env, 'SIMCONNECT_PROTOCOL')?.toLowerCase();
  if (raw && (PROTOCOLS as readonly string[]).includes(raw)) return raw as DesktopProtocol;
  return 'sunrise';
}

/**
 * Единый конфиг main-процесса (ADR-0011 §4). Dev-переопределения — только env
 * (`.env.local` подставляет electron-vite в dev; prod-сборка его не читает).
 */
export function resolveDesktopConfig(input: ResolveConfigInput): DesktopConfig {
  const { env, isPackaged, userDataDir } = input;
  const channel = readChannel(env);
  const apiUrl = normalizeUrl(
    readString(env, 'FLIGHTLOG_API_URL') ?? (isPackaged ? PROD_API_URL : DEV_API_URL),
    'FLIGHTLOG_API_URL',
  );
  const webUrl = normalizeUrl(
    readString(env, 'FLIGHTLOG_WEB_URL') ?? (isPackaged ? PROD_WEB_URL : DEV_WEB_URL),
    'FLIGHTLOG_WEB_URL',
  );
  const updateFeedUrlRaw =
    readString(env, 'FLIGHTLOG_UPDATE_URL') ??
    (isPackaged ? PROD_UPDATE_BASE : undefined);
  const dataDir = readString(env, 'FLIGHTLOG_DATA_DIR') ?? userDataDir;

  return {
    isPackaged,
    apiUrl,
    webUrl,
    updateFeedUrl: updateFeedUrlRaw ? normalizeUrl(updateFeedUrlRaw, 'FLIGHTLOG_UPDATE_URL') : null,
    channel,
    dataDir,
    agentProtocol: readProtocol(env),
    agentMaxSampleHz: readInt(env, 'AGENT_MAX_SAMPLE_HZ', 20, { min: 1, max: 60 }),
    agentAutostart: readBool(env, 'FLIGHTLOG_AGENT_AUTOSTART', true),
    // T-UPD-CADENCE: 30 мин — свежий релиз замечается в пределах получаса;
    // env `FLIGHTLOG_UPDATE_INTERVAL_MS` по-прежнему переопределяет дефолт.
    updateCheckIntervalMs: readInt(env, 'FLIGHTLOG_UPDATE_INTERVAL_MS', 30 * 60 * 1000, {
      min: 60_000,
      max: 7 * 24 * 60 * 60 * 1000,
    }),
    errorReportingDsn: readDsn(env),
    logFile: readLogFile(env, dataDir),
    authAlertsEnabled: readBool(env, 'FLIGHTLOG_AUTH_ALERTS_ENABLED', true),
  };
}

const DISABLED_LOG_VALUES = new Set(['0', 'off', 'false', 'none', 'disabled']);

/** T123: файл лога рядом с data-dir; `off` выключает запись. */
function readLogFile(env: Record<string, string | undefined>, dataDir: string): string | null {
  const raw = readString(env, 'FLIGHTLOG_LOG_FILE');
  if (raw === undefined) return join(dataDir, 'agent', 'client.log');
  if (DISABLED_LOG_VALUES.has(raw.toLowerCase())) return null;
  return raw;
}

/** GlitchTip/Sentry DSN из env; `null`, если не задан. Невалидный — ошибка конфига. */
function readDsn(env: Record<string, string | undefined>): string | null {
  const raw = readString(env, 'GLITCHTIP_DSN');
  if (raw === undefined) return null;
  return normalizeUrl(raw, 'GLITCHTIP_DSN');
}

export function settingsPath(dataDir: string): string {
  return join(dataDir, 'settings.json');
}

/**
 * T-CLIENT3: язык при старте. Приоритет — явный выбор пользователя
 * (`settings.locale`) → системная локаль (`ru*` → ru, иначе en).
 */
export function resolveInitialLocale(
  settings: Pick<DesktopSettings, 'locale'>,
  systemLocale: string | undefined | null,
): DesktopLocale {
  if (settings.locale) return settings.locale;
  return systemLocale?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function loadSettings(dataDir: string): DesktopSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(dataDir), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SETTINGS };
    const record = parsed as Record<string, unknown>;
    const notifications =
      typeof record.notifications === 'object' && record.notifications !== null
        ? (record.notifications as Record<string, unknown>)
        : {};
    const readPref = (key: keyof NotificationPreferences): boolean =>
      typeof notifications[key] === 'boolean'
        ? (notifications[key] as boolean)
        : DEFAULT_SETTINGS.notifications[key];
    const hotkey =
      typeof record.hotkey === 'object' && record.hotkey !== null
        ? (record.hotkey as Record<string, unknown>)
        : {};
    const accelerator =
      typeof hotkey.accelerator === 'string' && hotkey.accelerator.trim().length > 0
        ? hotkey.accelerator.trim()
        : DEFAULT_HOTKEY.accelerator;
    return {
      autostart:
        typeof record.autostart === 'boolean' ? record.autostart : DEFAULT_SETTINGS.autostart,
      startHidden:
        typeof record.startHidden === 'boolean' ? record.startHidden : DEFAULT_SETTINGS.startHidden,
      channel: record.channel === 'beta' ? 'beta' : 'latest',
      autostartAgent:
        typeof record.autostartAgent === 'boolean'
          ? record.autostartAgent
          : DEFAULT_SETTINGS.autostartAgent,
      onboardingDone: record.onboardingDone === true,
      authAlerts:
        typeof record.authAlerts === 'boolean' ? record.authAlerts : DEFAULT_SETTINGS.authAlerts,
      notifications: {
        touchdown: readPref('touchdown'),
        syncError: readPref('syncError'),
        updates: readPref('updates'),
      },
      hotkey: {
        enabled:
          typeof hotkey.enabled === 'boolean' ? hotkey.enabled : DEFAULT_SETTINGS.hotkey.enabled,
        accelerator,
      },
      errorReportingConsent:
        typeof record.errorReportingConsent === 'boolean'
          ? record.errorReportingConsent
          : DEFAULT_SETTINGS.errorReportingConsent,
      locale:
        record.locale === 'ru' || record.locale === 'en' ? record.locale : DEFAULT_SETTINGS.locale,
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      notifications: { ...DEFAULT_SETTINGS.notifications },
      hotkey: { ...DEFAULT_SETTINGS.hotkey },
    };
  }
}

export function saveSettings(dataDir: string, settings: DesktopSettings): void {
  writeFileSync(settingsPath(dataDir), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}
