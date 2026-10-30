import {
  DEFAULT_SIM_SOURCE_PREFERENCE,
  KNOWN_SIM_SOURCE_PREFERENCES,
  SIM_SOURCE_ENV,
  type SimSourceId,
  type SimSourcePreference,
} from '@flightlog/agent';
import type { DesktopLocale } from '@flightlog/contracts';

/**
 * Read-only отображение источника телеметрии (ADR-0023, решения 2–3).
 *
 * В v1 UI-переключателя нет: сим выбирает агент (`auto` по умолчанию либо
 * явный env `AGENT_SIM_SOURCE`). Агент пока НЕ отдаёт `sim`/`simVersion` в
 * connect-payload (контракт `AgentStatusEvent` строгий и поля не содержит),
 * поэтому клиент показывает только то, что знает честно:
 *   - явный env-id + подключение → конкретный сим;
 *   - явный env-id без подключения → «ждём <сим>» (не угадываем, но источник задан явно);
 *   - `auto` + подключение → обобщённое «сим подключён» (бренд не угадываем);
 *   - `auto` без подключения → обобщённое «ждём сим» (НЕ навязываем MSFS).
 *
 * Никакого управления: функция только формирует подпись для статуса.
 */
export type SimSourceKind =
  SimSourceId | 'sim_connected' | 'waiting' | 'waiting_msfs2024' | 'waiting_xplane12';

export interface SimSourceStatusInput {
  /** Предпочтение из env (`auto` по умолчанию). */
  preference: SimSourcePreference;
  /** Агент подключён к симу (последнее sim-событие — connected/recording/touchdown). */
  connected: boolean;
  /**
   * SIM-STATUS-1: фактически подключённый источник из `AgentStatusEvent.sim`.
   * Позволяет при `auto` показать конкретный сим, а не обобщённое «сим подключён».
   * Старые агенты поле не шлют → `undefined` (прежнее поведение).
   */
  source?: SimSourceId | null;
}

/** Предпочтение env + фактический источник → отображаемое состояние. */
export function resolveSimSourceKind(input: SimSourceStatusInput): SimSourceKind {
  const active = input.source ?? null;
  if (!input.connected) {
    if (input.preference === 'msfs2024') return 'waiting_msfs2024';
    if (input.preference === 'xplane12') return 'waiting_xplane12';
    return 'waiting';
  }
  if (active === 'msfs2024' || active === 'xplane12') return active;
  if (input.preference === 'msfs2024' || input.preference === 'xplane12') {
    return input.preference;
  }
  return 'sim_connected';
}

/**
 * Разбирает env-значение в предпочтение (пусто/неизвестное → `auto`).
 * Зеркалит `parseSimSourcePreference` из агента, но опирается только на
 * leaf-константы `source.js` (без реестра источников — main не тянет runtime).
 */
export function readSimSourcePreference(raw: string | null | undefined): SimSourcePreference {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (KNOWN_SIM_SOURCE_PREFERENCES as readonly string[]).includes(value)
    ? (value as SimSourcePreference)
    : DEFAULT_SIM_SOURCE_PREFERENCE;
}

/** Предпочтение из окружения по каноническому имени `AGENT_SIM_SOURCE`. */
export function readSimSourcePreferenceFromEnv(
  env: Record<string, string | undefined>,
): SimSourcePreference {
  return readSimSourcePreference(env[SIM_SOURCE_ENV] ?? null);
}

const LABELS: Record<DesktopLocale, Record<SimSourceKind, string>> = {
  ru: {
    msfs2024: 'MSFS 2024 (только чтение)',
    xplane12: 'X-Plane 12 (только чтение)',
    sim_connected: 'Сим подключён (только чтение)',
    waiting: 'ждём сим',
    waiting_msfs2024: 'ждём MSFS 2024',
    waiting_xplane12: 'ждём X-Plane 12',
  },
  en: {
    msfs2024: 'MSFS 2024 (read-only)',
    xplane12: 'X-Plane 12 (read-only)',
    sim_connected: 'Sim connected (read-only)',
    waiting: 'waiting for sim',
    waiting_msfs2024: 'waiting for MSFS 2024',
    waiting_xplane12: 'waiting for X-Plane 12',
  },
};

/** RU/EN-подпись выбранного/ожидаемого источника (display-only, без управления). */
export function simSourceLabel(locale: DesktopLocale, kind: SimSourceKind): string {
  return (LABELS[locale] ?? LABELS.ru)[kind];
}

/**
 * Обновляет флаг «сим подключён» по состояниям агента. Сигналы о симе меняют
 * флаг, а синк/`authorized` (не про сим) его сохраняют — иначе интервальный
 * `sync_ok` превращал бы подключённый сим в «ждём сим».
 */
export function nextSimConnected(current: boolean, state: string | null | undefined): boolean {
  switch (state) {
    case 'connected_idle':
    case 'recording':
    case 'touchdown':
      return true;
    case 'sim_waiting':
    case 'auth_required':
      return false;
    default:
      return current;
  }
}
