import {
  bootstrapOutboxSync,
  type BootstrapAgentOptions,
  type BootstrappedOutboxSync,
} from '../host/bootstrap.js';
import { pendingTotal, type OutboxSyncResult } from '../sync/outbox-syncer.js';
import { loadAgentConfig, type AgentConfig } from './config.js';
import { describeError as errorMessage } from './error-message.js';
import { createConsoleLogger, type Logger } from './logger.js';

export interface ManualSyncOutcome {
  ok: boolean;
  config?: AgentConfig;
  result?: OutboxSyncResult;
  error?: string;
}

type ManualSyncOverrides = Pick<
  BootstrapAgentOptions,
  'tokenStore' | 'http' | 'buffer' | 'auth' | 'uploader' | 'syncer' | 'sleep' | 'random'
>;

export interface ManualSyncOptions extends ManualSyncOverrides {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

/**
 * Одноразовый синк outbox → API для CLI-команды `sync`/`flush` и диагностики.
 * Не подключается к симулятору: читает env-конфиг, поднимает SQLite-буфер,
 * выгружает pending-рейсы и возвращает статус (сколько ушло/осталось).
 *
 * `ok=false` при ошибке или если после прогона остались незалитые строки —
 * процесс завершится с ненулевым кодом.
 */
export async function runManualSync(options: ManualSyncOptions = {}): Promise<ManualSyncOutcome> {
  const { env, logger: providedLogger, ...overrides } = options;

  let config: AgentConfig;
  try {
    config = loadAgentConfig(env ?? process.env);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }

  const logger = providedLogger ?? createConsoleLogger({ level: config.logLevel });
  let sync: BootstrappedOutboxSync;
  try {
    sync = await bootstrapOutboxSync({ config, logger, ...overrides });
  } catch (error) {
    return { ok: false, config, error: errorMessage(error) };
  }

  try {
    const result = await sync.syncer.flush('manual');
    const pending = pendingTotal(result.pending_after);
    return {
      ok: pending === 0,
      config,
      result,
      error: pending === 0 ? undefined : `${pending} row(s) still pending after manual sync`,
    };
  } catch (error) {
    return { ok: false, config, error: errorMessage(error) };
  } finally {
    sync.close();
  }
}
