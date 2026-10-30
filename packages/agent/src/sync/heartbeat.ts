import type { Logger } from '../cli/logger.js';
import type { DeviceAuthClient } from './device-auth.js';
import { isOkStatus, type HttpClient, type HttpResponse } from './http.js';
import type { StoredTokens, TokenStore } from './token-store.js';

/** W1a: как часто агент подтверждает «онлайн» (сайт считает клиента в сети 5 мин). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
/** После стольких подряд неудач логируем одно предупреждение (без спама). */
export const HEARTBEAT_FAILURE_WARN_THRESHOLD = 3;
/** Таймаут одного heartbeat: не держим слот дольше минуты. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

export class HeartbeatError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HeartbeatError';
  }
}

export interface HeartbeatClientOptions {
  http: HttpClient;
  apiBaseUrl: string;
  tokenStore: TokenStore;
  /** Обновляет протухший access-токен (как у uploader/preview). */
  auth?: Pick<DeviceAuthClient, 'refresh'>;
  /** CD-6.2: `machine_id` для заголовка `X-TD-Machine-Id`; `null` — legacy. */
  machineId?: string | null;
  timeoutMs?: number;
}

/**
 * `POST /v1/agent/heartbeat` (W1a). Без тела ответа. `false` — устройство ещё не
 * спарено (токена нет), сеть/сервер не трогаем.
 */
export class HeartbeatClient {
  private readonly timeoutMs: number;
  private readonly machineId: string | null;

  constructor(private readonly options: HeartbeatClientOptions) {
    this.timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    const machineId = options.machineId?.trim();
    this.machineId = machineId && machineId.length > 0 ? machineId : null;
  }

  async send(): Promise<boolean> {
    const stored = await this.options.tokenStore.load();
    if (!stored) return false;

    const url = `${this.options.apiBaseUrl}/v1/agent/heartbeat`;
    let response = await this.post(stored.access_token, url);
    if (response.status === 401 && this.options.auth) {
      const refreshed: StoredTokens = await this.options.auth.refresh();
      response = await this.post(refreshed.access_token, url);
    }
    if (!isOkStatus(response.status)) {
      throw new HeartbeatError(`heartbeat failed with HTTP ${response.status}`, response.status);
    }
    return true;
  }

  private post(token: string, url: string): Promise<HttpResponse> {
    return this.options.http.request({
      method: 'POST',
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(this.machineId ? { 'x-td-machine-id': this.machineId } : {}),
      },
      timeoutMs: this.timeoutMs,
    });
  }
}

export interface HeartbeatSchedulerOptions {
  client: Pick<HeartbeatClient, 'send'>;
  logger: Pick<Logger, 'warn'>;
  intervalMs?: number;
  failureWarnThreshold?: number;
}

/**
 * Периодический heartbeat, не зависящий от записи рейса: пока агент запущен,
 * устройство видно на сайте в сети. Ошибки не роняют рантайм; предупреждение —
 * только после `failureWarnThreshold` подряд неудач и один раз до восстановления.
 */
export class HeartbeatScheduler {
  private readonly intervalMs: number;
  private readonly failureWarnThreshold: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private failures = 0;
  private warned = false;

  constructor(private readonly options: HeartbeatSchedulerOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.failureWarnThreshold = Math.max(
      1,
      options.failureWarnThreshold ?? HEARTBEAT_FAILURE_WARN_THRESHOLD,
    );
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const sent = await this.options.client.send();
      if (sent) {
        this.failures = 0;
        this.warned = false;
      }
    } catch (error) {
      this.failures += 1;
      if (!this.warned && this.failures >= this.failureWarnThreshold) {
        this.warned = true;
        this.options.logger.warn('heartbeat unavailable', {
          consecutive_failures: this.failures,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.inFlight = false;
    }
  }
}
