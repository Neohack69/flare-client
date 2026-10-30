import { DEFAULT_PROTOCOL } from '../sim/node-simconnect-adapter.js';
import type { SimConnectAdapter, SimConnectOpenInfo, TelemetrySample } from '../sim/types.js';
import { SPIKE_REQUIRED_SIMVARS, SpikeProbe } from './probe.js';
import { buildSpikeReport, type SpikeFinishReason, type SpikeReport } from './report.js';

export const DEFAULT_SPIKE_MAX_SAMPLES = 60;
export const DEFAULT_SPIKE_DURATION_MS = 12_000;
export const DEFAULT_SPIKE_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_SPIKE_IDLE_TIMEOUT_MS = 8_000;
export const DEFAULT_SPIKE_MIN_SAMPLES = 5;

export interface SpikeRunOptions {
  adapter: SimConnectAdapter;
  protocol?: string;
  /** 0 — без лимита по числу сэмплов (ограничивает `durationMs`). */
  maxSamples?: number;
  durationMs?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  minSamples?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface SpikeRunResult {
  report: SpikeReport;
  /** 0 — GO, 2 — NO-GO (для CLI). */
  exitCode: number;
}

/**
 * Прогон CD-1: подключается (read-only) через переданный `SimConnectAdapter`,
 * собирает сэмплы до лимита/таймаута, гоняет детект фаз и печатает вердикт во
 * внешнем слое. Никогда не «зависает»: у каждого ожидания есть таймаут, а по
 * завершении listeners снимаются и соединение закрывается.
 */
export async function runSimConnectSpike(options: SpikeRunOptions): Promise<SpikeRunResult> {
  const {
    adapter,
    protocol = DEFAULT_PROTOCOL,
    maxSamples = DEFAULT_SPIKE_MAX_SAMPLES,
    durationMs = DEFAULT_SPIKE_DURATION_MS,
    connectTimeoutMs = DEFAULT_SPIKE_CONNECT_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_SPIKE_IDLE_TIMEOUT_MS,
    minSamples = DEFAULT_SPIKE_MIN_SAMPLES,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;

  const probe = new SpikeProbe();
  const errors: string[] = [];

  return new Promise<SpikeRunResult>((resolve) => {
    let settled = false;
    let connectedEver = false;
    let openInfo: SimConnectOpenInfo | null = null;
    let disconnectReason: string | null = null;
    let fatalConnectError: string | null = null;
    let finishedBy: SpikeFinishReason = 'duration';
    let durationStarted = false;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let durationTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = (handle: ReturnType<typeof setTimeout> | null): void => {
      if (handle !== null) clearTimeoutFn(handle);
    };

    const onOpen = (info: SimConnectOpenInfo): void => {
      connectedEver = true;
      openInfo = info;
      clearTimer(connectTimer);
      connectTimer = null;
      startDuration();
      armIdle();
    };

    const onSample = (sample: TelemetrySample): void => {
      probe.handleSample(sample);
      armIdle();
      if (maxSamples > 0 && probe.sampleCount >= maxSamples) finish('max_samples');
    };

    const onError = (error: Error): void => {
      errors.push(error.message);
    };

    const onDisconnect = (reason?: string): void => {
      disconnectReason = reason ?? null;
      finish('disconnect');
    };

    function startDuration(): void {
      if (durationStarted) return;
      durationStarted = true;
      durationTimer = setTimeoutFn(() => finish('duration'), durationMs);
    }

    function armIdle(): void {
      clearTimer(idleTimer);
      idleTimer = setTimeoutFn(() => finish('idle_timeout'), idleTimeoutMs);
    }

    const finish = (reason: SpikeFinishReason): void => {
      if (settled) return;
      settled = true;
      finishedBy = reason;
      clearTimer(connectTimer);
      clearTimer(durationTimer);
      clearTimer(idleTimer);
      connectTimer = null;
      durationTimer = null;
      idleTimer = null;

      adapter.off('open', onOpen);
      adapter.off('sample', onSample);
      adapter.off('error', onError);
      adapter.off('disconnect', onDisconnect);

      Promise.resolve()
        .then(() => adapter.disconnect())
        .catch(() => undefined)
        .then(() => {
          const report = buildSpikeReport({
            probe: probe.snapshot(),
            openInfo,
            connectedEver,
            protocol,
            errors,
            disconnectReason,
            fatalConnectError,
            finishedBy,
            minSamples,
          });
          resolve({ report, exitCode: report.verdict === 'GO' ? 0 : 2 });
        });
    };

    adapter.on('open', onOpen);
    adapter.on('sample', onSample);
    adapter.on('error', onError);
    adapter.on('disconnect', onDisconnect);

    connectTimer = setTimeoutFn(() => {
      if (!connectedEver) finish('connect_timeout');
    }, connectTimeoutMs);

    void Promise.resolve()
      .then(() => adapter.connect())
      .then((info) => {
        if (!connectedEver) onOpen(info);
      })
      .catch((error: unknown) => {
        fatalConnectError = error instanceof Error ? error.message : String(error);
        finish('connect_error');
      });
  });
}

/** Только для логов/интро: список обязательных переменных. */
export function requiredSimVarNames(): string[] {
  return SPIKE_REQUIRED_SIMVARS.map((def) => def.name);
}
