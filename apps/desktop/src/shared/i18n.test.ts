import { describe, expect, it } from 'vitest';

import { AGENT_STATUS_KINDS, type AgentStatusKind } from '@flightlog/contracts';

import {
  formatSyncTime,
  formatTrayTooltip,
  getDesktopMessages,
  interpolate,
  resolveLocale,
  statusLabel,
} from './i18n';

describe('i18n — язык и словарь', () => {
  it('resolveLocale: ru* → ru, иначе en', () => {
    expect(resolveLocale('ru-RU')).toBe('ru');
    expect(resolveLocale('ru')).toBe('ru');
    expect(resolveLocale('en-US')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
  });

  it('interpolate подставляет значения, не трогая неизвестные ключи', () => {
    expect(interpolate('{a} + {b}', { a: 1 })).toBe('1 + {b}');
  });

  it('словари ru/en содержат все состояния', () => {
    for (const locale of ['ru', 'en'] as const) {
      const messages = getDesktopMessages(locale);
      for (const kind of AGENT_STATUS_KINDS) {
        expect(messages.status.copies[kind].title.length).toBeGreaterThan(0);
        expect(messages.tray.tooltips[kind].length).toBeGreaterThan(0);
      }
    }
  });

  it('desktop-строки (T132) есть на обоих языках через общий словарь', () => {
    for (const locale of ['ru', 'en'] as const) {
      const messages = getDesktopMessages(locale);
      expect(messages.tray.menu.authAlertsToggle.length).toBeGreaterThan(0);
      expect(messages.status.update.ready.length).toBeGreaterThan(0);
      expect(messages.status.update.install.length).toBeGreaterThan(0);
    }
    expect(getDesktopMessages('ru').tray.menu.authAlertsToggle).toBe(
      'Предупреждать о потере авторизации',
    );
    // T-CLIENT2: «Доступна версия {version}» + внешнее подтверждение.
    expect(getDesktopMessages('ru').status.update.ready).toBe('Доступна версия {version}');
    expect(getDesktopMessages('ru').status.update.install).toBe('Перезапустить и обновить');
    expect(getDesktopMessages('ru').status.deviceCode.openSite).toBe(
      'Открыть сайт для подтверждения',
    );
    expect(getDesktopMessages('ru').status.pairing.linked).toBe('Клиент привязан');
    expect(getDesktopMessages('ru').status.pairing.notLinked).toBe('Клиент не привязан');
    // DESKTOP-UX-POLISH: «Последний синк» → «Синхронизировано: ».
    expect(getDesktopMessages('ru').status.outbox.lastSyncLabel).toBe('Синхронизировано:');
    expect(getDesktopMessages('en').status.outbox.lastSyncLabel).toBe('Synced:');
  });
});

describe('тултипы трея (desktop-client.md §4.2)', () => {
  const values = { aircraft: 'B738', points: 12480, flights: 2, score: 87, fpm: -142, time: '12:40', code: 'WXYZ-1234' };

  it.each(['ru', 'en'] as const)('≤127 символов во всех состояниях (%s)', (locale) => {
    const prefix = locale === 'ru' ? 'Flare' : 'Flare';
    for (const kind of AGENT_STATUS_KINDS as readonly AgentStatusKind[]) {
      const tooltip = formatTrayTooltip(locale, kind, values);
      expect(tooltip.length).toBeLessThanOrEqual(127);
      expect(tooltip.startsWith(prefix)).toBe(true);
    }
  });

  it('recording подставляет ВС и точки', () => {
    expect(formatTrayTooltip('ru', 'recording', values)).toContain('B738');
    expect(formatTrayTooltip('ru', 'recording', values)).toContain('12');
  });

  it('touchdown подставляет grade/score/fpm', () => {
    const tooltip = formatTrayTooltip('ru', 'touchdown', { grade: 'GOOD', score: 87, fpm: -142 });
    expect(tooltip).toContain('GOOD');
    expect(tooltip).toContain('87');
    expect(tooltip).toContain('-142');
  });
});

describe('statusLabel / formatSyncTime', () => {
  it('statusLabel локализован и добавляет message', () => {
    expect(statusLabel('ru', 'not_started')).toBe('Приложение остановлено');
    expect(statusLabel('en', 'not_started')).toBe('App stopped');
    expect(statusLabel('ru', 'recording', 'Полёт B738')).toContain('Полёт B738');
  });

  it('formatSyncTime: никогда не синкался', () => {
    expect(formatSyncTime('ru', null)).not.toHaveLength(0);
    expect(formatSyncTime('ru', 'not-a-date')).not.toHaveLength(0);
  });

  it('formatSyncTime: часы + минуты', () => {
    const iso = new Date('2026-09-25T12:39:00Z').toISOString();
    const now = new Date('2026-09-25T12:42:00Z').getTime();
    expect(formatSyncTime('en', iso, now)).toContain('min ago');
  });
});
