import { describe, expect, it } from 'vitest';

import {
  AGENT_STATUS_KINDS,
  SCORE_GRADES,
  agentStatusCopy,
  en,
  formatAccelerator,
  formatCount,
  formatSyncTime,
  formatTrayTooltip,
  getDesktopMessages,
  interpolate,
  pluralCategory,
  resolveLocale,
  ru,
  statusLabel,
} from './index.js';

function collect(value: unknown, prefix: string, out: Array<[string, unknown]>): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collect(item, `${prefix}[${index}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collect(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  out.push([prefix, value]);
}

function leaves(dictionary: unknown): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  collect(dictionary, '', out);
  return out;
}

describe('@flightlog/i18n — язык и словарь', () => {
  it('resolveLocale: ru* → ru, иначе en', () => {
    expect(resolveLocale('ru-RU')).toBe('ru');
    expect(resolveLocale('ru')).toBe('ru');
    expect(resolveLocale('en-US')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
  });

  it('interpolate подставляет значения, не трогая неизвестные ключи', () => {
    expect(interpolate('{a} + {b}', { a: 1 })).toBe('1 + {b}');
  });

  it('T-CLIENT3: RU и EN содержат один и тот же набор ключей (нет непереведённых)', () => {
    const ruKeys = leaves(ru)
      .map(([key]) => key)
      .sort();
    const enKeys = leaves(en)
      .map(([key]) => key)
      .sort();
    expect(enKeys).toEqual(ruKeys);
  });

  it('словари ru/en содержат все состояния агента', () => {
    for (const locale of ['ru', 'en'] as const) {
      const messages = getDesktopMessages(locale);
      for (const kind of AGENT_STATUS_KINDS) {
        expect(messages.status.copies[kind].title.length).toBeGreaterThan(0);
        expect(messages.tray.tooltips[kind].length).toBeGreaterThan(0);
      }
    }
  });

  it('agentStatusCopy возвращает лейблы статуса (общие для desktop/web)', () => {
    expect(agentStatusCopy('ru', 'recording').title).toBe('Запись полёта');
    expect(agentStatusCopy('en', 'recording').title).toBe('Recording flight');
  });

  it('XC-SIM-AGNOSTIC: sim_waiting без имени сима (RU/EN), обобщённая формулировка', () => {
    expect(agentStatusCopy('ru', 'sim_waiting').title).toBe('Ожидание данных симулятора');
    expect(agentStatusCopy('en', 'sim_waiting').title).toBe('Waiting for simulator data');
    expect(formatTrayTooltip('ru', 'sim_waiting')).toBe('Flare: ожидание данных симулятора');
    expect(formatTrayTooltip('en', 'sim_waiting')).toBe('Flare: waiting for simulator data');
  });

  it('XC-SIM-AGNOSTIC-REGRESSION: generic waiting path не хардкодит MSFS (ни одно поле)', () => {
    const msfs = /MSFS|Microsoft Flight Simulator|FlightSimulator/i;
    for (const locale of ['ru', 'en'] as const) {
      const messages = getDesktopMessages(locale);
      expect(messages.status.copies.sim_waiting.title).not.toMatch(msfs);
      expect(messages.status.copies.sim_waiting.message).not.toMatch(msfs);
      expect(messages.tray.tooltips.sim_waiting).not.toMatch(msfs);
      expect(agentStatusCopy(locale, 'sim_waiting').title).not.toMatch(msfs);
      expect(formatTrayTooltip(locale, 'sim_waiting')).not.toMatch(msfs);
    }
  });

  it('recording: без фразы про «настройки симулятора» (CLIENT-TEXT-FIXES)', () => {
    const ruCopy = agentStatusCopy('ru', 'recording');
    const enCopy = agentStatusCopy('en', 'recording');
    expect(ruCopy.message.trim().length).toBeGreaterThan(0);
    expect(enCopy.message.trim().length).toBeGreaterThan(0);
    expect(ruCopy.message).not.toMatch(/настройки симулятора/i);
    expect(enCopy.message).not.toMatch(/simulator settings/i);
  });

  it('lastLanding: локализованные балл/грейд/VS (T115)', () => {
    for (const locale of ['ru', 'en'] as const) {
      const copy = getDesktopMessages(locale).status.lastLanding;
      expect(copy.overline.length).toBeGreaterThan(0);
      expect(copy.fpm).toContain('{fpm}');
      for (const grade of SCORE_GRADES) {
        expect(copy.grade[grade].length).toBeGreaterThan(0);
      }
    }
    expect(getDesktopMessages('en').status.lastLanding.grade.butter).toBe('Butter');
    expect(getDesktopMessages('ru').status.lastLanding.grade).toEqual({
      butter: 'Мягко',
      good: 'Хорошо',
      firm: 'Плотно',
      hard: 'Жёстко',
      crash: 'Грубо',
    });
  });

  it('CD-4.4: в EN нет непереведённых кириллических строк (кроме самоназвания языка)', () => {
    const cyrillic = /[\u0400-\u04FF]/;
    const offenders: string[] = [];
    for (const [path, value] of leaves(en)) {
      if (typeof value !== 'string') continue;
      // «Русский» — самоназвание языка в переключателе, переводить не нужно.
      if (path.endsWith('status.language.ru')) continue;
      if (cyrillic.test(value)) offenders.push(`${path}: ${value}`);
    }
    expect(offenders).toEqual([]);
  });

  it('CD-4.1: actionable-тост обновления (RU/EN, точный текст)', () => {
    const ruMessages = getDesktopMessages('ru').notifications;
    expect(ruMessages.updateTitle).toBe('Обновление Flare');
    expect(ruMessages.updateBodyReady).toBe(
      'Версия {version} скачана и будет установлена автоматически',
    );

    const enMessages = getDesktopMessages('en').notifications;
    expect(enMessages.updateTitle).toBe('Flare update');
    expect(enMessages.updateBodyReady).toBe(
      'Version {version} is downloaded and will install automatically',
    );

    for (const locale of ['ru', 'en'] as const) {
      expect(getDesktopMessages(locale).notifications.updateBodyReady).toContain('{version}');
    }
  });

  it('UPDATE-AVAILABLE-TOAST: ключей тоста «доступно» больше нет (RU/EN)', () => {
    for (const locale of ['ru', 'en'] as const) {
      const notifications = getDesktopMessages(locale).notifications as unknown as Record<
        string,
        unknown
      >;
      expect(notifications).not.toHaveProperty('updateAvailableTitle');
      expect(notifications).not.toHaveProperty('updateAvailableBody');
      const menu = getDesktopMessages(locale).tray.menu as unknown as Record<string, unknown>;
      expect(menu).not.toHaveProperty('updateAvailable');
    }
  });

  it('desktop-строки трея/обновления есть в RU/EN, EN без кириллицы (T132)', () => {
    const cyrillic = /[\u0400-\u04FF]/;
    for (const locale of ['ru', 'en'] as const) {
      const messages = getDesktopMessages(locale);
      for (const value of [
        messages.tray.menu.authAlertsToggle,
        messages.status.update.ready,
        messages.status.update.install,
      ]) {
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
    const en = getDesktopMessages('en');
    expect(cyrillic.test(en.tray.menu.authAlertsToggle)).toBe(false);
    expect(cyrillic.test(en.status.update.ready)).toBe(false);
    expect(cyrillic.test(en.status.update.install)).toBe(false);
  });

  it('FIX-UPDATE-CHECK-FEEDBACK: результат проверки обновлений есть в RU/EN', () => {
    for (const locale of ['ru', 'en'] as const) {
      const about = getDesktopMessages(locale).about;
      expect(about.updatesChecking.trim().length).toBeGreaterThan(0);
      expect(about.updateLatest.trim().length).toBeGreaterThan(0);
      expect(about.updateAvailable).toContain('{version}');
      expect(about.updateError.trim().length).toBeGreaterThan(0);
    }
  });

  it('formatAccelerator переводит CommandOrControl в Ctrl', () => {
    expect(formatAccelerator('CommandOrControl+Alt+T')).toBe('Ctrl+Alt+T');
    expect(formatAccelerator('Ctrl+Shift+T')).toBe('Ctrl+Shift+T');
  });

  it('F2: план-чип и трей — строки §9.1 без длинного/среднего тире', () => {
    const longDash = /[\u2013\u2014]/;
    for (const locale of ['ru', 'en'] as const) {
      const plan = getDesktopMessages(locale).status.plan;
      for (const value of [
        plan.chipAria,
        plan.trialAria,
        plan.free,
        plan.lifetimeShort,
        plan.trialShort,
        plan.pro,
        plan.trial,
        plan.lifetime,
        getDesktopMessages(locale).tray.statusWithPlan,
      ]) {
        expect(longDash.test(value)).toBe(false);
      }
    }
    expect(getDesktopMessages('ru').status.plan.free).toBe('Бесплатно');
    expect(getDesktopMessages('en').status.plan.free).toBe('Free');
    expect(getDesktopMessages('ru').status.plan.chipAria).toBe('Тариф {plan}');
    expect(getDesktopMessages('en').status.plan.chipAria).toBe('{plan} plan');
    expect(getDesktopMessages('ru').tray.statusWithPlan).toBe('{plan} · {status}');
  });
});

describe('тултипы трея (desktop-client.md §4.2)', () => {
  const values = {
    aircraft: 'B738',
    points: 12480,
    flights: 2,
    score: 87,
    fpm: -142,
    time: '12:40',
    code: 'WXYZ-1234',
  };

  it.each(['ru', 'en'] as const)('≤127 символов во всех состояниях (%s)', (locale) => {
    const prefix = locale === 'ru' ? 'Flare' : 'Flare';
    for (const kind of AGENT_STATUS_KINDS) {
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

describe('плюрализация (T125)', () => {
  it('pluralCategory: RU one/few/many и EN one/many', () => {
    expect(pluralCategory('ru', 1)).toBe('one');
    expect(pluralCategory('ru', 3)).toBe('few');
    expect(pluralCategory('ru', 5)).toBe('many');
    expect(pluralCategory('ru', 11)).toBe('many');
    expect(pluralCategory('ru', 21)).toBe('one');
    expect(pluralCategory('ru', 22)).toBe('few');
    expect(pluralCategory('en', 1)).toBe('one');
    expect(pluralCategory('en', 2)).toBe('many');
  });

  it('formatCount форматирует число с разделителями групп', () => {
    expect(formatCount('ru', 12480, { one: '{n}', few: '{n}', many: '{n}' })).toBe(
      new Intl.NumberFormat('ru-RU').format(12480),
    );
    expect(formatCount('en', 12480, { one: '{n}', few: '{n}', many: '{n}' })).toBe('12,480');
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

/** Итерация 58: окно/трей не показывают пользователю внутренности авторизации. */
const FORBIDDEN_UI_TERMS: Array<[string, RegExp]> = [
  ['device_code', /device_code/i],
  ['device code', /device[\s-]?code/i],
  ['user_code', /user_code/i],
  ['user code', /user[\s-]?code/i],
  ['device flow', /device[\s-]?flow/i],
  ['device authorization', /device[\s-]?authorization/i],
  ['device token', /device[\s-]?(токен|token)/i],
  ['агент', /агент/i],
  ['agent', /\bagent\b/i],
];

describe('пользовательские строки без служебной терминологии (iter58)', () => {
  it.each(['ru', 'en'] as const)('нет запрещённых терминов в словаре (%s)', (locale) => {
    const offenders: string[] = [];
    for (const [path, value] of leaves(locale === 'ru' ? ru : en)) {
      if (typeof value !== 'string') continue;
      for (const [label, pattern] of FORBIDDEN_UI_TERMS) {
        if (pattern.test(value)) offenders.push(`${path} [${label}]: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** READONLY-CLEANUP: «read-only» больше не показывается пользователю в клиенте. */
const READ_ONLY_TERMS = /read[\s-]?only|только\s+чтение/i;

describe('пользовательские строки без «read-only» (READONLY-CLEANUP)', () => {
  it.each(['ru', 'en'] as const)('нет упоминаний read-only в словаре (%s)', (locale) => {
    const offenders: string[] = [];
    for (const [path, value] of leaves(locale === 'ru' ? ru : en)) {
      if (typeof value === 'string' && READ_ONLY_TERMS.test(value)) {
        offenders.push(`${path}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
