/**
 * X-Plane 12 UDP `RREF` фолбэк-источник (`XPlaneRrefSimSource`, ADR-0023 §2.1a).
 *
 * Включается, когда Web API недоступен (XP < 12.1.1, `--no_web_server`, «Disable
 * Incoming Traffic» → 403). Единственный разрешённый исходящий UDP-пакет — `RREF`;
 * `freq=0` отписывает. Никаких write-датаграмм транспорт не конструирует.
 *
 * ⚠️ Точность: RREF отдаёт значения **float32** для всех dataref'ов. Для
 * `latitude`/`longitude` это ~1 м позиционной ошибки (`RREF_POSITION_TOLERANCE_M`) —
 * допустимо для порога телепорта (50 м), но хуже Web API (double). Массивы
 * подписываются поэлементно (`dataref[i]`).
 */
import { createSocket } from 'node:dgram';

import type { SimConnectAdapterLogger } from '../node-simconnect-adapter.js';
import type {
  SimSource,
  SimSourceCapabilities,
  SimSourceDiagnostics,
  SimSourceEvents,
  SimSourceId,
  SimSourceOpenInfo,
} from '../source.js';
import { TypedEmitter } from '../../util/emitter.js';
import type { TelemetrySample } from '../types.js';
import {
  XPLANE_CORE_REQUIRED_DATAREFS,
  XPLANE_NO_EQUIVALENT_FIELDS,
  XPLANE_REQUIRED_DATAREFS,
  planRrefSubscriptions,
  type XPlaneSubscriptionTarget,
} from './datarefs.js';
import { describeXPlaneSubscription } from './diagnostics.js';
import {
  XP_CONNECT_TIMEOUT_MS,
  XP_DEFAULT_MAX_SAMPLE_HZ,
  XP_RREF_DEFAULT_HOST,
  readXPlaneRrefPort,
} from './config.js';
import {
  RREF_POSITION_TOLERANCE_M,
  decodeRrefValues,
  encodeRrefRequest,
  isRrefResponse,
} from './rref.js';
import {
  buildXPlaneSample,
  readXPlaneBool,
  setXPlaneValue,
  type XPlaneRawValue,
} from './values.js';
import {
  XPLANE_AIRCRAFT_IDENTITY_RECHECK_MS,
  resolveXPlaneAircraftIdentity,
  type XPlaneAircraftIdentity,
} from './aircraft-identity.js';

/** Минимальная форма UDP-сокета (тестируется без сети). */
export interface DgramSocketLike {
  on(event: 'message', listener: (msg: Buffer, rinfo: unknown) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  send(
    msg: Buffer,
    port: number,
    address: string,
    callback?: (error: Error | null) => void,
  ): void;
  close(callback?: () => void): void;
  removeAllListeners?(event?: string): void;
}

export type DgramSocketFactory = () => DgramSocketLike;

/** Адаптер `node:dgram` (`udp4`) к `DgramSocketLike`. */
export function defaultDgramSocketFactory(): DgramSocketLike {
  return createSocket('udp4') as unknown as DgramSocketLike;
}

/** Отказ RREF: сокет не ответил/ошибка (сим не запущен, UDP выключен). */
export class XPlaneRrefUnavailableError extends Error {
  constructor(
    readonly reason: 'timeout' | 'error',
    message: string,
  ) {
    super(message);
    this.name = 'XPlaneRrefUnavailableError';
  }
}

export interface XPlaneRrefSimSourceOptions {
  /** Loopback host (по умолчанию `127.0.0.1`). */
  host?: string;
  port?: number;
  maxSampleHz?: number;
  logger?: SimConnectAdapterLogger;
  socketFactory?: DgramSocketFactory;
  connectTimeoutMs?: number;
  now?: () => number;
  /** Test hook: resolve the loaded aircraft identity (defaults to Log.txt + .acf). */
  aircraftIdentity?: () => XPlaneAircraftIdentity | null;
  /** Minimum interval between grounded identity re-checks (ms). */
  aircraftIdentityRecheckMs?: number;
}

/** Read-only источник X-Plane 12 поверх UDP `RREF`. */
export class XPlaneRrefSimSource extends TypedEmitter<SimSourceEvents> implements SimSource {
  readonly id: SimSourceId = 'xplane12';
  readonly readOnly = true;

