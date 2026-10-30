import {
  deviceCodeResponseSchema,
  deviceTokenResponseSchema,
  type DeviceCodeResponse,
  type DeviceTokenResponse,
} from '@flightlog/contracts';

import type { HttpClient, HttpResponse } from './http.js';
import type { StoredTokens, TokenStore } from './token-store.js';

export class DeviceAuthError extends Error {
  constructor(
    message: string,
    readonly code: string = 'UNAUTHORIZED',
  ) {
    super(message);
    this.name = 'DeviceAuthError';
  }
}

export interface DeviceAuthOptions {
  http: HttpClient;
  apiBaseUrl: string;
  tokenStore: TokenStore;
  clientName: string;
  platform: string;
  /**
   * CD-6.2: локальный `machine_id` (ADR-0018 §5). Уходит полем в
   * `device/code`/`token`/`refresh`; `null`/`undefined` — legacy без поля.
   */
  machineId?: string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onUserCode?: (info: DeviceCodeResponse) => void;
}

/** Пауза перед единственным повтором refresh после 401. */
export const REFRESH_RETRY_DELAY_MS = 1_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function problemCode(response: HttpResponse): string | undefined {
  const body = response.body;
  if (typeof body !== 'object' || body === null) return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function extractData(response: HttpResponse): unknown {
  return typeof response.body === 'object' && response.body !== null
    ? (response.body as { data?: unknown }).data
    : undefined;
}

/**
 * OAuth 2.0 Device Authorization Flow (api.md §2.3): `code` → поллинг `token`
 * → `refresh`. Токены персистятся в `TokenStore` (после успешного поллинга).
 */
export class DeviceAuthClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private refreshInFlight: Promise<StoredTokens> | null = null;

  constructor(private readonly options: DeviceAuthOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  async requestCode(): Promise<DeviceCodeResponse> {
    const response = await this.options.http.request({
      method: 'POST',
      url: `${this.options.apiBaseUrl}/v1/auth/device/code`,
      body: this.withMachineId({
        client_name: this.options.clientName,
        platform: this.options.platform,
      }),
    });
    if (response.status !== 200) {
      throw new DeviceAuthError(
        `device/code failed with HTTP ${response.status}`,
        problemCode(response),
      );
    }
    const parsed = deviceCodeResponseSchema.safeParse(extractData(response));
    if (!parsed.success) {
      throw new DeviceAuthError('unexpected device/code response shape', 'UPSTREAM_UNAVAILABLE');
    }
    return parsed.data;
  }

  /** Полный флоу: получить код, дождаться подтверждения пользователем, сохранить токены. */
  async authorize(): Promise<StoredTokens> {
    const code = await this.requestCode();
    this.options.onUserCode?.(code);
    return this.pollToken(code.device_code, code.interval, code.expires_in);
  }

  async pollToken(
    deviceCode: string,
    intervalS: number,
    expiresInS: number,
  ): Promise<StoredTokens> {
    const deadlineMs = this.now() + expiresInS * 1000;
    for (;;) {
      const response = await this.options.http.request({
        method: 'POST',
        url: `${this.options.apiBaseUrl}/v1/auth/device/token`,
        body: this.withMachineId({ device_code: deviceCode }),
      });

      if (response.status === 200) {
        const tokens = parseTokens(response);
        await this.persist(tokens);
        return toStored(tokens);
      }

      const pending = response.status === 428 || problemCode(response) === 'AUTHORIZATION_PENDING';
      if (pending) {
        if (this.now() >= deadlineMs) {
          throw new DeviceAuthError('device code expired', 'EXPIRED_TOKEN');
        }
        await this.sleep(Math.max(1, intervalS) * 1000);
        continue;
      }

      throw new DeviceAuthError(
        `device/token failed with HTTP ${response.status}`,
        problemCode(response) ?? 'EXPIRED_TOKEN',
      );
    }
  }

  /**
   * Single-flight: параллельные 401 делят один refresh-запрос (иначе ротация
   * токенов гоняется и клиент может остаться с чужим `device_token`).
   */
  refresh(): Promise<StoredTokens> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.performRefresh().finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<StoredTokens> {
    const stored = await this.options.tokenStore.load();
    if (!stored) throw new DeviceAuthError('no stored device token', 'UNAUTHORIZED');

    let response = await this.requestRefresh(stored.device_token);
    if (response.status === 200) return this.accept(response);

    let code = problemCode(response);
    if (code === 'MACHINE_MISMATCH') {
      // ADR-0018 §5: MACHINE_MISMATCH — токены НЕ чистим и устройство не
      // пересоздаём: клиент уходит в NeedsRepair, офлайн-буфер сохраняется.
      throw new DeviceAuthError('device machine mismatch', 'MACHINE_MISMATCH');
    }

    // Первый 401 — почти всегда протухший access/потерянный ответ ротации:
    // один тихий повтор, токены сохраняем до подтверждённой второй ошибки.
    if (response.status !== 401) {
      throw new DeviceAuthError('device token refresh failed', code ?? 'UNAUTHORIZED');
    }
    await this.sleep(REFRESH_RETRY_DELAY_MS);
    const latest = await this.options.tokenStore.load();
    if (!latest) throw new DeviceAuthError('no stored device token', 'UNAUTHORIZED');
    const retryToken = latest.device_token;

    response = await this.requestRefresh(retryToken);
    if (response.status === 200) return this.accept(response);

    code = problemCode(response);
    if (code === 'MACHINE_MISMATCH') {
      throw new DeviceAuthError('device machine mismatch', 'MACHINE_MISMATCH');
    }
    if (response.status === 401) {
      const current = await this.options.tokenStore.load();
      if (current?.device_token === retryToken) {
        await this.options.tokenStore.clear();
      }
    }
    throw new DeviceAuthError('device token refresh failed', code ?? 'UNAUTHORIZED');
  }

  private requestRefresh(deviceToken: string): Promise<HttpResponse> {
    return this.options.http.request({
      method: 'POST',
      url: `${this.options.apiBaseUrl}/v1/auth/device/refresh`,
      body: this.withMachineId({ device_token: deviceToken }),
    });
  }

  private async accept(response: HttpResponse): Promise<StoredTokens> {
    const tokens = parseTokens(response);
    await this.persist(tokens);
    return toStored(tokens);
  }

  /** Добавляет `machine_id`, если он известен (CD-6.2); иначе тело без изменений. */
  private withMachineId<T extends Record<string, unknown>>(
    body: T,
  ): T & { machine_id?: string } {
    const machineId = this.options.machineId;
    return machineId ? { ...body, machine_id: machineId } : body;
  }

  private async persist(tokens: DeviceTokenResponse): Promise<void> {
    await this.options.tokenStore.save({
      ...toStored(tokens),
      access_expires_at: new Date(this.now() + tokens.expires_in * 1000).toISOString(),
    });
  }
}

function parseTokens(response: HttpResponse): DeviceTokenResponse {
  const parsed = deviceTokenResponseSchema.safeParse(extractData(response));
  if (!parsed.success) {
    throw new DeviceAuthError('unexpected device/token response shape', 'UPSTREAM_UNAVAILABLE');
  }
  return parsed.data;
}

function toStored(tokens: DeviceTokenResponse): StoredTokens {
  return {
    access_token: tokens.access_token,
    device_token: tokens.device_token,
    device_id: tokens.device_id,
  };
}
