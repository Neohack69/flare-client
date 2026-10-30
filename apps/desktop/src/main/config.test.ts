import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  loadSettings,
  resolveDesktopConfig,
  resolveInitialLocale,
  saveSettings,
} from './config';

describe('resolveDesktopConfig (ADR-0011 §4)', () => {
  it('dev-дефолты: локальные API/UI, автообновление выключено', () => {
    const config = resolveDesktopConfig({ env: {}, isPackaged: false, userDataDir: 'C:/data' });
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.webUrl).toBe('http://localhost:3001');
    expect(config.updateFeedUrl).toBeNull();
    expect(config.dataDir).toBe('C:/data');
    expect(config.agentProtocol).toBe('sunrise');
    expect(config.agentAutostart).toBe(true);
    // T132: единственный OS-выход (action-required) включён по умолчанию.
    expect(config.authAlertsEnabled).toBe(true);
  });

  it('auth-алерты глушатся только явным env-флагом', () => {
    const on = resolveDesktopConfig({
      env: { FLIGHTLOG_AUTH_ALERTS_ENABLED: '1' },
      isPackaged: true,
      userDataDir: 'C:/data',
    });
    expect(on.authAlertsEnabled).toBe(true);
    const off = resolveDesktopConfig({
      env: { FLIGHTLOG_AUTH_ALERTS_ENABLED: '0' },
      isPackaged: true,
      userDataDir: 'C:/data',
    });
    expect(off.authAlertsEnabled).toBe(false);
  });

  it('prod-дефолты: прод-URL и generic-feed по каналу', () => {
    const config = resolveDesktopConfig({
      env: { FLIGHTLOG_CHANNEL: 'beta' },
      isPackaged: true,
      userDataDir: 'C:/data',
    });
    expect(config.apiUrl).toBe('https://api.flyflare.ru');
    expect(config.webUrl).toBe('https://flyflare.ru');
    // T-DEP4: generic-feed — база без суффикса канала; electron-updater сам
    // запрашивает `<base>/<channel>.yml` (`beta.yml` для канала beta).
    expect(config.updateFeedUrl).toBe('https://flyflare.ru/desktop/updates');
    expect(config.channel).toBe('beta');
  });

  it('T-DEP4: FLIGHTLOG_UPDATE_URL переопределяет запечённый фид', () => {
    const config = resolveDesktopConfig({
      env: { FLIGHTLOG_UPDATE_URL: 'https://staging.example/feed/' },
      isPackaged: true,
      userDataDir: 'C:/data',
    });
    expect(config.updateFeedUrl).toBe('https://staging.example/feed');
  });

  it('env-переопределения в dev', () => {
    const config = resolveDesktopConfig({
      env: {
        FLIGHTLOG_WEB_URL: 'http://localhost:4001',
        SIMCONNECT_PROTOCOL: 'kittyhawk',
        AGENT_MAX_SAMPLE_HZ: '5',
        FLIGHTLOG_AGENT_AUTOSTART: '0',
        FLIGHTLOG_DATA_DIR: 'C:/custom',
      },
      isPackaged: false,
      userDataDir: 'C:/data',
    });
    expect(config.webUrl).toBe('http://localhost:4001');
    expect(config.agentProtocol).toBe('kittyhawk');
    expect(config.agentMaxSampleHz).toBe(5);
    expect(config.agentAutostart).toBe(false);
    expect(config.dataDir).toBe('C:/custom');
  });

  it('T-UPD-CADENCE: дефолт периодической проверки обновлений — 30 мин; env переопределяет', () => {
    const defaults = resolveDesktopConfig({ env: {}, isPackaged: true, userDataDir: 'C:/data' });
    expect(defaults.updateCheckIntervalMs).toBe(30 * 60 * 1000);

    const override = resolveDesktopConfig({
      env: { FLIGHTLOG_UPDATE_INTERVAL_MS: '900000' },
      isPackaged: true,
      userDataDir: 'C:/data',
    });
    expect(override.updateCheckIntervalMs).toBe(900_000);
  });

  it('отклоняет невалидные URL и числа', () => {
    expect(() =>
      resolveDesktopConfig({
        env: { FLIGHTLOG_API_URL: 'not-a-url' },
        isPackaged: false,
        userDataDir: 'C:/data',
      }),
    ).toThrow();
    expect(() =>
      resolveDesktopConfig({
        env: { AGENT_MAX_SAMPLE_HZ: '999' },
        isPackaged: false,
        userDataDir: 'C:/data',
      }),
    ).toThrow();
  });

  it('T118: GlitchTip DSN из env; отсутствие — null, невалидный — ошибка', () => {
    const noDsn = resolveDesktopConfig({ env: {}, isPackaged: false, userDataDir: 'C:/data' });
    expect(noDsn.errorReportingDsn).toBeNull();
    const withDsn = resolveDesktopConfig({
      env: { GLITCHTIP_DSN: 'https://key@glitchtip.test/1' },
      isPackaged: false,
      userDataDir: 'C:/data',
    });
    expect(withDsn.errorReportingDsn).toBe('https://key@glitchtip.test/1');
    expect(() =>
      resolveDesktopConfig({
        env: { GLITCHTIP_DSN: 'not-a-url' },
        isPackaged: false,
        userDataDir: 'C:/data',
      }),
    ).toThrow();
  });

  it('T123: файловый лог по умолчанию рядом с data-dir; off отключает; путь переопределяется', () => {
    const defaults = resolveDesktopConfig({ env: {}, isPackaged: false, userDataDir: 'C:/data' });
    expect(defaults.logFile).toBe(join('C:/data', 'agent', 'client.log'));

    const disabled = resolveDesktopConfig({
      env: { FLIGHTLOG_LOG_FILE: 'off' },
      isPackaged: false,
      userDataDir: 'C:/data',
    });
    expect(disabled.logFile).toBeNull();

    const custom = resolveDesktopConfig({
      env: { FLIGHTLOG_LOG_FILE: 'D:/logs/client.log' },
      isPackaged: false,
      userDataDir: 'C:/data',
    });
    expect(custom.logFile).toBe('D:/logs/client.log');
  });
});

