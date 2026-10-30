import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentStatusEvent } from '@flightlog/contracts';

import type { NotificationPreferences } from './config';
import {
  activateNotification,
  ACTION_REQUIRED_THROTTLE_MS,
  DEVICE_ISSUE_THROTTLE_MS,
  Notifier,
  TOUCHDOWN_MIN_INTERVAL_MS,
  type NotificationActivateHandlers,
  type NotificationTarget,
  type SuppressedNotification,
} from './notifications';

const state = vi.hoisted(() => ({
  shown: [] as Array<{
    title: string;
    body: string;
    silent: boolean;
    click: (() => void) | null;
  }>,
}));

vi.mock('electron', () => {
  class Notification {
    static isSupported(): boolean {
      return true;
    }
    private clickHandler: (() => void) | null = null;
    constructor(
      private readonly options: { title: string; body: string; silent?: boolean },
    ) {}
    on(event: string, listener: () => void): this {
      if (event === 'click') this.clickHandler = listener;
      return this;
    }
    show(): void {
      state.shown.push({
        title: this.options.title,
        body: this.options.body,
        silent: this.options.silent === true,
        click: this.clickHandler,
      });
    }
  }
  return { Notification };
});

beforeEach(() => {
  state.shown.length = 0;
});

const ALL_ON: NotificationPreferences = {
  touchdown: true,
  syncError: true,
  updates: true,
};

function makeNotifier(options: {
  now?: () => number;
  enabled?: boolean;
  preferences?: Partial<NotificationPreferences>;
  locale?: 'ru' | 'en';
  onActivate?: (target: NotificationTarget) => void;
  onSuppressed?: (info: SuppressedNotification) => void;
} = {}): Notifier {
  return new Notifier({
    enabled: () => options.enabled ?? true,
    preferences: () => ({ ...ALL_ON, ...(options.preferences ?? {}) }),
    locale: () => options.locale ?? 'ru',
    now: options.now ?? (() => 1_000_000),
    onActivate: options.onActivate,
    onSuppressed: options.onSuppressed,
  });
}

describe('CD-4.1: политика тостов (событие → показ)', () => {
  const cases: Array<{ name: string; event: AgentStatusEvent; expected: number }> = [
    {
      name: 'касание с баллом/грейдом',
      event: { state: 'touchdown', grade: 'good', score: 87, vsFpm: -142, bounceCount: 0 },
      expected: 1,
    },
    {
      name: 'старт записи — молча',
      event: { state: 'recording', flightId: '123e4567-e89b-42d3-a456-426614174000' },
      expected: 0,
    },
    {
      name: 'завершение рейса (sync_reason=flight_ended) — тоста нет',
      event: {
        state: 'sync_ok',
        syncReason: 'flight_ended',
        uploadedFlights: 1,
        uploadedPoints: 320,
      },
      expected: 0,
    },
    {
      name: 'фоновый автосинк (interval) — молча',
      event: { state: 'sync_ok', syncReason: 'interval', uploadedFlights: 3, uploadedPoints: 100 },
      expected: 0,
    },
    {
      name: 'сессия без отрыва (discarded) — молча',
      event: { state: 'sync_ok', syncReason: 'other', flightDiscarded: true },
      expected: 0,
    },
    {
      name: 'синк при старте (startup) — молча',
      event: { state: 'sync_ok', syncReason: 'startup' },
      expected: 0,
    },
    {
      name: 'fatal-ошибка авторизации (action-required)',
      event: { state: 'sync_error', quality: 'fatal' },
      expected: 1,
    },
    {
      name: 'транзиентная ошибка синка — молча',
      event: { state: 'sync_error', quality: 'retryable', message: 'нет сети' },
      expected: 0,
    },
    { name: 'ожидание сима — молча', event: { state: 'sim_waiting' }, expected: 0 },
  ];

  it.each(cases)('$name → $expected уведомление(й)', ({ event, expected }) => {
    makeNotifier().onStatus(event);
    expect(state.shown).toHaveLength(expected);
  });

  it('needsRepair (MACHINE_MISMATCH) не дублируется action-required', () => {
    makeNotifier().onStatus({
      state: 'sync_error',
      quality: 'fatal',
      needsRepair: true,
    } as AgentStatusEvent);
    expect(state.shown).toHaveLength(0);
  });

  it('готовность обновления — actionable-тост с новой формулировкой', () => {
    makeNotifier().updateReady('0.2.0');
    expect(state.shown).toHaveLength(1);
    expect(state.shown[0]?.title).toBe('Обновление Flare');
    expect(state.shown[0]?.body).toBe('Версия 0.2.0 скачана и будет установлена автоматически');
  });

  it('тоста «доступно обновление» больше нет', () => {
    const notifier = makeNotifier() as unknown as Record<string, unknown>;
    expect(notifier).not.toHaveProperty('updateAvailable');
  });

  it('sync-события не порождают тост об обновлении', () => {
    makeNotifier().onStatus({ state: 'sync_ok', syncReason: 'interval' });
    makeNotifier().onStatus({ state: 'syncing' });
    expect(state.shown).toHaveLength(0);
  });

  it('fatal агента остановлен — без OS-уведомления', () => {
    makeNotifier().agentStopped('boom');
    expect(state.shown).toHaveLength(0);
  });

  it('device-flow: код входа — action-required', () => {
    makeNotifier().deviceCodePending('WXYZ-1234');
    expect(state.shown).toHaveLength(1);
    expect(state.shown[0]?.title).toBe('Требуется вход');
    expect(state.shown[0]?.body).toContain('WXYZ-1234');
  });

  it('CD-4.3: лимит устройств и несовпадение машины → инструкция', () => {
    const notifier = makeNotifier();
    notifier.deviceIssue('device-limit');
    expect(state.shown[0]?.title).toBe('Достигнут лимит устройств');
    expect(state.shown[0]?.body).toContain('Отзовите');
  });
});