  private readonly host: string;
  private readonly port: number;
  private readonly socketFactory: DgramSocketFactory;
  private readonly logger: SimConnectAdapterLogger | undefined;
  private readonly maxSampleHz: number;
  private readonly connectTimeoutMs: number;
  private readonly now: () => number;
  private readonly resolveAircraftIdentity: () => XPlaneAircraftIdentity | null;
  private readonly aircraftIdentityRecheckMs: number;

  private socket: DgramSocketLike | null = null;
  private isConnected = false;
  private indexToTarget = new Map<number, XPlaneSubscriptionTarget>();
  private readonly values = new Map<string, XPlaneRawValue>();
  private lastEmitMs = 0;
  private pausedLogged = false;
  private subscriptionDiagnostics: SimSourceDiagnostics | null = null;
  private aircraftIdentity: XPlaneAircraftIdentity | null = null;
  private aircraftIdentityCheckedAtMs = 0;
  private aircraftIdentityLogged = false;

  constructor(options: XPlaneRrefSimSourceOptions = {}) {
    super();
    this.host = options.host ?? XP_RREF_DEFAULT_HOST;
    this.port = options.port ?? readXPlaneRrefPort();
    this.socketFactory = options.socketFactory ?? defaultDgramSocketFactory;
    this.logger = options.logger;
    this.maxSampleHz = options.maxSampleHz ?? XP_DEFAULT_MAX_SAMPLE_HZ;
    this.connectTimeoutMs = options.connectTimeoutMs ?? XP_CONNECT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.resolveAircraftIdentity = options.aircraftIdentity ?? resolveXPlaneAircraftIdentity;
    this.aircraftIdentityRecheckMs =
      options.aircraftIdentityRecheckMs ?? XPLANE_AIRCRAFT_IDENTITY_RECHECK_MS;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get capabilities(): SimSourceCapabilities {
    return {
      sim: this.id,
      maxSampleHz: this.maxSampleHz,
      pauseDetection: 'direct',
      adapter: 'xp-udp-rref',
    };
  }

  diagnostics(): SimSourceDiagnostics | null {
    return this.subscriptionDiagnostics;
  }

  async connect(): Promise<SimSourceOpenInfo> {
    const targets = planRrefSubscriptions();
    this.indexToTarget = new Map(targets.map((target, index) => [index, target]));

    const socket = this.socketFactory();
    const first = this.waitForFirstDatagram(socket);

    this.logger?.info(
      `X-Plane RREF: subscribing to ${targets.length} dataref slot(s); ` +
        `float32 precision ~${RREF_POSITION_TOLERANCE_M} m on position`,
      { transport: 'xp-udp-rref', slots: targets.length, port: this.port },
    );

    const frequency = Math.max(1, this.maxSampleHz);
    let index = 0;
    for (const target of targets) {
      this.sendSubscription(socket, target, frequency, index);
      index += 1;
    }

    try {
      await first;
    } catch (error) {
      this.closeSocket(socket);
      throw error;
    }

    this.socket = socket;
    this.isConnected = true;
    this.aircraftIdentity = this.tryResolveAircraftIdentity();
    this.aircraftIdentityCheckedAtMs = this.now();
    this.logAircraftIdentity();
    const planned = [...new Set(targets.map((target) => target.dataref))];
    this.subscriptionDiagnostics = describeXPlaneSubscription({
      transport: 'xp-udp-rref',
      // RREF не имеет API «present»: presence подтверждает probe; подписка слепая.
      resolved: planned,
      missing: [],
      required: XPLANE_REQUIRED_DATAREFS,
      coreRequired: XPLANE_CORE_REQUIRED_DATAREFS,
      unsupported: XPLANE_NO_EQUIVALENT_FIELDS,
    });
    this.logger?.info(this.subscriptionDiagnostics.message, this.subscriptionDiagnostics.meta);

    const info: SimSourceOpenInfo = {
      applicationName: 'X-Plane 12',
      applicationVersion: 'unknown',
      simConnectVersion: 'n/a',
      sim: this.id,
      simVersion: null,
      adapter: 'xp-udp-rref',
      protocol: 'rref',
    };
    this.emit('open', info);
    return info;
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (socket) {
      for (const [index, target] of this.indexToTarget) {
        const name = elementName(target);
        try {
          socket.send(encodeRrefRequest(name, 0, index), this.port, this.host);
        } catch {
          // Отписка best-effort: закрытие сокета всё равно прекращает поток.
        }
      }
    }
    this.markDisconnected('client requested disconnect');
  }

  private waitForFirstDatagram(socket: DgramSocketLike): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new XPlaneRrefUnavailableError('timeout', 'X-Plane RREF: no datagram received'));
      }, this.connectTimeoutMs);

      socket.on('error', (error) => {
        this.emit('error', error);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new XPlaneRrefUnavailableError('error', `X-Plane RREF socket error: ${error.message}`));
      });
      socket.on('message', (message) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
        this.handleDatagram(message);
      });
    });
  }

  private sendSubscription(
    socket: DgramSocketLike,
    target: XPlaneSubscriptionTarget,
    frequency: number,
    index: number,
  ): void {
    try {
      socket.send(
        encodeRrefRequest(elementName(target), frequency, index),
        this.port,
        this.host,
        (error) => {
          if (error) this.emit('error', error);
        },
      );
    } catch (error) {
      this.emit('error', toError(error));
    }
  }

  private handleDatagram(message: Buffer): void {
    if (!isRrefResponse(message)) return;
    for (const [index, value] of decodeRrefValues(message)) {
      const target = this.indexToTarget.get(index);
      if (!target) continue;
      setXPlaneValue(this.values, target, value);
    }
    this.emitSampleIfReady();
  }

  private emitSampleIfReady(): void {
    if (!this.isConnected) return;
    const now = this.now();
    if (this.maxSampleHz > 0 && now - this.lastEmitMs < 1000 / this.maxSampleHz) return;
    if (readXPlaneBool(this.values, 'paused') === true) {
      if (!this.pausedLogged) {
        this.pausedLogged = true;
        this.logger?.info('X-Plane sim paused; sample stream suppressed', {
          transport: 'xp-udp-rref',
        });
      }
      return;
    }
    this.lastEmitMs = now;
    if (readXPlaneBool(this.values, 'onground_any') === true) {
      this.maybeRefreshAircraftIdentity(now);
    }
    const sample = buildXPlaneSample(this.values, new Date(now).toISOString());
    this.emit('sample', this.withAircraftIdentity(sample));
  }

  private maybeRefreshAircraftIdentity(now: number): void {
    if (now - this.aircraftIdentityCheckedAtMs < this.aircraftIdentityRecheckMs) return;
    this.aircraftIdentityCheckedAtMs = now;
    this.aircraftIdentity = this.tryResolveAircraftIdentity();
    this.logAircraftIdentity();
  }

  private tryResolveAircraftIdentity(): XPlaneAircraftIdentity | null {
    try {
      return this.resolveAircraftIdentity();
    } catch {
      return null;
    }
  }

  private withAircraftIdentity(sample: TelemetrySample): TelemetrySample {
    const identity = this.aircraftIdentity;
    if (!identity) return sample;
    return {
      ...sample,
      atc_model: identity.icao,
      title: identity.title,
      aircraft_icao_source: 'xplane_acf',
    };
  }

  private logAircraftIdentity(): void {
    if (!this.aircraftIdentity || this.aircraftIdentityLogged) return;
    this.aircraftIdentityLogged = true;
    this.logger?.info('X-Plane aircraft identity resolved from .acf', {
      transport: 'xp-udp-rref',
      aircraft_icao_source: 'xplane_acf',
      icao: this.aircraftIdentity.icao,
    });
  }

  private markDisconnected(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) this.closeSocket(socket);
    if (!this.isConnected) return;
    this.isConnected = false;
    this.emit('disconnect', reason);
  }

  private closeSocket(socket: DgramSocketLike): void {
    try {
      socket.removeAllListeners?.();
      socket.close();
    } catch {
      // ignore
    }
  }
}

function elementName(target: XPlaneSubscriptionTarget): string {
  return target.element === null ? target.dataref : `${target.dataref}[${target.element}]`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
