import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({
  tooltip: '',
  menu: [] as Array<Record<string, unknown>>,
  click: null as (() => void) | null,
  rightClick: null as (() => void) | null,
}));

vi.mock('electron', () => {
  class Tray {
    constructor(public readonly image: unknown) {}
    on(event: string, listener: () => void): this {
      if (event === 'click') electronState.click = listener;
      if (event === 'right-click') electronState.rightClick = listener;
      return this;
    }
    setContextMenu(menu: unknown): void {
      electronState.menu = menu as Array<Record<string, unknown>>;
    }
    setToolTip(text: string): void {
      electronState.tooltip = text;
    }
    destroy(): void {}
  }
  const nativeImage = {
    createFromBitmap: () => ({
      addRepresentation: () => undefined,
      toPNG: () => Buffer.alloc(128),
    }),
  };
  return {
    Menu: { buildFromTemplate: (template: Array<Record<string, unknown>>) => template },
    Tray,
    nativeImage,
  };
});

import { deriveTrayState, TrayController } from './tray';

function makeController() {
  const callbacks = {
    onOpenStatus: vi.fn(),
    onMenuOpen: vi.fn(),
    onOpenSite: vi.fn(),
    onToggleAgent: vi.fn(),
    onSyncNow: vi.fn(),
    onCheckUpdates: vi.fn(),
    onInstallUpdate: vi.fn(),
    onAbout: vi.fn(),
    onQuit: vi.fn(),
    onToggleAutostart: vi.fn(),
    onToggleAuthAlerts: vi.fn(),
    onToggleNotification: vi.fn(),
    onCopyUserCode: vi.fn(),
    onOpenDeviceInBrowser: vi.fn(),
    onSetLocale: vi.fn(),
  };
  const controller = new TrayController(callbacks, {
    agentRunning: true,
    recording: false,
    autostart: true,
    authAlerts: true,
    notifications: { touchdown: true, syncError: true, updates: true },
    updateReady: null,
    locale: 'ru',
    iconVariant: 'dark',
    simSource: 'waiting',
    openStatusAccelerator: null,
  });
  controller.create();
  return { controller, callbacks };
}

beforeEach(() => {
  electronState.tooltip = '';
  electronState.menu = [];
  electronState.click = null;
  electronState.rightClick = null;
});

describe('deriveTrayState', () => {
  it('агент выключен → not_started; host fatal → agent_error', () => {
    expect(deriveTrayState(null, false, false, false)).toBe('not_started');
    expect(deriveTrayState({ state: 'recording' }, true, true, true)).toBe('agent_error');
  });

  it('recording важнее sync_error (вторичный индикатор)', () => {
    expect(deriveTrayState({ state: 'sync_error', quality: 'retryable' }, true, true, false)).toBe(
      'recording',
    );
    expect(deriveTrayState({ state: 'sync_error', quality: 'fatal' }, true, false, false)).toBe(
      'sync_error',
    );
  });
});