describe('settings.json', () => {
  it('дефолты (T105): автозапуск включён, старт в трее, уведомления включены', () => {
    expect(DEFAULT_SETTINGS.autostart).toBe(true);
    expect(DEFAULT_SETTINGS.startHidden).toBe(true);
    expect(DEFAULT_SETTINGS.onboardingDone).toBe(false);
    // T132: action-required включён по умолчанию.
    expect(DEFAULT_SETTINGS.authAlerts).toBe(true);
    expect(DEFAULT_SETTINGS.notifications).toEqual({
      touchdown: true,
      syncError: true,
      updates: true,
    });
    expect(DEFAULT_SETTINGS.hotkey).toEqual({
      enabled: true,
      accelerator: 'CommandOrControl+Alt+T',
    });
    expect(DEFAULT_SETTINGS.errorReportingConsent).toBe(false);
    // T-CLIENT3: язык не выбран явно — подхватывается системная локаль.
    expect(DEFAULT_SETTINGS.locale).toBeNull();
  });

  it('дефолты и roundtrip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flightlog-settings-'));
    try {
      expect(loadSettings(dir)).toEqual(DEFAULT_SETTINGS);
      saveSettings(dir, {
        ...DEFAULT_SETTINGS,
        autostart: false,
        channel: 'beta',
        onboardingDone: true,
        authAlerts: false,
        locale: 'en',
        notifications: { touchdown: false, syncError: true, updates: false },
        hotkey: { enabled: false, accelerator: 'Ctrl+Shift+T' },
        errorReportingConsent: true,
      });
      const loaded = loadSettings(dir);
      expect(loaded.autostart).toBe(false);
      expect(loaded.channel).toBe('beta');
      expect(loaded.autostartAgent).toBe(true);
      expect(loaded.onboardingDone).toBe(true);
      expect(loaded.authAlerts).toBe(false);
      expect(loaded.locale).toBe('en');
      expect(loaded.notifications).toEqual({
        touchdown: false,
        syncError: true,
        updates: false,
      });
      expect(loaded.hotkey).toEqual({ enabled: false, accelerator: 'Ctrl+Shift+T' });
      expect(loaded.errorReportingConsent).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T118: частичный hotkey/consent добивается дефолтами', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flightlog-settings-'));
    try {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ hotkey: { enabled: false }, errorReportingConsent: true }),
        'utf8',
      );
      const loaded = loadSettings(dir);
      expect(loaded.hotkey.enabled).toBe(false);
      expect(loaded.hotkey.accelerator).toBe('CommandOrControl+Alt+T');
      expect(loaded.errorReportingConsent).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('частичный settings.json добивается дефолтами', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flightlog-settings-'));
    try {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ onboardingDone: true }), 'utf8');
      const loaded = loadSettings(dir);
      expect(loaded.onboardingDone).toBe(true);
      expect(loaded.autostart).toBe(true);
      expect(loaded.startHidden).toBe(true);
      // T132: старая settings.json без authAlerts добивается включённым.
      expect(loaded.authAlerts).toBe(true);
      expect(loaded.notifications.touchdown).toBe(true);
      // T-CLIENT3: старая settings.json без locale → явного выбора нет.
      expect(loaded.locale).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('старая settings.json с удалённым syncOk не ломает загрузку (ключ игнорируется)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flightlog-settings-'));
    try {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ notifications: { touchdown: false, syncOk: false, updates: false } }),
        'utf8',
      );
      const loaded = loadSettings(dir);
      expect(loaded.notifications).toEqual({ touchdown: false, syncError: true, updates: false });
      expect(loaded.notifications).not.toHaveProperty('syncOk');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T-CLIENT3: невалидная/чужая locale трактуется как «не выбрано»', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flightlog-settings-'));
    try {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ locale: 'de' }), 'utf8');
      expect(loadSettings(dir).locale).toBeNull();
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ locale: 42 }), 'utf8');
      expect(loadSettings(dir).locale).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveInitialLocale (T-CLIENT3)', () => {
  it('явный выбор в клиенте важнее системной локали', () => {
    expect(resolveInitialLocale({ locale: 'en' }, 'ru-RU')).toBe('en');
    expect(resolveInitialLocale({ locale: 'ru' }, 'en-US')).toBe('ru');
  });

  it('без явного выбора — системная локаль (ru* → ru, иначе en)', () => {
    expect(resolveInitialLocale({ locale: null }, 'ru-RU')).toBe('ru');
    expect(resolveInitialLocale({ locale: null }, 'ru')).toBe('ru');
    expect(resolveInitialLocale({ locale: null }, 'en-US')).toBe('en');
    expect(resolveInitialLocale({ locale: null }, 'de-DE')).toBe('en');
    expect(resolveInitialLocale({ locale: null }, undefined)).toBe('en');
  });
});
