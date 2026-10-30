import { SIM_SOURCE_ENV, type AgentLogger, type StoredTokens, type TokenStore } from '@flightlog/agent';
import type { DesktopAgentConfig } from '@flightlog/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ForkCall {
  script: string;
  args: unknown[];
  options: { env?: Record<string, string> } | undefined;
}

const state = vi.hoisted(() => {
  class FakeEmitter {
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    on(event: string, listener: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }
    once(event: string, listener: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]): void => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }
    off(event: string, listener: (...args: unknown[]) => void): void {
      const list = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        list.filter((item) => item !== listener),
      );
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
  }

  class FakeChild extends FakeEmitter {
    postMessage = vi.fn();
    kill = vi.fn(() => {
      this.emit('exit', 1);
    });
    stdout = new FakeEmitter();
    stderr = new FakeEmitter();
  }

  return {
    FakeChild,
    forkCalls: [] as ForkCall[],
    children: [] as InstanceType<typeof FakeChild>[],
  };
});

vi.mock('electron', () => ({
  utilityProcess: {
    fork: (script: string, args: unknown[], options: ForkCall['options']) => {
      const child = new state.FakeChild();
      state.forkCalls.push({ script, args, options });
      state.children.push(child);
      return child;
    },
  },
}));

import {
  AgentHostManager,
  DEFAULT_SHUTDOWN_FLUSH_MS,
  type AgentHostHandlers,
} from './agent-host-manager';

function makeLogger(): AgentLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const tokenStore: TokenStore = {
  load: async (): Promise<StoredTokens | null> => null,
  save: async (): Promise<void> => undefined,
  clear: async (): Promise<void> => undefined,
};

const CONFIG: DesktopAgentConfig = {
  apiUrl: 'https://api.example',
  outboxPath: 'C:/data/agent/outbox.sqlite',
  clientName: 'Flare Desktop',
  platform: 'win32',
  protocol: 'sunrise',
  maxSampleHz: 10,
  shutdownFlushMs: DEFAULT_SHUTDOWN_FLUSH_MS,
};

function makeManager(
  handlers: Partial<AgentHostHandlers> = {},
  options: { disposeTimeoutMs?: number } = {},
): AgentHostManager {
  return new AgentHostManager({
    hostScriptPath: 'C:/app/out/main/agent-host.js',
    tokenStore,
    logger: makeLogger(),
    disposeTimeoutMs: options.disposeTimeoutMs,
    env: {
      FLIGHTLOG_MACHINE_ID: 'AbCdEfGhIjKlMnOpQrStUv',
      AGENT_SOURCE: 'electron',
      AGENT_VERSION: '0.2.0',
      FLIGHTLOG_FOQA_SIMVARS: 'config,ils',
      [SIM_SOURCE_ENV]: 'xplane12',
    },
    handlers: {
      onStatus: vi.fn(),
      onUserCode: vi.fn(),
      onFatal: vi.fn(),
      ...handlers,
    },
  });
}

beforeEach(() => {
  state.forkCalls.length = 0;
  state.children.length = 0;
  vi.useRealTimers();
});

describe('AgentHostManager env (CD-3.2)', () => {
  it('прокидывает machine-id/source/version в env agent-host', () => {
    const manager = makeManager();
    manager.start(CONFIG);
    expect(state.forkCalls).toHaveLength(1);
    const env = state.forkCalls[0]?.options?.env ?? {};
    expect(env.FLIGHTLOG_MACHINE_ID).toBe('AbCdEfGhIjKlMnOpQrStUv');
    expect(env.AGENT_SOURCE).toBe('electron');
    expect(env.AGENT_VERSION).toBe('0.2.0');
    // FOQA-флаг (opt-in live-bisect) доходит до agent-host.
    expect(env.FLIGHTLOG_FOQA_SIMVARS).toBe('config,ils');
    // ADR-0023: источник телеметрии доходит до agent-host ровно как задан.
    expect(env[SIM_SOURCE_ENV]).toBe('xplane12');
  });
});

describe('AgentHostManager.dispose (CD-3.1)', () => {
  it('ждёт graceful stop: запрашивает stop и разрешается по exit, без kill', async () => {
    const manager = makeManager();
    manager.start(CONFIG);
    const child = state.children[0]!;

    const disposing = manager.dispose();
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'agent:stop' });

    child.emit('exit', 0);
    await disposing;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('по таймауту ≥ shutdownFlushMs убивает, а не ждёт 2 c', async () => {
    vi.useFakeTimers();
    const manager = makeManager({}, { disposeTimeoutMs: 500 });
    manager.start(CONFIG);
    const child = state.children[0]!;

    const disposing = manager.dispose();
    await vi.advanceTimersByTimeAsync(499);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await disposing;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('идемпотентен: без child resolve сразу', async () => {
    const manager = makeManager();
    await expect(manager.dispose()).resolves.toBeUndefined();
  });

  it('сообщает onRunningChange(false) после завершения', async () => {
    const onRunningChange = vi.fn();
    const manager = makeManager({ onRunningChange });
    manager.start(CONFIG);
    const disposing = manager.dispose();
    state.children[0]!.emit('exit', 0);
    await disposing;
    expect(onRunningChange).toHaveBeenCalledWith(false);
  });
});
