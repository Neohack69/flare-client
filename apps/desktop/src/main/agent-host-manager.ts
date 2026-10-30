import { fork, type ChildProcess } from 'node:child_process';

import type { AgentLogger, StoredTokens, TokenStore } from '@flightlog/agent';
import { redactRecord } from '@flightlog/agent/logging';
import {
  desktopIpcHostToMainSchema,
  type AgentStatusEvent,
  type DesktopAgentConfig,
  type DesktopIpcMainToHost,
  type DesktopOutboxCounts,
} from '@flightlog/contracts';
import { utilityProcess, type UtilityProcess } from 'electron';

export interface AgentHostHandlers {
  onStatus(event: AgentStatusEvent): void;
  onUserCode(info: { user_code: string; verification_uri: string; expires_in: number }): void;
  onFatal(error: string): void;
  onLog?(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown): void;
  onOutboxStats?(counts: DesktopOutboxCounts): void;
  onRunningChange?(running: boolean): void;
}

export interface AgentHostManagerOptions {
  hostScriptPath: string;
  tokenStore: TokenStore;
  logger: AgentLogger;
  handlers: AgentHostHandlers;
  /**
   * Extra env for agent-host: `FLIGHTLOG_MACHINE_ID`, `AGENT_SOURCE`,
   * `AGENT_VERSION` (CD-6), `FLIGHTLOG_FOQA_SIMVARS` (opt-in FOQA live-bisect),
   * `AGENT_SIM_SOURCE` (ADR-0023 источник телеметрии — pass-through как задал
   * оператор). Never logged.
   */
  env?: Record<string, string>;
  /**
   * Upper bound for the graceful `dispose()` handshake. Defaults to the agent's
   * `shutdownFlushMs` + a small grace (CD-3.1). Tests can shorten it.
   */
  disposeTimeoutMs?: number;
}

const MAX_RESTART_ATTEMPTS = 10;

/** Agent default for the final flush before exit (`shutdownFlushMs`). */
export const DEFAULT_SHUTDOWN_FLUSH_MS = 15_000;
/** Extra time on top of the flush window to let host exit after flushing. */
export const DISPOSE_GRACE_MS = 5_000;

const EMPTY_COUNTS: DesktopOutboxCounts = {
  flights: 0,
  points: 0,
  events: 0,
  pendingFlights: 0,
  pendingPoints: 0,
  pendingEvents: 0,
};

type HostChild = UtilityProcess | ChildProcess;

/**
 * Supervise agent-host (ADR-0011 §1): `utilityProcess.fork` с fallback на
 * `child_process.fork`, JSON-RPC по MessagePort, перезапуск с backoff при падении.
 * token-запросы host проксируются в main (safeStorage) — host не имеет доступа
 * к `safeStorage` и не видит открытый токен.
 */
export class AgentHostManager {
  private child: HostChild | null = null;
  private usingUtilityProcess = true;
  private stopping = false;
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private agentConfig: DesktopAgentConfig | null = null;

  constructor(private readonly options: AgentHostManagerOptions) {}

  isActive(): boolean {
    return this.agentConfig !== null;
  }

  start(config: DesktopAgentConfig): void {
    if (this.agentConfig) return;
    this.stopping = false;
    this.agentConfig = config;
    this.restartAttempts = 0;
    this.ensureChild();
    this.post({ type: 'agent:start', config });
    this.options.handlers.onRunningChange?.(true);
  }

  stop(): void {
    if (!this.agentConfig) return;
    this.agentConfig = null;
    this.post({ type: 'agent:stop' });
    this.options.handlers.onRunningChange?.(false);
  }

  /**
   * Перезапуск агента без «мигания» running-состояния: host атомарно завершает
   * текущий runtime и поднимает новый (свежий device-code, T116).
   */
  restart(config: DesktopAgentConfig): void {
    if (!this.agentConfig) {
      this.start(config);
      return;
    }
    this.agentConfig = config;
    this.restartAttempts = 0;
    this.ensureChild();
    this.post({ type: 'agent:restart', config });
  }

  syncNow(): void {
    this.post({ type: 'agent:sync' });
  }

  requestOutboxStats(): void {
    this.post({ type: 'outbox:stats' });
  }

  /**
   * Graceful shutdown (CD-3.1): send `agent:stop`, let host run its final flush
   * (`shutdownFlushMs`, default 15 c) and exit on its own, then wait for `exit`.
   * Only kills on timeout, never after a fixed 2 c.
   */
  async dispose(): Promise<void> {
    this.stopping = true;
    const config = this.agentConfig;
    this.agentConfig = null;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (!child) {
      this.options.handlers.onRunningChange?.(false);
      return;
    }

    const flushMs = config?.shutdownFlushMs ?? DEFAULT_SHUTDOWN_FLUSH_MS;
    const timeoutMs = this.options.disposeTimeoutMs ?? flushMs + DISPOSE_GRACE_MS;

    let settled = false;
    const exited = new Promise<void>((resolve) => {
      (child as unknown as NodeJS.EventEmitter).once('exit', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve('timeout');
      }, timeoutMs);
    });

    try {
      this.sendTo(child, { type: 'agent:stop' } as DesktopIpcMainToHost);
    } catch {
      // ignore — процесс всё равно завершаем
    }

