import { en } from './en.js';
import { ru } from './ru.js';
import {
  DESKTOP_LOCALES,
  AGENT_STATUS_KINDS,
  type AgentStatusKind,
  type CountForms,
  type DesktopLocale,
  type DesktopMessages,
  type StatusCopy,
  type TemplateValues,
} from './types.js';

export * from './types.js';
export { ru, en };

const DICTIONARIES: Record<DesktopLocale, DesktopMessages> = { ru, en };

export function getDesktopMessages(locale: DesktopLocale = 'ru'): DesktopMessages {
  return DICTIONARIES[locale] ?? DICTIONARIES.ru;
}

/** Значения подстановки в шаблоны (`{name}`). */
export function interpolate(template: string, values: TemplateValues = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

/** `ru*` → ru, иначе en (desktop-client.md §7.1). */
export function resolveLocale(raw: string | undefined | null): DesktopLocale {
  return raw?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/** Локализованные лейблы статуса агента — общий источник для трея/окна/web. */
export function agentStatusCopy(locale: DesktopLocale, kind: AgentStatusKind): StatusCopy {
  return getDesktopMessages(locale).status.copies[kind];
}

/** Тултип трея: шаблон по состоянию + подстановка, обрезка до 127 символов. */
export function formatTrayTooltip(
  locale: DesktopLocale,
  kind: AgentStatusKind,
  values: TemplateValues = {},
): string {
  const template = getDesktopMessages(locale).tray.tooltips[kind];
  return interpolate(template, values).slice(0, 127);
}

/** Текст статуса для меню трея (title + опционально message). */
export function statusLabel(
  locale: DesktopLocale,
  kind: AgentStatusKind,
  message?: string,
): string {
  const copy = agentStatusCopy(locale, kind);
  if (!message) return copy.title;
  return `${copy.title} · ${message}`;
}

const numberFormatters = new Map<DesktopLocale, Intl.NumberFormat>();

/** Число с разделителями групп для локали (`12 480` / `12,480`). */
export function formatNumber(locale: DesktopLocale, value: number): string {
  let formatter = numberFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US');
    numberFormatters.set(locale, formatter);
  }
  return formatter.format(value);
}

/** Счётная форма: RU (one/few/many) и EN (one/many). */
export function pluralCategory(locale: DesktopLocale, value: number): keyof CountForms {
  const abs = Math.abs(value);
  if (locale === 'en') return abs === 1 ? 'one' : 'many';
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return 'one';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
  return 'many';
}

/** Число + слово в правильной форме (`2 рейса`, `3 события`). */
export function pluralWord(locale: DesktopLocale, value: number, forms: CountForms): string {
  return forms[pluralCategory(locale, value)];
}

export function formatCount(locale: DesktopLocale, value: number, forms: CountForms): string {
  return interpolate(forms[pluralCategory(locale, value)], { n: formatNumber(locale, value) });
}

const clockFormatters = new Map<DesktopLocale, Intl.DateTimeFormat>();

/** Локальные часы/минуты (`12:39`). */
export function formatClock(locale: DesktopLocale, iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  let formatter = clockFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
    clockFormatters.set(locale, formatter);
  }
  return formatter.format(date);
}

/** «12:39 (3 мин назад)» для строки последнего синка. */
export function formatSyncTime(
  locale: DesktopLocale,
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  const clock = formatClock(locale, iso);
  if (!clock) return getDesktopMessages(locale).status.outbox.never;
  const date = new Date(iso as string);
  const minutes = Math.max(0, Math.round((now - date.getTime()) / 60_000));
  if (minutes <= 0) return `${clock} (${locale === 'ru' ? 'только что' : 'just now'})`;
  return interpolate('{clock} ({n} {unit})', {
    clock,
    n: minutes,
    unit: locale === 'ru' ? 'мин назад' : 'min ago',
  });
}

/**
 * Человекочитаемая подпись акселератора Electron (win32-only продукт).
 * `CommandOrControl` на Windows = `Ctrl`.
 */
export function formatAccelerator(accelerator: string): string {
  return accelerator
    .replace(/CommandOrControl|CmdOrCtrl/gi, 'Ctrl')
    .replace(/\bControl\b/gi, 'Ctrl')
    .trim();
}

export { AGENT_STATUS_KINDS, DESKTOP_LOCALES };
export type { AgentStatusKind, DesktopLocale, DesktopMessages, StatusCopy, TemplateValues };