describe('TrayController (desktop-client.md §4)', () => {
  it('left-click открывает окно статуса', () => {
    const { callbacks } = makeController();
    electronState.click?.();
    expect(callbacks.onOpenStatus).toHaveBeenCalledTimes(1);
  });

  it('T-UPD-CADENCE: right-click (открытие меню трея) → onMenuOpen, без onOpenStatus', () => {
    const { callbacks } = makeController();
    electronState.rightClick?.();
    expect(callbacks.onMenuOpen).toHaveBeenCalledTimes(1);
    expect(callbacks.onOpenStatus).not.toHaveBeenCalled();
  });

  it('тултип ≤127 символов и обновляется по состоянию', () => {
    const { controller } = makeController();
    controller.setStatus({
      state: 'recording',
      aircraftIcao: 'B738',
      pendingCounts: counts(12480),
    });
    expect(electronState.tooltip.length).toBeLessThanOrEqual(127);
    expect(electronState.tooltip).toContain('B738');
    controller.setStatus({ state: 'sim_waiting' });
    // Ожидание обобщённое (источник `waiting` = auto): имя сима не навязываем.
    expect(electronState.tooltip).toContain('ожидание данных симулятора');
    expect(electronState.tooltip).not.toContain('MSFS');
  });

  it('XC-SIM-AGNOSTIC: tray does not surface sim name', () => {
    const { controller } = makeController();
    controller.setStatus({ state: 'sim_waiting' });
    controller.setSimSource('waiting_msfs2024');
    expect(electronState.tooltip).not.toContain('MSFS');
    controller.setSimSource('waiting_xplane12');
    expect(electronState.tooltip).not.toContain('X-Plane');
  });

  it('tray menu does not duplicate telemetry source', () => {
    const { controller } = makeController();
    controller.setSimSource('xplane12');
    expect(
      electronState.menu.some(
        (item) => typeof item.label === 'string' && item.label.includes('X-Plane'),
      ),
    ).toBe(false);
    expect(electronState.tooltip).not.toContain('X-Plane');
  });

  it('меню содержит пункты §4.3 и динамический update-пункт', () => {
    const { controller } = makeController();
    controller.setUpdateReady('1.2.3');
    const labels = electronState.menu.map((item) => String(item.label ?? item.type));
    expect(labels).toContain('Открыть «Состояние приложения»');
    expect(labels).toContain('Открыть сайт');
    expect(labels).toContain('Синхронизировать сейчас');
    expect(labels).toContain('О программе');
    expect(labels).toContain('Выход');
    expect(labels).toContain('Перезапустить и обновить (1.2.3)');
  });

  it('обновление не показывается в трее, пока файл качается (тихая загрузка)', () => {
    const { controller } = makeController();
    controller.setStatus({ state: 'sync_ok' });
    const labels = electronState.menu.map((item) => String(item.label ?? ''));
    expect(labels.some((label) => label.includes('скачивается'))).toBe(false);
    // API «доступно/скачивается» удалено — пункт есть только для готовой версии.
    expect((controller as { setUpdateAvailable?: unknown }).setUpdateAvailable).toBeUndefined();
  });

  it('готовое обновление показывает пункт установки (без «скачивается»)', () => {
    const { controller } = makeController();
    controller.setUpdateReady('1.2.3');
    const labels = electronState.menu.map((item) => String(item.label ?? ''));
    expect(labels).toContain('Перезапустить и обновить (1.2.3)');
    expect(labels.some((label) => label.includes('скачивается'))).toBe(false);
  });

  it('тумблер action-required (потеря авторизации) работает', () => {
    const { controller, callbacks } = makeController();
    controller.setStatus({ state: 'sync_ok' });
    const labels = electronState.menu.map((item) => String(item.label ?? item.type));
    expect(labels).toContain('Предупреждать о потере авторизации');
    expect(labels.some((label) => label.includes('Автозапуск'))).toBe(true);

    const toggle = electronState.menu.find(
      (item) => item.label === 'Предупреждать о потере авторизации',
    );
    expect(toggle?.type).toBe('checkbox');
    expect(toggle?.checked).toBe(true);
    (toggle?.click as (() => void) | undefined)?.();
    expect(callbacks.onToggleAuthAlerts).toHaveBeenCalledWith(false);

    controller.setAuthAlerts(false);
    const after = electronState.menu.find(
      (item) => item.label === 'Предупреждать о потере авторизации',
    );
    expect(after?.checked).toBe(false);
  });

  it('CD-4.1: подменю «Уведомления» с 3 отдельными тумблерами (RU)', () => {
    const { controller, callbacks } = makeController();
    controller.setStatus({ state: 'sync_ok' });
    const notifications = electronState.menu.find((item) => item.label === 'Уведомления');
    const submenu = notifications?.submenu as Array<Record<string, unknown>> | undefined;
    expect(submenu).toHaveLength(3);
    expect(submenu?.map((item) => item.label)).toEqual([
      'Посадки и оценки',
      'Ошибки синхронизации',
      'Обновления',
    ]);
    for (const item of submenu ?? []) {
      expect(item.type).toBe('checkbox');
      expect(item.checked).toBe(true);
    }
    (submenu?.[0]?.click as (() => void) | undefined)?.();
    expect(callbacks.onToggleNotification).toHaveBeenCalledWith('touchdown', false);
  });

  it('при recording update-пункт disabled с причиной', () => {
    const { controller } = makeController();
    controller.setUpdateReady('1.2.3');
    controller.setRecording(true);
    controller.setStatus({ state: 'recording' });
    const update = electronState.menu.find((item) =>
      String(item.label ?? '').includes('завершения полёта'),
    );
    expect(update).toBeDefined();
    expect(update?.enabled).toBe(false);
    expect(update?.toolTip).toBeTruthy();
  });

  it('auth_required показывает код и device-пункты (T116)', () => {
    const { controller, callbacks } = makeController();
    controller.setUserCode('WXYZ-1234', Date.now() + 600_000);
    controller.setStatus({ state: 'auth_required' });

    const labels = electronState.menu.map((item) => String(item.label ?? item.type));
    expect(labels.some((label) => label.includes('WXYZ-1234'))).toBe(true);
    expect(labels).toContain('Скопировать код');
    expect(labels).toContain('Открыть в браузере');
    expect(labels).not.toContain('Ввести код в приложении');
    expect(electronState.tooltip).toContain('WXYZ-1234');

    const copy = electronState.menu.find((item) => item.label === 'Скопировать код');
    (copy?.click as (() => void) | undefined)?.();
    expect(callbacks.onCopyUserCode).toHaveBeenCalledTimes(1);

    const browser = electronState.menu.find((item) => item.label === 'Открыть в браузере');
    (browser?.click as (() => void) | undefined)?.();
    expect(callbacks.onOpenDeviceInBrowser).toHaveBeenCalledTimes(1);
  });

  it('ён-локаль меняет подписи', () => {
    const callbacks = {
      onOpenStatus: vi.fn(),
      onMenuOpen: vi.fn(),
      onOpenSite: vi.fn(),
      onToggleAgent: vi.fn(),
      onSyncNow: vi.fn(),
      onCheckUpdates: vi.fn(),
      onInstallUpdate: vi.fn(),
      onAbout: vi.fn(),
      onQuit: vi.fn(),
      onToggleAutostart: vi.fn(),
      onToggleAuthAlerts: vi.fn(),
      onToggleNotification: vi.fn(),
      onCopyUserCode: vi.fn(),
      onOpenDeviceInBrowser: vi.fn(),
      onSetLocale: vi.fn(),
    };
    const controller = new TrayController(callbacks, {
      agentRunning: true,
      recording: false,
      autostart: true,
      authAlerts: true,
      notifications: { touchdown: true, syncError: true, updates: true },
      updateReady: null,
      locale: 'en',
      iconVariant: 'light',
      simSource: 'waiting',
      openStatusAccelerator: 'CommandOrControl+Alt+T',
    });
    controller.create();
    const labels = electronState.menu.map((item) => String(item.label ?? ''));
    expect(labels).toContain('Open “App status”');
    expect(electronState.tooltip.startsWith('Flare')).toBe(true);
    const openStatus = electronState.menu.find((item) => item.label === 'Open “App status”');
    expect(openStatus?.accelerator).toBe('CommandOrControl+Alt+T');
    expect(openStatus?.registerAccelerator).toBe(false);
  });

  it('T-CLIENT3: setLocale мгновенно переводит меню и тултип без пересоздания трея', () => {
    const { controller } = makeController();
    expect(electronState.menu.map((item) => String(item.label ?? '')).includes('Выход')).toBe(true);

    controller.setLocale('en');
    const labels = electronState.menu.map((item) => String(item.label ?? ''));
    expect(labels).toContain('Quit');
    expect(labels).toContain('About');
    expect(labels).not.toContain('Выход');
    // Тултип тоже переведён (RU → EN).
    controller.setStatus({ state: 'sim_waiting' });
    expect(electronState.tooltip).toContain('waiting for');
  });

  it('T-CLIENT3: подменю «Язык» с radio-выбором Русский/English (канон §4.3)', () => {
    const { callbacks } = makeController();
    const language = electronState.menu.find((item) => item.label === 'Язык');
    const submenu = language?.submenu as Array<Record<string, unknown>> | undefined;
    expect(submenu).toHaveLength(2);
    expect(submenu?.[0]).toMatchObject({ type: 'radio', checked: true });
    expect(submenu?.[1]).toMatchObject({ type: 'radio', checked: false });

    (submenu?.[1]?.click as (() => void) | undefined)?.();
    expect(callbacks.onSetLocale).toHaveBeenCalledWith('en');
  });

  it('F2: план-префикс в disabled статус-строке (Pro/Trial/Lifetime, Free без)', () => {
    const { controller } = makeController();
    controller.setStatus({ state: 'sim_waiting' });

    controller.setPlan({ code: 'pro', name: 'Pro' });
    expect(electronState.menu[0]?.label).toBe('Pro · Ожидание данных симулятора');

    controller.setPlan({
      code: 'pro',
      name: 'Pro',
      trial: {
        active: true,
        ends_at: '2026-10-25T12:00:00.000Z',
        days_left: 2,
        ai_reports_remaining: 8,
      },
    });
    expect(electronState.menu[0]?.label).toBe('Trial · Ожидание данных симулятора');
    expect(String(electronState.menu[0]?.label)).not.toContain('дн');

    controller.setPlan({ code: 'lifetime', name: 'Lifetime' });
    expect(electronState.menu[0]?.label).toBe('Lifetime · Ожидание данных симулятора');

    controller.setPlan({ code: 'free', name: 'Free' });
    expect(electronState.menu[0]?.label).toBe('Ожидание данных симулятора');
    controller.setPlan(null);
    expect(electronState.menu[0]?.label).toBe('Ожидание данных симулятора');
  });

  it('F2: план-префикс локализован (EN) и не меняет тултип', () => {
    const { controller } = makeController();
    controller.setLocale('en');
    controller.setStatus({ state: 'sim_waiting' });
    const tooltip = electronState.tooltip;
    controller.setPlan({ code: 'pro', name: 'Pro' });
    expect(electronState.menu[0]?.label).toBe('Pro · Waiting for simulator data');
    expect(electronState.tooltip).toBe(tooltip);
  });
});

function counts(pendingPoints: number) {
  return {
    flights: 0,
    points: pendingPoints,
    events: 0,
    pendingFlights: 0,
    pendingPoints,
    pendingEvents: 0,
  };
}
