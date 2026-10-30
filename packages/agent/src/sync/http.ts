export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429]);

/**
 * Оборачивает fetch в замыкание, вызывающее оригинал как свободную функцию.
 * Без этого `this.fetchImpl(...)` подставляет в native `fetch` `this` экземпляра
 * FetchHttpClient (в браузере/Electron → `TypeError: Illegal invocation`).
 */
function bindFetch(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => fetchImpl(input, init);
}

/** Ретраятся сетевые ошибки, `408/425/429` и `5xx` (api.md §1.2/§4). */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status) || status >= 500;
}

export function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

export interface BackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** `undefined` — без ограничения числа попыток (агент дозаливает бесконечно). */
  maxAttempts?: number;
  random?: () => number;
}

export const DEFAULT_BASE_DELAY_MS = 1000;
export const DEFAULT_MAX_DELAY_MS = 5 * 60 * 1000;

/** Экспоненциальный backoff с джиттером: `1s, 2s, 4s, …` до `cap`. */
export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const cap = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const random = options.random ?? Math.random;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt));
  const jittered = exp * (0.5 + 0.5 * random());
  return Math.round(Math.min(cap, jittered));
}

/** `Retry-After` в миллисекундах (секунды или HTTP-дата). */
export function parseRetryAfterMs(
  headers: Record<string, string>,
  nowMs = Date.now(),
): number | null {
  const raw = headers['retry-after'];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs);
  return null;
}

export interface FetchHttpClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** HTTP-транспорт на глобальном `fetch` (Node 20+). */
export class FetchHttpClient implements HttpClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FetchHttpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = bindFetch(options.fetchImpl ?? fetch);
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? this.timeoutMs);
    try {
      const headers: Record<string, string> = { ...(request.headers ?? {}) };
      let body: string | undefined;
      if (request.body !== undefined) {
        headers['content-type'] ??= 'application/json';
        body = JSON.stringify(request.body);
      }
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers,
        body,
        signal: controller.signal,
      });
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: responseHeaders,
        body: parseBody(text),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
