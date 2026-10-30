#!/usr/bin/env node
import { loadAgentConfig, type AgentConfig } from './cli/config.js';
import { createConsoleLogger, parseLogLevel } from './cli/logger.js';
import { bootstrapAgent } from './host/bootstrap.js';

const bootstrapLogger = createConsoleLogger({ level: parseLogLevel(process.env.AGENT_LOG_LEVEL) });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadConfigOrExit(): AgentConfig {
  try {
    return loadAgentConfig(process.env);
  } catch (error) {
    bootstrapLogger.error('invalid agent configuration', { error: errorMessage(error) });
    process.exit(2);
  }
}

const config = loadConfigOrExit();
const logger = createConsoleLogger({ level: config.logLevel });
const agent = await bootstrapAgent({ config, logger });

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  logger.info('shutdown requested', { signal });
  void agent.dispose(`signal:${signal}`).finally(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await agent.start();
  await agent.runtime.wait();
} catch (error) {
  logger.error('agent failed to start', { error: errorMessage(error) });
  await agent.dispose('start_failed').catch(() => undefined);
  process.exitCode = 1;
}
