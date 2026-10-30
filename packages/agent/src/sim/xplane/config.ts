/**
 * Конфигурация read-only транспорта X-Plane 12 (ADR-0023, Решения 2/3).
 *
 * Жёсткий инвариант (`docs/devops/xplane-12-security-assessment.md` §2.4/§5.2):
 * транспорт подключается ТОЛЬКО к loopback. Любой не-loopback base URL (LAN IP,
 * домен, `0.0.0.0`) — отказ ещё на этапе конструирования, а не «мы аккуратно»:
 * это защищает от случайного раскрытия порта сима и от MITM-подмены конфига.
 */

/** Env-переключатель транспорта: `auto` (дефолт) | `web` | `rref`. */
export const XP_TRANSPORT_ENV = 'AGENT_XP_TRANSPORT';
/** Env-переопределение базового URL встроенного web-сервера X-Plane. */
export const XP_WEB_URL_ENV = 'AGENT_XP_WEB_URL';
/** Env-переопределение UDP-порта RREF. */
export const XP_RREF_PORT_ENV = 'AGENT_XP_RREF_PORT';

/** Дефолтный адрес встроенного web-сервера X-Plane 12 (порт 8086, ADR-0023 §2.1b). */
export const XP_WEB_API_DEFAULT_URL = 'http://127.0.0.1:8086';
/** Дефолтный адрес/порт UDP RREF (ADR-0023 §2.1a). */
export const XP_RREF_DEFAULT_HOST = '127.0.0.1';
export const XP_RREF_DEFAULT_PORT = 49000;

/** Верхняя частота потока (D1: 20 Гц — окно касания; см. ADR-0003). */
export const XP_DEFAULT_MAX_SAMPLE_HZ = 20;
/** Таймаут дешёвой пробы web-сервера для `auto` (ADR-0023 §2.3/§3: ~500 мс). */
export const XP_CAPABILITIES_TIMEOUT_MS = 500;
/** Таймаут REST-запросов резолва dataref (ADR-0023 §3: ~300 мс на пробу). */
export const XP_REST_TIMEOUT_MS = 1_000;
/** Таймаут ожидания первого ответа транспорта при `connect` (мс). */
export const XP_CONNECT_TIMEOUT_MS = 1_000;

/** Транспорт XP. `auto` — Web API, затем RREF (ADR-0023 §2.3). */
export type XPlaneTransportPreference = 'auto' | 'web' | 'rref';

export const DEFAULT_XP_TRANSPORT_PREFERENCE: XPlaneTransportPreference = 'auto';

export const KNOWN_XP_TRANSPORT_PREFERENCES: readonly XPlaneTransportPreference[] = [
  'auto',
  'web',
  'rref',
];

export interface ParsedXPlaneTransport {
  preference: XPlaneTransportPreference;
  /** Неизвестное значение env (для warning'а); `null`, если распознано/пусто. */
  unknown: string | null;
}

/** Разбирает `AGENT_XP_TRANSPORT`. Неизвестное значение → дефолт + `unknown`. */
export function parseXPlaneTransport(raw: string | null | undefined): ParsedXPlaneTransport {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { preference: DEFAULT_XP_TRANSPORT_PREFERENCE, unknown: null };
  }
  const value = raw.trim().toLowerCase();
  if (value === 'auto' || value === 'web' || value === 'rref') {
    return { preference: value, unknown: null };
  }
  return { preference: DEFAULT_XP_TRANSPORT_PREFERENCE, unknown: raw.trim() };
}

/** Отказ старта: адрес/URL транспорта X-Plane не является loopback. */
export class XPlaneNonLoopbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XPlaneNonLoopbackError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '0:0:0:0:0:0:0:1', 'localhost']);

function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** `true` только для loopback (127.0.0.1 / ::1 / localhost). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHost(host));
}

/**
 * Проверяет URL: допустимая схема + строго loopback host. Любое иное — бросок
 * `XPlaneNonLoopbackError` (отказ старта, а не warning).
 */
export function parseLoopbackUrl(raw: string, protocols: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new XPlaneNonLoopbackError(`X-Plane transport URL is not a valid URL: '${raw}'`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new XPlaneNonLoopbackError(
      `X-Plane transport URL must use ${protocols.join('/')} (got '${url.protocol}')`,
    );
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new XPlaneNonLoopbackError(
      `X-Plane transport refuses non-loopback host '${url.hostname}' (loopback only)`,
    );
  }
  return url;
}

/** Читает `AGENT_XP_WEB_URL` (по умолчанию `http://127.0.0.1:8086`), проверяет loopback. */
export function readXPlaneWebUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env[XP_WEB_URL_ENV];
  const value =
    typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : XP_WEB_API_DEFAULT_URL;
  const url = parseLoopbackUrl(value, ['http:', 'https:']);
  return url.toString().replace(/\/+$/, '');
}

/** Читает `AGENT_XP_RREF_PORT` (по умолчанию 49000), строго 1..65535. */
export function readXPlaneRrefPort(env: Record<string, string | undefined> = process.env): number {
  const raw = env[XP_RREF_PORT_ENV];
  if (typeof raw !== 'string' || raw.trim().length === 0) return XP_RREF_DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new XPlaneNonLoopbackError(`${XP_RREF_PORT_ENV} must be a port 1..65535 (got '${raw}')`);
  }
  return port;
}

/** `http(s)://host:port` → `ws(s)://host:port/api/v3` (loopback уже проверен). */
export function toXPlaneWebSocketUrl(baseUrl: string): string {
  const url = parseLoopbackUrl(baseUrl, ['http:', 'https:']);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${url.origin}/api/v3`;
}
