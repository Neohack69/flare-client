import { TypedEmitter } from '../util/emitter.js';
import type {
  SimSource,
  SimSourceCapabilities,
  SimSourceDiagnostics,
  SimSourceEvents,
  SimSourceId,
  SimSourceOpenInfo,
} from './source.js';
import type { SimConnectOpenInfo, TelemetrySample } from './types.js';

export interface MockSimConnectAdapterOptions {
  openInfo?: Partial<SimConnectOpenInfo>;
}

export const MOCK_OPEN_INFO: SimConnectOpenInfo = {
  applicationName: 'Microsoft Flight Simulator 2024 (mock)',
  applicationVersion: '1.39.9.0',
  simConnectVersion: '0.0.0.0',
};

/** Детерминированный mock для unit-тестов и офлайн-разработки. Никакого сима не требует. */
export class MockSimConnectAdapter
  extends TypedEmitter<SimSourceEvents>
  implements SimSource
{
  readonly id: SimSourceId = 'msfs2024';
  readonly readOnly = true;

  private isConnected = false;

  constructor(private readonly options: MockSimConnectAdapterOptions = {}) {
    super();
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get capabilities(): SimSourceCapabilities {
    return {
      sim: this.id,
      maxSampleHz: 10,
      pauseDetection: 'gap',
      adapter: 'simconnect-mock',
    };
  }

  async connect(): Promise<SimSourceOpenInfo> {
    this.isConnected = true;
    const info: SimSourceOpenInfo = {
      ...MOCK_OPEN_INFO,
      ...this.options.openInfo,
      sim: this.id,
      simVersion: MOCK_OPEN_INFO.applicationVersion,
      adapter: 'simconnect-mock',
      protocol: null,
    };
    this.emit('open', info);
    return info;
  }

  diagnostics(): SimSourceDiagnostics | null {
    return null;
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;
    this.isConnected = false;
    this.emit('disconnect', 'mock disconnect');
  }

  /** Публикация сэмпла (эмулирует `simObjectData`). */
  pushSample(sample: TelemetrySample): void {
    if (!this.isConnected) return;
    this.emit('sample', sample);
  }

  /** Эмуляция разрыва соединения с симом. */
  simulateDisconnect(reason = 'mock connection lost'): void {
    if (!this.isConnected) return;
    this.isConnected = false;
    this.emit('disconnect', reason);
  }

  simulateError(error: Error): void {
    this.emit('error', error);
  }
}
