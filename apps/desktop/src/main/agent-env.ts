import { SIM_SOURCE_ENV } from '@flightlog/agent';

export interface AgentEnvInput {
  /** Базовое окружение процесса (`process.env`). */
  baseEnv: Record<string, string | undefined>;
  /** CD-3.2/CD-6.2: machine-id (raw-значение, не логируется). */
  machineId: string;
  /** CD-6.1: канал источника телеметрии (`electron`). */
  source: string;
  /** CD-4.2: версия клиента. */
  version: string;
  /** T-FOQA: opt-in набор SimVars для live-bisect (`FLIGHTLOG_FOQA_SIMVARS`). */
  foqaSimvars?: string | null;
}

/**
 * Env для процесса agent-host (ADR-0011 §4, ADR-0023 решение 3).
 *
 * Помимо machine-id/source/version явно прокидываем `AGENT_SIM_SOURCE` ровно
 * тем значением, что задал оператор. Имя переменной берём из константы
 * `@flightlog/agent`, чтобы оно не разъезжалось с агентом. Переменная
 * опциональна: если оператор её не задал — не выдумываем дефолт (логический
 * дефолт `auto` живёт в агенте). `AgentHostManager` дополнительно мержит
 * `process.env`, но этот allow-list гарантирует pass-through и при будущем
 * санитайзинге окружения.
 */
export function buildAgentEnv(input: AgentEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    FLIGHTLOG_MACHINE_ID: input.machineId,
    AGENT_SOURCE: input.source,
    AGENT_VERSION: input.version,
  };
  const foqa = input.foqaSimvars?.trim();
  if (foqa) env.FLIGHTLOG_FOQA_SIMVARS = foqa;
  const simSource = input.baseEnv[SIM_SOURCE_ENV];
  if (typeof simSource === 'string') env[SIM_SOURCE_ENV] = simSource;
  return env;
}
