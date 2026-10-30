import type {
  AgentStatusEvent,
  AgentStatusKind,
  DesktopLocale,
  DesktopOutboxCounts,
  DesktopSimSourceId,
} from '@flightlog/contracts';

import { formatCount, getDesktopMessages, interpolate } from '../shared/i18n.js';

/**
 * SIM-STATUS-1: чистый рендер компактной статус-сетки окна «Состояние агента»
 * (без DOM — покрывается unit-тестами). Окно только подставляет готовые строки.
 *
 * Источник данных — аддитивные поля `AgentStatusEvent`: `sim`, `simConnected`,
 * `simPinned`, `simTransportDegraded`, `lastSampleAt`, `retryInS`,
 * `flightStartedAt`. Старые агенты их не шлют — view честно деградирует.
 */

/** Нет кадров дольше 10 с при живом соединении — предупреждение о паузе. */
export const NO_DATA_WARN_MS = 10_000;

export type StatusTone = 'ok' | 'warn' | 'muted' | 'active';

export interface StatusGridViewInput {
  locale: DesktopLocale;
  kind: AgentStatusKind;
  status: AgentStatusEvent | null;
  received: boolean;
  outbox: DesktopOutboxCounts | null;
  nowMs: number;
}

export interface StatusGridView {
  simulator: string;
  simulatorTone: StatusTone;
  flight: string;
  flightTone: StatusTone;
  data: string;
  dataTone: StatusTone;
  degraded: string | null;
  pending: string | null;
}

const SIM_NAMES: Record<DesktopSimSourceId, string> = {
  msfs2024: 'MSFS 2024',
  xplane12: 'X-Plane 12',
};

/** Человекочитаемое имя сима (бренд один и тот же в RU/EN). */
export function simDisplayName(id: DesktopSimSourceId | null | undefined): string | null {
  return id ? (SIM_NAMES[id] ?? null) : null;
}

/** `754` → `12:34`, `3 725` → `1:02:05`. */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const rest = total % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

/** `0.2` → «0.2 с»; `12.4` → «12 с». */
function formatAge(locale: DesktopLocale, seconds: number): string {
  const messages = getDesktopMessages(locale).status.simulator.data;
  const value = seconds < 9.95 ? seconds.toFixed(1) : String(Math.round(seconds));
  return interpolate(messages.age, { value });
}

function parseIso(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function statusGridView(input: StatusGridViewInput): StatusGridView {
  const messages = getDesktopMessages(input.locale).status.simulator;
  const status = input.status;

  if (!input.received || !status) {
    return {
      simulator: '',
      simulatorTone: 'muted',
      flight: '-',
      flightTone: 'muted',
      data: '-',
      dataTone: 'muted',
      degraded: null,
      pending: null,
    };
  }

  const simName = simDisplayName(status.sim);
  const connected = status.simConnected === true;

  // W1b: строку показываем только при живом соединении; «ищу сим» убрано.
  const simulator = connected && simName ? interpolate(messages.syncing, { sim: simName }) : '';
  const simulatorTone: StatusTone = connected && simName ? 'ok' : 'muted';

  let flight: string;
  let flightTone: StatusTone;
  if (input.kind === 'recording' || input.kind === 'touchdown') {
    const startedAt = parseIso(status.flightStartedAt);
    const elapsed = startedAt === null ? null : formatElapsed((input.nowMs - startedAt) / 1_000);
    const aircraft = status.aircraftIcao ?? '-';
    flight =
      elapsed === null
        ? interpolate(messages.flight.recording, { aircraft, elapsed: '-' })
        : interpolate(messages.flight.recording, { aircraft, elapsed });
    flightTone = 'active';
  } else if (status.state === 'syncing' && status.syncReason === 'flight_ended') {
    flight = messages.flight.ended;
    flightTone = 'muted';
  } else {
    flight = messages.flight.none;
    flightTone = 'muted';
  }

  let data: string;
  let dataTone: StatusTone;
  if (connected) {
    const lastSampleAt = parseIso(status.lastSampleAt);
    if (lastSampleAt === null) {
      // W1b: «данные: ожидание…» убрано — строки нет, пока нет отсчёта.
      data = '';
      dataTone = 'muted';
    } else {
      const ageS = Math.max(0, (input.nowMs - lastSampleAt) / 1_000);
      if (ageS * 1_000 > NO_DATA_WARN_MS) {
        data = interpolate(messages.data.stale, { age: formatAge(input.locale, ageS) });
        dataTone = 'warn';
      } else {
        data = interpolate(messages.data.fresh, { age: formatAge(input.locale, ageS) });
        dataTone = 'ok';
      }
    }
  } else if (status.retryInS != null) {
    const at = parseIso(status.at);
    const remaining =
      at === null ? status.retryInS : status.retryInS - Math.max(0, (input.nowMs - at) / 1_000);
    data =
      remaining > 0
        ? interpolate(messages.data.retry, { s: Math.ceil(remaining) })
        : messages.data.retrying;
    dataTone = 'muted';
  } else {
    data = '';
    dataTone = 'muted';
  }

  const degraded =
    connected && status.simTransportDegraded === true ? messages.transport.degraded : null;

  const pendingCounts = input.outbox ?? status.pendingCounts ?? null;
  // T4: строка только про рейсы (разные единицы не суммируем). Точки/события —
  // уточнение, и только когда есть рейсы. Нет рейсов — строки нет вовсе.
  const pendingFlights = pendingCounts?.pendingFlights ?? 0;
  const pending =
    pendingFlights > 0
      ? [
          formatCount(input.locale, pendingFlights, messages.pendingFlights),
          pendingCounts && pendingCounts.pendingPoints > 0
            ? formatCount(input.locale, pendingCounts.pendingPoints, messages.pendingPoints)
            : null,
          pendingCounts && pendingCounts.pendingEvents > 0
            ? formatCount(input.locale, pendingCounts.pendingEvents, messages.pendingEvents)
            : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' ')
      : null;

  return {
    simulator,
    simulatorTone,
    flight,
    flightTone,
    data,
    dataTone,
    degraded,
    pending,
  };
}
