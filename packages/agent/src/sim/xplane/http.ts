/**
 * Read-only HTTP-клиент X-Plane Web API (REST-подмножество, ADR-0023 §2.4).
 *
 * Структурный read-only: у класса есть ТОЛЬКО GET-методы (`capabilities`,
 * `findDataref`, `getDatarefValue`). Нет «общего» `request(method, …)`/`send()`,
 * нет методов записи. Метод HTTP в запросе не задаётся вовсе (fetch по умолчанию
 * делает GET). `redirect: 'error'` — запрет кросс-origin редиректов (SSRF-hardening
 * поверх loopback-проверки).
 */
import { XP_REST_TIMEOUT_MS, parseLoopbackUrl, readXPlaneWebUrl } from './config.js';

export type XPlaneWebApiErrorReason =
  | 'forbidden'
  | 'unreachable'
  | 'timeout'
  | 'unsupported'
  | 'invalid-response';

/** Ошибка web-API XP: 403/недоступность/timeout/неожиданный ответ. */
export class XPlaneWebApiError extends Error {
  constructor(
    readonly reason: XPlaneWebApiErrorReason,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'XPlaneWebApiError';
  }
}

export interface XPlaneCapabilities {
  readonly apiVersions: readonly string[];
  readonly simVersion: string | null;
}

export interface XPlaneDatarefInfo {
  readonly id: number;
  readonly name: string;
  readonly valueType: string | null;
  readonly writable: boolean | null;
}

export interface XPlaneRestClientOptions {
  /** Base URL (по умолчанию `AGENT_XP_WEB_URL` / `http://127.0.0.1:8086`); строго loopback. */
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Тонкий read-only REST-клиент встроенного web-сервера X-Plane. */
export class XPlaneRestClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: XPlaneRestClientOptions = {}) {
    const raw = options.baseUrl ?? readXPlaneWebUrl();
    this.baseUrl = normalizeBaseUrl(raw);
    this.timeoutMs = options.timeoutMs ?? XP_REST_TIMEOUT_MS;
    const impl = options.fetchImpl ?? fetch;
    // Обёртка свободной функции: без неё `this.fetchImpl(...)` подставляет в fetch
    // неверный `this` (как в `sync/http.ts`).
    this.fetchImpl = (input, init) => impl(input, init);
  }

  /** `GET /api/capabilities` — версия сима и список версий API. */
  async getCapabilities(): Promise<XPlaneCapabilities> {
    const body = await this.getJson('/api/capabilities');
    return parseCapabilities(body);
  }

  /** `GET /api/v3/datarefs?filter[name]=<exact>` — резолв dataref по имени. */
  async findDataref(name: string): Promise<XPlaneDatarefInfo | null> {
    const body = await this.getJson(
      `/api/v3/datarefs?filter[name]=${encodeURIComponent(name)}`,
    );
    const list = parseDatarefList(body);
    return list.find((entry) => entry.name === name) ?? list[0] ?? null;
  }

  /** `GET /api/v3/datarefs/{id}/value` — точечное чтение (probe; в проде не поллим). */
  async getDatarefValue(id: number): Promise<number | null> {
    const body = await this.getJson(`/api/v3/datarefs/${id}/value`);
    const record = asRecord(body);
    const value = record?.value ?? record?.data;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  /** Единственная низкоуровневая операция — GET JSON. Никаких других методов. */
  private async getJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: {
          accept: 'application/json',
          // Закрываем keep-alive соединение после каждого GET. Встроенный
          // web-сервер X-Plane держит ограниченный пул HTTP-сокетов; после ~47
          // последовательных резолвов dataref пул исчерпывается и последующий
          // WebSocket-upgrade отдаёт не-101. `Connection: close` гарантирует, что
          // upgrade всегда получает свежий сокет (транспорт остаётся GET-only).
          connection: 'close',
        },
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status === 403) {
        throw new XPlaneWebApiError(
          'forbidden',
          `X-Plane web API returned 403 for ${path} (incoming traffic disabled?)`,
          403,
        );
      }
      if (!response.ok) {
        throw new XPlaneWebApiError(
          'invalid-response',
          `X-Plane web API ${path} -> HTTP ${response.status}`,
          response.status,
        );
      }
      const text = await response.text();
      if (text.trim().length === 0) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new XPlaneWebApiError(
          'invalid-response',
          `X-Plane web API ${path} returned non-JSON body`,
        );
      }
    } catch (error) {
      if (error instanceof XPlaneWebApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new XPlaneWebApiError('timeout', `X-Plane web API ${path} timed out`);
      }
      throw new XPlaneWebApiError(
        'unreachable',
        `X-Plane web API ${path} unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeBaseUrl(raw: string): string {
  return parseLoopbackUrl(raw, ['http:', 'https:']).toString().replace(/\/+$/, '');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Толерантный разбор `/api/capabilities` (схема ответа — `VERIFY-LIVE-TOMORROW`). */
export function parseCapabilities(body: unknown): XPlaneCapabilities {
  const record = asRecord(body);
  const api = asRecord(record?.api);
  const versionsRaw = api?.versions;
  const apiVersions = Array.isArray(versionsRaw)
    ? versionsRaw.filter((value): value is string => typeof value === 'string')
    : [];
  const simRecord =
    asRecord(record?.['x-plane']) ?? asRecord(record?.xplane) ?? asRecord(record?.sim);
  const simVersion = stringOrNull(simRecord?.version ?? record?.version);
  return { apiVersions, simVersion };
}

/** Толерантный разбор ответа `/api/v3/datarefs` (схема — `VERIFY-LIVE-TOMORROW`). */
export function parseDatarefList(body: unknown): XPlaneDatarefInfo[] {
  const raw = extractList(body);
  const out: XPlaneDatarefInfo[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const id = typeof record.id === 'number' && Number.isFinite(record.id) ? record.id : null;
    const name = stringOrNull(record.name);
    if (id === null || name === null) continue;
    const writableRaw = record.is_writable ?? record.writable;
    out.push({
      id,
      name,
      valueType: stringOrNull(record.value_type ?? record.valueType),
      writable: typeof writableRaw === 'boolean' ? writableRaw : null,
    });
  }
  return out;
}

function extractList(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const record = asRecord(body);
  if (!record) return [];
  for (const key of ['data', 'datarefs', 'items']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}
