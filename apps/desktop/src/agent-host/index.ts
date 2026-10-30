import { dirname, join } from 'node:path';

import type { AgentConfig, BootstrappedAgent } from '@flightlog/agent';
import { bootstrapAgent } from '@flightlog/agent/host';
import { redactRecord, type Logger } from '@flightlog/agent/logging';
import { MemoryOutboxBuffer } from '@flightlog/agent/memory-buffer';
import type { StoredTokens, TokenStore } from '@flightlog/agent/token-store';
import {
  desktopIpcMainToHostSchema,
  type DesktopAgentConfig,
  type DesktopIpcMainToHost,
  type DesktopOutboxCounts,
} from '@flightlog/contracts';

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

interface HostTransport {
  post(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
}

interface PendingRequest {
  resolve(message: unknown): void;
  reject(error: Error): void;
}

/** Логгер host: применяет `redactRecord` и форвардит в main (без console). */
function createBridgeLogger(transport: HostTransport): Logger {
  const forward =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, meta?: Record<string, unknown>): void => {
      transport.post({
        type: 'log',
        level,
        message,
        meta: meta ? redactRecord(meta) : undefined,
      });
    };
  return {
    debug: forward('debug'),
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
  };
}

/** `utilityProcess` (parentPort) с fallback на `child_process.fork` (process.send). */
function createTransport(): HostTransport {
  const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  if (parentPort) {
    return {
      post: (message) => parentPort.postMessage(message),
      onMessage: (handler) => parentPort.on('message', (event) => handler(event.data)),
    };
  }
  return {
    post: (message) => {
      process.send?.(message);
    },
    onMessage: (handler) => {
      process.on('message', (message) => handler(message));
    },
  };
}

/** `TokenStore` в host: проксирует load/save/clear в main (safeStorage). */
class HostTokenStoreProxy implements TokenStore {
  private seq = 0;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly transport: HostTransport) {}

  load(): Promise<StoredTokens | null> {
    const reqId = ++this.seq;
    return this.call(reqId, { type: 'token:load' }, (message) => {
      return (message as { tokens: StoredTokens | null }).tokens ?? null;
    });
  }

  async save(tokens: StoredTokens): Promise<void> {
    const reqId = ++this.seq;
    await this.call(reqId, { type: 'token:save', tokens }, (message) => {
      if ((message as { ok?: boolean }).ok !== true) throw new Error('token save failed');
    });
  }

  async clear(): Promise<void> {
    const reqId = ++this.seq;
    await this.call(reqId, { type: 'token:clear' }, (message) => {
      if ((message as { ok?: boolean }).ok !== true) throw new Error('token clear failed');
    });
  }

  handle(message: DesktopIpcMainToHost): boolean {
    if (
      message.type === 'token:load:result' ||
      message.type === 'token:save:result' ||
      message.type === 'token:clear:result'
    ) {
      this.pending.get(message.reqId)?.resolve(message);
      this.pending.delete(message.reqId);
      return true;
    }
    if (message.type === 'token:error') {
      this.pending.get(message.reqId)?.reject(new Error(message.message));
      this.pending.delete(message.reqId);
      return true;
    }
    return false;
  }

  private call<T>(
    reqId: number,
    payload: Record<string, unknown>,
    extract: (message: unknown) => T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, {
        resolve: (message) => {
          try {
            resolve(extract(message));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        reject,
      });
      this.transport.post({ ...payload, reqId });
    });
  }
}

function toAgentConfig(config: DesktopAgentConfig): AgentConfig {
  return {
    apiUrl: config.apiUrl,
    tokenStorePath:
      config.tokenStorePath ?? join(dirname(config.outboxPath), 'agent-tokens.enc'),
    outboxPath: config.outboxPath,
    clientName: config.clientName,
    platform: config.platform,
    aircraftIcao: config.aircraftIcao ?? null,
    protocol: config.protocol,
    maxSampleHz: config.maxSampleHz,
    syncIntervalMs: config.syncIntervalMs ?? 30_000,
    connectPollMs: config.connectPollMs ?? 1_000,
    reconnectBaseMs: config.reconnectBaseMs ?? 5_000,
    reconnectMaxMs: config.reconnectMaxMs ?? 60_000,
    shutdownFlushMs: config.shutdownFlushMs ?? 15_000,
    logLevel: config.logLevel ?? 'info',
  };
}

const EMPTY_COUNTS: DesktopOutboxCounts = {
  flights: 0,
  points: 0,
  events: 0,
  pendingFlights: 0,
  pendingPoints: 0,
  pendingEvents: 0,
};

const transport = createTransport();
const tokenStore = new HostTokenStoreProxy(transport);
const logger: Logger = createBridgeLogger(transport);

let agent: BootstrappedAgent | null = null;
let starting = false;

function pendingCounts(): DesktopOutboxCounts {
  if (!agent) return EMPTY_COUNTS;
  try {
    return agent.buffer.pendingCounts();
  } catch {
    return EMPTY_COUNTS;
  }
}

async function startAgent(config: DesktopAgentConfig): Promise<void> {
  if (agent || starting) return;
  starting = true;
  try {
    const useMemoryBuffer = process.env.FLIGHTLOG_AGENT_MEMORY_BUFFER === '1';
    agent = await bootstrapAgent({
      config: toAgentConfig(config),
      tokenStore,
      buffer: useMemoryBuffer ? new MemoryOutboxBuffer() : undefined,
      logger,
      onStatus: (event) => transport.post({ type: 'status', event }),
      onUserCode: (info) =>
        transport.post({
          type: 'auth:userCode',
          user_code: info.user_code,
          verification_uri: info.verification_uri,
          expires_in: info.expires_in,
        }),
    });
    await agent.start();
  } catch (error) {
    transport.post({
      type: 'fatal',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    starting = false;
  }
}

async function stopAgent(): Promise<void> {
  const current = agent;
  agent = null;
  if (!current) return;
  await current.dispose('desktop_stop');
}

async function handleMessage(raw: unknown): Promise<void> {
  const parsed = desktopIpcMainToHostSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('agent-host: dropping invalid message from main');
    return;
  }
  const message = parsed.data;
  if (tokenStore.handle(message)) return;

  switch (message.type) {
    case 'agent:start':
      await startAgent(message.config);
      break;
    case 'agent:restart':
      await stopAgent();
      await startAgent(message.config);
      break;
    case 'agent:stop':
      // Робастный финиш (CD-3.1): stopAgent ждёт финальный flush/`complete`
      // (shutdownFlushMs), и только после него host завершает процесс. Main
      // в dispose() ждёт именно `exit`, а не убивает по 2 c.
      await stopAgent();
      process.exit(0);
      break;
    case 'agent:sync':
      // T126: ручной синк из трея/окна «Состояние агента» → уведомление с итогом.
      agent?.runtime.syncNow('manual');
      break;
    case 'outbox:stats':
      transport.post({
        type: 'outbox:stats:result',
        reqId: message.reqId,
        counts: pendingCounts(),
      });
      break;
    default:
      break;
  }
}

transport.onMessage((message) => {
  void handleMessage(message);
});

process.on('disconnect', () => {
  void stopAgent().finally(() => process.exit(0));
});

process.on('uncaughtException', (error) => {
  transport.post({ type: 'fatal', error: error.message });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  transport.post({
    type: 'fatal',
    error: reason instanceof Error ? reason.message : String(reason),
  });
});