describe('CD-4.1: анти-спам/троттл', () => {
  it('повторное касание того же рейса не дублируется', () => {
    const event: AgentStatusEvent = {
      state: 'touchdown',
      score: 90,
      grade: 'butter',
      flightId: '123e4567-e89b-42d3-a456-426614174000',
    };
    let now = 1_000_000;
    const notifier = makeNotifier({ now: () => now });
    notifier.onStatus(event);
    now += TOUCHDOWN_MIN_INTERVAL_MS + 1;
    notifier.onStatus(event);
    expect(state.shown).toHaveLength(1);
  });

  it('касания троттлятся ≤1 раз в 20 c', () => {
    let now = 1_000_000;
    const notifier = makeNotifier({ now: () => now });
    notifier.onStatus({ state: 'touchdown', score: 80, flightId: '11111111-1111-4111-8111-111111111111' });
    now += TOUCHDOWN_MIN_INTERVAL_MS - 1;
    notifier.onStatus({ state: 'touchdown', score: 81, flightId: '22222222-2222-4222-8222-222222222222' });
    expect(state.shown).toHaveLength(1);
    now += 1;
    // Новая посадка после окна троттла: срезанная троттлом посадка теперь
    // запоминается (BUG-TOAST-01), поэтому повтор того же рейса дедупится —
    // проверяем тайминг на следующей, отличной посадке.
    notifier.onStatus({ state: 'touchdown', score: 82, flightId: '33333333-3333-4333-8333-333333333333' });
    expect(state.shown).toHaveLength(2);
  });

  it('завершение рейса больше не показывает тост (анти-режим)', () => {
    let now = 1_000_000;
    const notifier = makeNotifier({ now: () => now });
    notifier.onStatus({ state: 'sync_ok', syncReason: 'flight_ended', uploadedFlights: 1 });
    now += 60_000;
    notifier.onStatus({ state: 'sync_ok', syncReason: 'flight_ended', uploadedFlights: 1 });
    expect(state.shown).toHaveLength(0);
  });

  it('обновление показывается один раз на версию', () => {
    const notifier = makeNotifier();
    notifier.updateReady('0.2.0');
    notifier.updateReady('0.2.0');
    expect(state.shown).toHaveLength(1);
    notifier.updateReady('0.2.1');
    expect(state.shown).toHaveLength(2);
  });

  it('action-required троттлится ≤1/24 ч (общий счётчик)', () => {
    let now = 1_000_000;
    const notifier = makeNotifier({ now: () => now });
    notifier.deviceCodePending('WXYZ-1234');
    notifier.deviceCodePending('ABCD-5678');
    notifier.onStatus({ state: 'sync_error', quality: 'fatal' });
    expect(state.shown).toHaveLength(1);
    now += ACTION_REQUIRED_THROTTLE_MS - 1;
    notifier.deviceCodePending('EFGH-9012');
    expect(state.shown).toHaveLength(1);
    now += 1;
    notifier.deviceCodePending('EFGH-9012');
    expect(state.shown).toHaveLength(2);
  });

  it('проблема устройства троттлится ≤1/24 ч', () => {
    let now = 1_000_000;
    const notifier = makeNotifier({ now: () => now });
    notifier.deviceIssue('device-limit');
    notifier.deviceIssue('machine-mismatch');
    expect(state.shown).toHaveLength(1);
    now += DEVICE_ISSUE_THROTTLE_MS;
    notifier.deviceIssue('machine-mismatch');
    expect(state.shown).toHaveLength(2);
  });
});

