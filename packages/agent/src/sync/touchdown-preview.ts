import {
  touchdownPreviewRequestSchema,
  touchdownPreviewResponseSchema,
  type TouchdownPreviewRequest,
  type TouchdownPreviewResponse,
} from '@flightlog/contracts';

import type { HttpClient, HttpResponse } from './http.js';
import { isOkStatus } from './http.js';
import type { StoredTokens, TokenStore } from './token-store.js';
import { SyncError } from './uploader.js';

/** Таймаут одного вызова предпросмотра (`score-preview.md` §4): fire-and-forget. */
export const TOUCHDOWN_PREVIEW_TIMEOUT_MS = 1_500;

/** Endpoint недоступен/ответ непригоден (старый сервер, 404, malformed). Fallback. */
export class PreviewUnavailableError extends Error {
  constructor(message = 'touchdown preview unavailable') {
    super(message);
    this.name = 'PreviewUnavailableError';
  }
}

/** Запрос отменён новым касанием. Не ошибка для UX — просто игнорируем. */
export class PreviewAbortedError extends Error {
  constructor(message = 'touchdown preview aborted') {
    super(message);
    this.name = 'PreviewAbortedError';
  }
}

export interface TouchdownPreviewClientOptions {
  apiBaseUrl: string;
  http: HttpClient;
  tokenStore: TokenStore;
  auth: { refresh(): Promise<StoredTokens> };
  /** CD-6.2: `machine_id` для заголовка `X-TD-Machine-Id`; `null` — legacy. */
  machineId?: string | null;
  timeoutMs?: number;
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new PreviewAbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new PreviewAbortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Клиент `POST /v1/flights/{serverFlightId}/touchdown-preview` (`score-preview.md`
 * §2.1/§4). Без ретраев: предпросмотр — улучшение UX, при любой неудаче агент
 * тихо остаётся на клиентском балле с меткой «предварительно».
 */
export class TouchdownPreviewClient {
  private readonly timeoutMs: number;
  private readonly machineId: string | null;

  constructor(private readonly options: TouchdownPreviewClientOptions) {
    this.timeoutMs = options.timeoutMs ?? TOUCHDOWN_PREVIEW_TIMEOUT_MS;
    const machineId = options.machineId?.trim();
    this.machineId = machineId && machineId.length > 0 ? machineId : null;
  }

  async request(
    serverFlightId: string,
    input: TouchdownPreviewRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<TouchdownPreviewResponse> {
    const signal = options.signal;
    if (signal?.aborted) throw new PreviewAbortedError();

    const stored = await this.options.tokenStore.load();
    if (!stored) throw new PreviewUnavailableError('no stored device tokens');

    const body = touchdownPreviewRequestSchema.parse(input);
    const url = `${this.options.apiBaseUrl}/v1/flights/${serverFlightId}/touchdown-preview`;

    let response = await this.send(stored.access_token, url, body, signal);
    if (response.status === 401) {
      const refreshed = await this.options.auth.refresh();
      response = await this.send(refreshed.access_token, url, body, signal);
    }
    // Ответ мог прийти уже после отмены (новое касание) — не применяем.
    if (signal?.aborted) throw new PreviewAbortedError();

    if (response.status === 404) {
      throw new PreviewUnavailableError('touchdown preview endpoint not found (404)');
    }
    if (!isOkStatus(response.status)) {
      throw new SyncError(`touchdown preview failed with HTTP ${response.status}`, {
        status: response.status,
        retryable: false,
      });
    }
    const parsed = touchdownPreviewResponseSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new PreviewUnavailableError('malformed touchdown preview response');
    }
    return parsed.data;
  }

  private async send(
    token: string,
    url: string,
    body: TouchdownPreviewRequest,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    const request = this.options.http.request({
      method: 'POST',
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(this.machineId ? { 'x-td-machine-id': this.machineId } : {}),
      },
      body,
      timeoutMs: this.timeoutMs,
    });
    return raceAbort(request, signal);
  }
}
