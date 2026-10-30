import type { DesktopAccount } from '@flightlog/contracts';
import { z } from 'zod';

/**
 * T-CLIENT2: best-effort снимок аккаунта для окна привязки. main читает
 * access-token устройства из защищённого хранилища и спрашивает `GET /v1/me`.
 * Сеть может быть недоступна или токен протух — тогда просто отдаём последнее
 * известное (или `null`); никаких ошибок наружу и никаких секретов в renderer.
 */

/** Толерантная к аддитивным полям схема ответа `/v1/me` (нам нужны 3 поля). */
const accountResponseSchema = z
  .object({
    email: z.string().trim().min(3).max(320).optional(),
    display_name: z.string().trim().min(1).max(64).optional(),
    plan: z.object({ name: z.string().trim().min(1).max(64) }).partial().optional(),
  })
  .passthrough();

export interface AccountResolverOptions {
  apiUrl: string;
  loadAccessToken(): Promise<string | null>;
  /** Инъекция fetch для тестов. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class AccountResolver {
  private cached: DesktopAccount | null = null;
  private inflight: Promise<DesktopAccount | null> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: AccountResolverOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  /** Последний успешный снимок (синхронно — для IPC). */
  get value(): DesktopAccount | null {
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }

  async refresh(): Promise<DesktopAccount | null> {
    if (!this.inflight) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async doRefresh(): Promise<DesktopAccount | null> {
    try {
      const token = await this.options.loadAccessToken();
      if (!token) {
        this.cached = null;
        return null;
      }
      const response = await this.fetchImpl(`${this.options.apiUrl}/v1/me`, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return this.cached;
      const body: unknown = await response.json();
      const data =
        typeof body === 'object' && body !== null && 'data' in body
          ? (body as { data: unknown }).data
          : body;
      const parsed = accountResponseSchema.safeParse(data);
      if (!parsed.success) return this.cached;
      const account: DesktopAccount = {
        email: parsed.data.email ?? null,
        displayName: parsed.data.display_name ?? null,
        planName: parsed.data.plan?.name ?? null,
      };
      if (!account.email && !account.displayName && !account.planName) {
        this.cached = null;
        return null;
      }
      this.cached = account;
      return account;
    } catch {
      return this.cached;
    }
  }
}
