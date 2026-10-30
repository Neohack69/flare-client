/**
 * Порт `SimSource` (ADR-0023, Решение 1) — сим-агностичный источник телеметрии.
 *
 * Рекордер (`FlightRecorder`), детект касания (`LandingTracker`), FOQA-анализ и
 * детерминированный скоринг уже работают с нормализованным `TelemetrySample` и не
 * знают, откуда он пришёл. Этот порт — единственное место, где пайплайн знает о
 * симе: он отдаёт поток `TelemetrySample`, а `connect()` возвращает
 * `SimSourceOpenInfo` с меткой источника (`sim`) того же соединения.
 *
 * READ-ONLY (жёсткий инвариант, AGENTS.md / ADR-0023 §2.4): реализация порта
 * ТОЛЬКО читает телеметрию. Она НЕ пишет переменные сима, НЕ ставит/снимает
 * паузу, НЕ командует симом и не вмешивается в активный полёт. Реализации не
 * должны экспонировать write-глаголы транспорта (SimConnect set-операции, X-Plane
 * `DREF`/`PATCH`/`dataref_set_values`/`command_*`/`/flight` и т.п.).
 */
import type { SimConnectOpenInfo, TelemetrySample } from './types.js';

/** Канонические id симуляторов (ADR-0023). */
export type SimSourceId = 'msfs2024' | 'xplane12';

/**
 * Предпочтение выбора источника: `auto` (дефолт) или явный id.
 * Env-переопределение — `AGENT_SIM_SOURCE` (аварийный клапан QA/CI).
 */
export type SimSourcePreference = SimSourceId | 'auto';

/** Имя env-переменной выбора источника (`auto` по умолчанию). */
export const SIM_SOURCE_ENV = 'AGENT_SIM_SOURCE';

/** Логический дефолт выбора источника (ADR-0023, Решение 3). */
export const DEFAULT_SIM_SOURCE_PREFERENCE: SimSourcePreference = 'auto';

/** Источник по умолчанию, к которому разрешается `auto` (приоритет при «оба запущены»). */
export const DEFAULT_SIM_SOURCE_ID: SimSourceId = 'msfs2024';

/** Распознаваемые значения `AGENT_SIM_SOURCE` (иное → warn + фолбэк). */
export const KNOWN_SIM_SOURCE_PREFERENCES: readonly SimSourcePreference[] = [
  'auto',
  'msfs2024',
  'xplane12',
];

/**
 * Идентичность источника/транспорта соединения (ADR-0023 §1). Расширяет
 * legacy-`SimConnectOpenInfo`, поэтому существующие потребители open-info
 * (лог подключения, `SimConnectOpenInfo`-типы) продолжают работать; поля
 * `sim`/`simVersion`/`adapter`/`protocol` — аддитивная информационная добавка.
 */
export interface SimSourceOpenInfo extends SimConnectOpenInfo {
  /** Метка источника именно этого соединения (не берётся из глобального env). */
  sim: SimSourceId;
  /** Версия сима, если известна (`"1.39.9"`, `"12.1.4"`); иначе `null`. */
  simVersion: string | null;
  /** Реализация/транспорт: `"simconnect-sunrise"`, `"xp-web-api-v1"`, `"xp-udp-rref"`. */
  adapter: string;
  /** Протокол: `"sunrise"`, `"websocket"`, `"rref"`; иначе `null`. */
  protocol: string | null;
  /**
   * `true` — транспорт деградировал относительно предпочтительного (X-Plane:
   * Web API недоступен → RREF-фолбэк). Для явного `AGENT_XP_TRANSPORT=rref` не
   * выставляется: это выбор оператора, а не деградация.
   */
  transportDegraded?: boolean;
}

export interface SimSourceEvents {
  open: (info: SimSourceOpenInfo) => void;
  sample: (sample: TelemetrySample) => void;
  disconnect: (reason?: string) => void;
  error: (error: Error) => void;
}

/**
 * One-time диагностика канонического набора полей (аналог
 * `describeSimVarDefinition` для MSFS). Возвращается без логирования; host/CLI
 * логирует её один раз при connect.
 */
export interface SimSourceDiagnostics {
  message: string;
  meta: Record<string, unknown>;
}

/** Статические возможности источника (для выбора/диагностики). */
export interface SimSourceCapabilities {
  readonly sim: SimSourceId;
  /** Верхняя частота потока, поддерживаемая транспортом (Гц). */
  readonly maxSampleHz: number;
  /** `direct` — прямой датчик паузы (XP `sim/time/paused`); `gap` — gap-based (MSFS). */
  readonly pauseDetection: 'direct' | 'gap';
  /** Реализация/транспорт (совпадает с `SimSourceOpenInfo.adapter`). */
  readonly adapter: string;
}

/**
 * Read-only источник телеметрии. Реализации: `NodeSimConnectAdapter` (MSFS 2024),
 * далее — `XPlaneWebApiSimSource`/`XPlaneRrefSimSource` (X-Plane 12).
 *
 * `readOnly` — явное обещание: источник никогда не пишет в сим (см. шапку файла).
 */
export interface SimSource {
  readonly id: SimSourceId;
  readonly connected: boolean;
  /** Структурная гарантия read-only: значение всегда `true`. */
  readonly readOnly: true;
  /** Статические возможности источника. */
  readonly capabilities: SimSourceCapabilities;
  connect(): Promise<SimSourceOpenInfo>;
  disconnect(): Promise<void>;
  on<K extends keyof SimSourceEvents>(event: K, handler: SimSourceEvents[K]): void;
  off<K extends keyof SimSourceEvents>(event: K, handler: SimSourceEvents[K]): void;
  /** One-time отчёт о каноническом наборе полей; `null`, если неприменимо. */
  diagnostics(): SimSourceDiagnostics | null;
}