    const result = await Promise.race([exited.then(() => 'exited' as const), timedOut]);
    if (timer) clearTimeout(timer);
    if (result === 'timeout') {
      this.options.logger.warn('agent-host: dispose timed out waiting for final flush; killing', {
        timeout_ms: timeoutMs,
        flush_ms: flushMs,
      });
      this.kill(child);
    }
    this.options.handlers.onRunningChange?.(false);
  }

  /** Clean env: process.env + machine/source/version, strings only. */
  private childEnv(): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries({
      ...process.env,
      ...(this.options.env ?? {}),
    })) {
      if (typeof value === 'string') clean[key] = value;
    }
    return clean;
  }

  private ensureChild(): void {
    if (this.child) return;
    const script = this.options.hostScriptPath;
    try {
      const child = utilityProcess.fork(script, [], {
        serviceName: 'Flare Agent Host',
        stdio: 'pipe',
        env: this.childEnv(),
      });
      this.attachUtility(child);
      this.child = child;
      this.usingUtilityProcess = true;
    } catch (error) {
      this.options.logger.warn('utilityProcess.fork failed; falling back to child_process.fork', {
        error: error instanceof Error ? error.message : String(error),
      });
      const child = fork(script, [], {
        env: { ...this.childEnv(), ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      this.attachFork(child);
      this.child = child;
      this.usingUtilityProcess = false;
    }
  }

  private attachUtility(child: UtilityProcess): void {
    child.on('message', (message) => this.handleMessage(message));
    child.on('exit', (code) => this.handleExit(child, code));
    child.stdout?.on('data', (chunk: Buffer) => this.logStream('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.logStream('stderr', chunk));
  }

  private attachFork(child: ChildProcess): void {
    child.on('message', (message) => this.handleMessage(message));
    child.on('exit', (code) => this.handleExit(child, code));
    child.stdout?.on('data', (chunk: Buffer) => this.logStream('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.logStream('stderr', chunk));
  }

  private logStream(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const text = chunk.toString('utf8').trim();
    if (!text) return;
    const level = stream === 'stderr' ? 'warn' : 'debug';
    this.options.logger[level](`agent-host ${stream}`, { message: text.slice(0, 1_000) });
  }

  private post(message: DesktopIpcMainToHost): void {
    if (!this.child) return;
    this.sendTo(this.child, message);
  }

  private sendTo(child: HostChild, message: DesktopIpcMainToHost): void {
    if (this.usingUtilityProcess) {
      (child as UtilityProcess).postMessage(message);
    } else {
      (child as ChildProcess).send(message);
    }
  }

  private kill(child: HostChild): void {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }

  private handleExit(child: HostChild, code: number | null): void {
    // Ignore a stale exit from a child that was already replaced/disposed.
    if (this.child !== null && this.child !== child) return;
    this.child = null;
    this.options.handlers.onRunningChange?.(false);
    if (this.stopping || !this.agentConfig) return;

    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this.options.handlers.onFatal(
        `agent-host exited repeatedly (code ${code ?? 'null'}); giving up`,
      );
      this.agentConfig = null;
      return;
    }

    const delay = Math.min(1_000 * 2 ** this.restartAttempts, 30_000);
    this.restartAttempts += 1;
    this.options.logger.warn('agent-host exited; restarting', {
      code,
      attempt: this.restartAttempts,
      retry_in_ms: delay,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping || !this.agentConfig) return;
      const config = this.agentConfig;
      this.ensureChild();
      this.post({ type: 'agent:start', config });
      this.options.handlers.onRunningChange?.(true);
    }, delay);
  }

  private handleMessage(raw: unknown): void {
    const parsed = desktopIpcHostToMainSchema.safeParse(raw);
    if (!parsed.success) {
      this.options.logger.warn('agent-host: dropping invalid IPC message');
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case 'status':
        this.options.handlers.onStatus(message.event);
        break;
      case 'auth:userCode':
        this.options.handlers.onUserCode({
          user_code: message.user_code,
          verification_uri: message.verification_uri,
          expires_in: message.expires_in,
        });
        break;
      case 'fatal':
        this.options.handlers.onFatal(message.error);
        break;
      case 'log':
        this.options.handlers.onLog?.(
          message.level,
          message.message,
          message.meta ? redactRecord(message.meta) : undefined,
        );
        break;
      case 'outbox:stats:result':
        this.options.handlers.onOutboxStats?.(message.counts);
        break;
      case 'token:load':
        void this.serviceToken('load', message.reqId);
        break;
      case 'token:save':
        void this.serviceToken('save', message.reqId, message.tokens);
        break;
      case 'token:clear':
        void this.serviceToken('clear', message.reqId);
        break;
      default:
        break;
    }
  }

  private async serviceToken(
    action: 'load' | 'save' | 'clear',
    reqId: number,
    tokens?: StoredTokens,
  ): Promise<void> {
    try {
      if (action === 'load') {
        const stored = await this.options.tokenStore.load();
        this.post({ type: 'token:load:result', reqId, tokens: stored ?? null });
      } else if (action === 'save') {
        if (!tokens) throw new Error('token:save without tokens');
        await this.options.tokenStore.save(tokens);
        this.post({ type: 'token:save:result', reqId, ok: true });
      } else {
        await this.options.tokenStore.clear();
        this.post({ type: 'token:clear:result', reqId, ok: true });
      }
    } catch (error) {
      this.post({
        type: 'token:error',
        reqId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export { EMPTY_COUNTS };
