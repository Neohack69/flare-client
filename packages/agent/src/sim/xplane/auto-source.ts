/**
 * X-Plane 12 авто-источник (`XPlaneAutoSimSource`, ADR-0023 §2.3).
 *
 * Порядок выбора транспорта: `web` → при ошибке `rref` → иначе `connect error`.
 * Явное переопределение — `AGENT_XP_TRANSPORT=web|rref`. Обе реализации за одним
 * портом `SimSource`, поэтому рекордер/скоринг не знают о транспорте.
 *
 * Инвариант «один рекордер — один сим»: активна ровно одна подписка (transport
 * выбирается один раз при `connect`, повторный выбор — после `disconnect`).
 */
import type { SimConnectAdapterLogger } from '../node-simconnect-adapter.js';
import type {
  SimSource,
  SimSourceCapabilities,
  SimSourceDiagnostics,
  SimSourceEvents,
  SimSourceId,
  SimSourceOpenInfo,
} from '../source.js';
import type { TelemetrySample } from '../types.js';
import { TypedEmitter } from '../../util/emitter.js';
import { XP_DEFAULT_MAX_SAMPLE_HZ, type XPlaneTransportPreference } from './config.js';

export interface XPlaneAutoSimSourceOptions {
  web: SimSource;
  rref: SimSource;
  /** `auto` (дефолт) | `web` | `rref`. */
  preference?: XPlaneTransportPreference;
  logger?: SimConnectAdapterLogger;
}

/** X-Plane 12: Web API с автоматическим фолбэком на UDP RREF. */
export class XPlaneAutoSimSource extends TypedEmitter<SimSourceEvents> implements SimSource {
  readonly id: SimSourceId = 'xplane12';
  readonly readOnly = true;

  private active: SimSource | null = null;
  private isConnected = false;
  private fallbackReason: string | null = null;

  constructor(private readonly options: XPlaneAutoSimSourceOptions) {
    super();
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get capabilities(): SimSourceCapabilities {
    if (this.active) return this.active.capabilities;
    return {
      sim: this.id,
      maxSampleHz: XP_DEFAULT_MAX_SAMPLE_HZ,
      pauseDetection: 'direct',
      adapter: this.label(),
    };
  }

  diagnostics(): SimSourceDiagnostics | null {
    const active = this.active?.diagnostics() ?? null;
    if (this.fallbackReason === null) return active;
    const reason = this.fallbackReason;
    const suffix = `DEGRADED: web API unavailable → RREF fallback (${reason})`;
    if (active === null) {
      return { message: `X-Plane 12: ${suffix}`, meta: { transport_fallback: true, fallback_reason: reason } };
    }
    return {
      message: `${active.message}; ${suffix}`,
      meta: { ...active.meta, transport_fallback: true, fallback_reason: reason },
    };
  }

  async connect(): Promise<SimSourceOpenInfo> {
    const preference = this.options.preference ?? 'auto';
    this.fallbackReason = null;
    if (preference === 'web') return this.adopt(this.options.web);
    if (preference === 'rref') return this.adopt(this.options.rref);

    try {
      return await this.adopt(this.options.web);
    } catch (webError) {
      const reason = toError(webError).message;
      this.fallbackReason = reason;
      // Фолбэк обязан быть ГРОМКИМ: тихая деградация Web API → RREF маскировала
      // дефект транспорта (upgrade-сокеты). Всегда warn + метка в diagnostics().
      this.options.logger?.warn(
        `X-Plane web API unavailable; falling back to RREF (degraded transport). reason: ${reason}`,
        {
          transport: 'xp-auto',
          falling_back_to: 'xp-udp-rref',
          reason,
        },
      );
      try {
        const info = await this.adopt(this.options.rref);
        // Деградация транспорта видна и в open-info (UI: «Web API недоступен → RREF»).
        return { ...info, transportDegraded: true };
      } catch (rrefError) {
        throw new Error(
          `X-Plane 12 unavailable (web: ${reason}; ` +
            `rref: ${toError(rrefError).message})`,
        );
      }
    }
  }

  async disconnect(): Promise<void> {
    const active = this.active;
    if (!active) return;
    await active.disconnect();
    this.detach(active);
    this.active = null;
    this.isConnected = false;
  }

  private async adopt(source: SimSource): Promise<SimSourceOpenInfo> {
    const info = await source.connect();
    this.attach(source);
    this.active = source;
    this.isConnected = true;
    this.emit('open', info);
    return info;
  }

  private attach(source: SimSource): void {
    source.off('sample', this.forwardSample);
    source.off('disconnect', this.forwardDisconnect);
    source.off('error', this.forwardError);
    source.on('sample', this.forwardSample);
    source.on('disconnect', this.forwardDisconnect);
    source.on('error', this.forwardError);
  }

  private detach(source: SimSource): void {
    source.off('sample', this.forwardSample);
    source.off('disconnect', this.forwardDisconnect);
    source.off('error', this.forwardError);
  }

  private readonly forwardSample = (sample: TelemetrySample): void => {
    this.emit('sample', sample);
  };

  private readonly forwardDisconnect = (reason?: string): void => {
    this.isConnected = false;
    this.emit('disconnect', reason);
  };

  private readonly forwardError = (error: Error): void => {
    this.emit('error', error);
  };

  private label(): string {
    switch (this.options.preference ?? 'auto') {
      case 'web':
        return 'xp-web-api-v1';
      case 'rref':
        return 'xp-udp-rref';
      default:
        return 'xp-auto';
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
