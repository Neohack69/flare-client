import {
  mePlanTrialSchema,
  planCodeSchema,
  type AgentMePlan,
} from '@flightlog/contracts';
import { z } from 'zod';

/** Толерантная к аддитивным полям схема: старый клиент не ломается от новых полей. */
const planResponseSchema = z
  .object({
    plan: z
      .object({
        code: planCodeSchema,
        name: z.string().trim().min(1).max(64),
        trial: mePlanTrialSchema.optional(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * iter77: план для premium-скина desktop-клиента. Agent-scope endpoint
 * `GET /v1/agent/me` (scope agent), тот же device token, что у остальных
 * `/v1/agent/*`. Best-effort: нет сети/токена — оставляем последнее известное
 * значение; нет кэша — null (renderer рисует базовый скин, не «полускин»).
 */
export interface PlanResolverOptions {
  apiUrl: string;
  loadAccessToken(): Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class PlanResolver {
  private cached: AgentMePlan | null = null;
  private inflight: Promise<AgentMePlan | null> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: PlanResolverOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  get value(): AgentMePlan | null {
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }

  async refresh(): Promise<AgentMePlan | null> {
    if (!this.inflight) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async doRefresh(): Promise<AgentMePlan | null> {
    try {
      const token = await this.options.loadAccessToken();
      if (!token) {
        this.cached = null;
        return null;
      }
      const response = await this.fetchImpl(`${this.options.apiUrl}/v1/agent/me`, {
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
      const parsed = planResponseSchema.safeParse(data);
      if (!parsed.success) return this.cached;
      this.cached = parsed.data.plan;
      return this.cached;
    } catch {
      return this.cached;
    }
  }
}