describe('CD-4.1: дедуп по посадке (go-around → второй тост)', () => {
  const FLIGHT = '123e4567-e89b-42d3-a456-426614174000';
  const touchdown = (landingSeq?: number): AgentStatusEvent => ({
    state: 'touchdown',
    flightId: FLIGHT,
    score: 80,
    grade: 'good',
    ...(landingSeq != null ? { landingSeq } : {}),
  });

  it('каждая посадка рейса — свой тост; дубликат и bounce подавлены', () => {
    let now = 1_000_000;
    const notifier = makeNotifier({ now: () => now });

    notifier.onStatus(touchdown(1));
    expect(state.shown).toHaveLength(1);

    // Дубликат того же события (тот же landingSeq) — молча.
    notifier.onStatus(touchdown(1));
    expect(state.shown).toHaveLength(1);

    // Go-around → второе касание (landingSeq=2) после троттла — свой тост.
    now += TOUCHDOWN_MIN_INTERVAL_MS + 1;
    notifier.onStatus(touchdown(2));
    expect(state.shown).toHaveLength(2);

    // `bounce` несёт тот же landingSeq → остаётся подавленным.
    notifier.onStatus({ ...touchdown(2), bounceCount: 1 });
    expect(state.shown).toHaveLength(2);
  });

  it('троттл режет в пределах 20 c и пропускает после', () => {
    let now = 1_000_000;
    const suppressed: SuppressedNotification[] = [];
    const notifier = makeNotifier({
      now: () => now,
      onSuppressed: (info) => suppressed.push(info),
    });

    notifier.onStatus(touchdown(1));
    now += TOUCHDOWN_MIN_INTERVAL_MS + 1;
    notifier.onStatus(touchdown(2));
    expect(state.shown).toHaveLength(2);

    // seq=3 в пределах 20 c от seq=2 → подавлен троттлом.
    now += 1_000;
    notifier.onStatus(touchdown(3));
    expect(state.shown).toHaveLength(2);
    expect(suppressed.at(-1)).toEqual({ reason: 'throttle', flightId: FLIGHT, landingSeq: 3 });

    // seq=4 после окна троттла → тост.
    now += TOUCHDOWN_MIN_INTERVAL_MS;
    notifier.onStatus(touchdown(4));
    expect(state.shown).toHaveLength(3);
  });

  it('BUG-TOAST-01: посадка, срезанная троттлом, дедупит свой bounce', () => {
    const base = 1_000_000;
    let now = base;
    const suppressed: SuppressedNotification[] = [];
    const notifier = makeNotifier({
      now: () => now,
      onSuppressed: (info) => suppressed.push(info),
    });

    // seq=1 — тост, открывает окно троттла.
    notifier.onStatus(touchdown(1));
    expect(state.shown).toHaveLength(1);

    // seq=2 через 19 c — срезан троттлом, но посадка запоминается.
    now = base + 19_000;
    notifier.onStatus(touchdown(2));
    expect(state.shown).toHaveLength(1);
    expect(suppressed.at(-1)).toEqual({ reason: 'throttle', flightId: FLIGHT, landingSeq: 2 });

    // `bounce` той же посадки, уже после окна троттла, — дедуп, тоста нет.
    now = base + 24_000;
    notifier.onStatus({ ...touchdown(2), bounceCount: 1 });
    expect(state.shown).toHaveLength(1);
    expect(suppressed.at(-1)).toEqual({ reason: 'dedupe', flightId: FLIGHT, landingSeq: 2 });

    // Следующая посадка (seq=3) после окна троттла — снова свой тост.
    now = base + TOUCHDOWN_MIN_INTERVAL_MS + 1_000;
    notifier.onStatus(touchdown(3));
    expect(state.shown).toHaveLength(2);
  });

  it('дубликат посадки подавляется с причиной dedupe', () => {
    const suppressed: SuppressedNotification[] = [];
    const notifier = makeNotifier({ onSuppressed: (info) => suppressed.push(info) });
    notifier.onStatus(touchdown(1));
    notifier.onStatus(touchdown(1));
    expect(suppressed).toEqual([{ reason: 'dedupe', flightId: FLIGHT, landingSeq: 1 }]);
  });

  it('без landingSeq — дедуп по рейсу, как раньше', () => {
    let now = 1_000_000;
    const notifier = makeNotifier({ now: () => now });
    notifier.onStatus(touchdown());
    now += TOUCHDOWN_MIN_INTERVAL_MS + 1;
    notifier.onStatus(touchdown());
    expect(state.shown).toHaveLength(1);
  });
});

