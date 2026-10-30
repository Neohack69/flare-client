import type { TelemetrySample } from '../sim/types.js';

export interface AdaptiveSamplerOptions {
  /** Частота в наборе/круизе/снижении (Гц). */
  cruiseHz: number;
  /** Частота в окне касания (Гц). */
  touchdownHz: number;
  /** Полуширина окна касания (с). ADR-0003: ±30 с. */
  windowS: number;
  /** Глубина rolling-буфера (с). ADR-0003: последние 60 с. */
  bufferS: number;
}

const DEFAULT_OPTIONS: AdaptiveSamplerOptions = {
  cruiseHz: 1,
  touchdownHz: 20,
  windowS: 30,
  bufferS: 60,
};

export interface SamplerDecision {
  rateHz: number;
  record: boolean;
}

/**
 * Прореживание потока до целевой частоты. Первый сэмпл сохраняется всегда,
 * дальше — не чаще, чем раз в `1000 / hz` мс (допуск 50% на джиттер кадров).
 */
export function decimateSamples(
  samples: readonly TelemetrySample[],
  hz: number,
): TelemetrySample[] {
  if (samples.length === 0 || hz <= 0) return [];
  const minDeltaMs = (1000 / hz) * 0.5;
  const result: TelemetrySample[] = [];
  let lastKeptMs: number | null = null;
  for (const sample of samples) {
    const ts = Date.parse(sample.ts);
    if (lastKeptMs === null || ts - lastKeptMs >= minDeltaMs) {
      result.push(sample);
      lastKeptMs = ts;
    }
  }
  return result;
}

/**
 * Адаптивная частота записи (ADR-0003): 1 Гц в круизе, 20 Гц в окне
 * `touchdown ± windowS`. Всегда ведёт rolling-буфер последних `bufferS` секунд,
 * чтобы при подтверждении касания отдать высокочастотные точки «назад во времени».
 */
export class AdaptiveSampler {
  private readonly options: AdaptiveSamplerOptions;
  private samples: TelemetrySample[] = [];
  private lastRecordedMs: number | null = null;
  private lastMs: number | null = null;
  private windowEndMs: number | null = null;

  constructor(options: Partial<AdaptiveSamplerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get currentRateHz(): number {
    return this.isWindowActive() ? this.options.touchdownHz : this.options.cruiseHz;
  }

  get touchdownHz(): number {
    return this.options.touchdownHz;
  }

  get windowS(): number {
    return this.options.windowS;
  }

  get windowActive(): boolean {
    return this.isWindowActive();
  }

  get bufferedSamples(): readonly TelemetrySample[] {
    return this.samples;
  }

  reset(): void {
    this.samples = [];
    this.lastRecordedMs = null;
    this.lastMs = null;
    this.windowEndMs = null;
  }

  push(sample: TelemetrySample): SamplerDecision {
    const nowMs = Date.parse(sample.ts);
    this.lastMs = nowMs;
    this.bufferSample(sample, nowMs);
    this.expireWindow(nowMs);

    const rateHz = this.currentRateHz;
    const intervalMs = 1000 / rateHz;
    const record = this.lastRecordedMs === null || nowMs - this.lastRecordedMs >= intervalMs * 0.9;
    if (record) this.lastRecordedMs = nowMs;
    return { rateHz, record };
  }

  /**
   * Подтверждение касания: активирует окно 20 Гц и возвращает прореженные
   * сэмплы за `windowS` до касания (митигация риска из ADR-0003).
   */
  markTouchdown(ts: string): { backfill: TelemetrySample[] } {
    const anchorMs = Date.parse(ts);
    this.windowEndMs = anchorMs + this.options.windowS * 1000;
    this.lastRecordedMs = anchorMs;

    const fromMs = anchorMs - this.options.windowS * 1000;
    const preTouchdown = this.samples.filter((sample) => {
      const sampleMs = Date.parse(sample.ts);
      return sampleMs >= fromMs && sampleMs < anchorMs;
    });
    return { backfill: decimateSamples(preTouchdown, this.options.touchdownHz) };
  }

  /** Продление окна 20 Гц при отскоке — «до стабилизации» (ADR-0003). */
  extendWindow(ts: string): void {
    const endMs = Date.parse(ts) + this.options.windowS * 1000;
    this.windowEndMs = this.windowEndMs === null ? endMs : Math.max(this.windowEndMs, endMs);
  }

  drain(): TelemetrySample[] {
    return [...this.samples];
  }

  private isWindowActive(): boolean {
    return this.windowEndMs !== null && this.lastMs !== null && this.lastMs <= this.windowEndMs;
  }

  private expireWindow(nowMs: number): void {
    if (this.windowEndMs !== null && nowMs > this.windowEndMs) {
      this.windowEndMs = null;
    }
  }

  private bufferSample(sample: TelemetrySample, nowMs: number): void {
    this.samples.push(sample);
    const cutoffMs = nowMs - this.options.bufferS * 1000;
    const trimmed = this.samples.filter((item) => Date.parse(item.ts) >= cutoffMs);
    this.samples = trimmed.length > 0 ? trimmed : [sample];
  }
}