describe('CD-4.1: настройки, язык, клик', () => {
  it('префы выключают соответствующий тост', () => {
    const notifier = makeNotifier({
      preferences: { touchdown: false, updates: false },
    });
    notifier.onStatus({ state: 'touchdown', score: 80, grade: 'good' });
    notifier.updateReady('0.2.0');
    // action-required не входит в notification prefs — управляется enabled().
    notifier.deviceCodePending('WXYZ-1234');
    expect(state.shown).toHaveLength(1);
    expect(state.shown[0]?.title).toBe('Требуется вход');
  });

  it('pref updates=false глушит тост о готовности обновления', () => {
    const notifier = makeNotifier({ preferences: { updates: false } });
    notifier.updateReady('0.2.1');
    expect(state.shown).toHaveLength(0);
  });

  it('EN-локаль: готовность обновления без кириллицы и с новой формулировкой', () => {
    const cyrillic = /[\u0400-\u04FF]/;
    const notifier = makeNotifier({ locale: 'en' });
    notifier.updateReady('0.2.0');
    expect(state.shown).toHaveLength(1);
    expect(state.shown[0]?.title).toBe('Flare update');
    expect(state.shown[0]?.body).toBe('Version 0.2.0 is downloaded and will install automatically');
    expect(cyrillic.test(state.shown[0]?.title ?? '')).toBe(false);
    expect(cyrillic.test(state.shown[0]?.body ?? '')).toBe(false);
  });

  it('клик по тосту готовности несёт цель update-ready с версией', () => {
    const onActivate = vi.fn();
    const notifier = makeNotifier({ onActivate });
    notifier.updateReady('0.2.1');
    expect(state.shown[0]?.silent).toBe(true);
    state.shown[0]?.click?.();
    expect(onActivate).toHaveBeenCalledWith({ kind: 'update-ready', version: '0.2.1' });
  });

  it('мастер-флаг глушит action-required, но не тосты', () => {
    const notifier = makeNotifier({ enabled: false });
    notifier.deviceCodePending('WXYZ-1234');
    notifier.onStatus({ state: 'touchdown', score: 80, grade: 'good' });
    expect(state.shown).toHaveLength(1);
    expect(state.shown[0]?.title).toBe('Посадка · Хорошо 80');
  });

  it('score-preview: тост с клиентским баллом помечен «предварительно», серверный — без метки', () => {
    const notifier = makeNotifier();
    notifier.onStatus({
      state: 'touchdown',
      score: 80,
      grade: 'good',
      clientFlightId: '123e4567-e89b-42d3-a456-426614174000',
      landingSeq: 1,
      scorePreliminary: true,
    });
    expect(state.shown[0]?.title).toBe('Посадка · Хорошо 80 · предварительно');

    const confirmed = makeNotifier();
    confirmed.onStatus({
      state: 'touchdown',
      score: 74,
      grade: 'firm',
      clientFlightId: '123e4567-e89b-42d3-a456-426614174000',
      landingSeq: 1,
      scorePreliminary: false,
      scoreSource: 'server_preview',
    });
    expect(state.shown[1]?.title).toBe('Посадка · Плотно 74');
  });

  it('EN-локаль: заголовки без кириллицы', () => {
    const cyrillic = /[\u0400-\u04FF]/;
    const notifier = makeNotifier({ locale: 'en' });
    notifier.onStatus({ state: 'touchdown', score: 80, grade: 'good', vsFpm: -120 });
    notifier.deviceIssue('machine-mismatch');
    notifier.updateReady('0.2.0');
    expect(state.shown).toHaveLength(3);
    for (const item of state.shown) {
      expect(cyrillic.test(item.title)).toBe(false);
      expect(cyrillic.test(item.body)).toBe(false);
    }
  });

  it('все тосты беззвучные, а клик несёт правильную цель', () => {
    const onActivate = vi.fn();
    const notifier = makeNotifier({ onActivate });
    notifier.onStatus({
      state: 'touchdown',
      score: 87,
      grade: 'good',
      clientFlightId: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(state.shown[0]?.silent).toBe(true);
    state.shown[0]?.click?.();
    expect(onActivate).toHaveBeenCalledWith({
      kind: 'touchdown',
      flightId: '123e4567-e89b-42d3-a456-426614174000',
    });
  });
});

describe('CD-4.1: маршрутизация клика по тосту', () => {
  function makeHandlers() {
    const handlers: NotificationActivateHandlers = {
      showStatusWindow: vi.fn(),
      openSite: vi.fn(),
    };
    return handlers;
  }

  it('update-ready открывает окно статуса и не запускает установку', () => {
    const handlers = makeHandlers();
    activateNotification({ kind: 'update-ready', version: '0.2.0' }, handlers);
    expect(handlers.showStatusWindow).toHaveBeenCalledTimes(1);
    expect(handlers).not.toHaveProperty('installUpdate');
  });

  it('action-required открывает окно статуса', () => {
    const handlers = makeHandlers();
    activateNotification({ kind: 'action-required' }, handlers);
    expect(handlers.showStatusWindow).toHaveBeenCalledTimes(1);
  });

  it('touchdown ведёт в рейс или список рейсов', () => {
    const withFlight = makeHandlers();
    activateNotification({ kind: 'touchdown', flightId: 'abc' }, withFlight);
    expect(withFlight.openSite).toHaveBeenCalledWith('/flights/abc');

    const withoutFlight = makeHandlers();
    activateNotification({ kind: 'touchdown', flightId: null }, withoutFlight);
    expect(withoutFlight.openSite).toHaveBeenCalledWith('/flights');
  });

  it('device-limit/machine-mismatch ведут в управление устройствами', () => {
    const handlers = makeHandlers();
    activateNotification({ kind: 'device-limit' }, handlers);
    activateNotification({ kind: 'machine-mismatch' }, handlers);
    expect(handlers.openSite).toHaveBeenNthCalledWith(1, '/settings/devices');
    expect(handlers.openSite).toHaveBeenNthCalledWith(2, '/settings/devices');
  });
});
