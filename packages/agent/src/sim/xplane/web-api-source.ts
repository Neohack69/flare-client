/**
 * X-Plane 12 Web API источник (`XPlaneWebApiSimSource`, ADR-0023 §2.3).
 *
 * Поток: `GET /api/capabilities` → резолв dataref-id по имени (allow-list) →
 * WebSocket `dataref_subscribe_values` → `dataref_update_values` → сборка кадра →
 * тот же `TelemetrySample`, что потребляет рекордер.
 *
 * Read-only (ADR-0023 §2.4): GET-only REST + WS subscribe/unsubscribe; никаких
 * write-глаголов; dataref только из allow-list; строго loopback.
 *
 * Точность: Web API отдаёт JSON-числа полной точности (в т.ч. `double`), поэтому
 * позиция (`lat`/`lon`/`elevation`) — без потери float32 (в отличие от RREF).
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
import { TypedEmitter } from '../../util/emitter.js';
import {
  XPLANE_CORE_REQUIRED_DATAREFS,
  XPLANE_NO_EQUIVALENT_FIELDS,
  XPLANE_REQUIRED_DATAREFS,
  planWebApiSubscriptions,
  type XPlaneSubscriptionTarget,
} from './datarefs.js';
import {
  describeXPlaneSubscription,
  describeMissingXPlaneDatarefs,
} from './diagnostics.js';
import { XPlaneRestClient, XPlaneWebApiError } from './http.js';
import { XP_CONNECT_TIMEOUT_MS, XP_DEFAULT_MAX_SAMPLE_HZ, toXPlaneWebSocketUrl } from './config.js';
import { buildSubscribeMessage, buildUnsubscribeMessage, parseUpdateMessage } from './messages.js';
import {
  buildXPlaneSample,
  readXPlaneBool,
  setXPlaneValue,
  type XPlaneRawValue,
} from './values.js';

/** Минимальная форма WebSocket-клиента (тестируется без сети). */
export interface XPlaneSocket {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export type XPlaneSocketFactory = (url: string) => XPlaneSocket;

/** Адаптер глобального `WebSocket` (Node 22+) к `XPlaneSocket`. */
export function defaultXPlaneSocketFactory(url: string): XPlaneSocket {
  const socket = new WebSocket(url);
  const wrapper: XPlaneSocket = {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  socket.onopen = (event) => wrapper.onopen?.(event);
  socket.onmessage = (event) => wrapper.onmessage?.({ data: event.data });
  socket.onerror = (event) => wrapper.onerror?.(event);
  socket.onclose = (event) => wrapper.onclose?.(event);
  return wrapper;
}

export interface XPlaneWebApiSimSourceOptions {
  /** Base URL web-сервера (строго loopback); по умолчанию `AGENT_XP_WEB_URL`. */
  baseUrl?: string;
  maxSampleHz?: number;
  logger?: SimConnectAdapterLogger;
  /** Инъекция REST-клиента (тесты). */
  rest?: XPlaneRestClient;
  /** Инъекция WebSocket-фабрики (тесты). */
  socketFactory?: XPlaneSocketFactory;
  connectTimeoutMs?: number;
  now?: () => number;
  requestId?: () => number;
}

/** Read-only источник X-Plane 12 поверх встроенного Web API. */
export class XPlaneWebApiSimSource extends TypedEmitter<SimSourceEvents> implements SimSource {
  readonly id: SimSourceId = 'xplane12';
  readonly readOnly = true;

  private readonly rest: XPlaneRestClient;
  private readonly socketFactory: XPlaneSocketFactory;
  private readonly logger: SimConnectAdapterLogger | undefined;
  private readonly maxSampleHz: number;
  private readonly connectTimeoutMs: number;
  private readonly now: () => number;
  private readonly nextRequestId: () => number;

  private socket: XPlaneSocket | null = null;
  private isConnected = false;
  private simVersion: string | null = null;
  private idToTarget = new Map<number, XPlaneSubscriptionTarget>();
  private readonly values = new Map<string, XPlaneRawValue>();
  private resolved: readonly string[] = [];
  private missing: readonly string[] = [];
  private lastEmitMs = 0;
  private pausedLogged = false;
  private subscriptionDiagnostics: SimSourceDiagnostics | null = null;

  constructor(options: XPlaneWebApiSimSourceOptions = {}) {
    super();
    this.rest = options.rest ?? new XPlaneRestClient({ baseUrl: options.baseUrl });
    this.socketFactory = options.socketFactory ?? defaultXPlaneSocketFactory;
    this.logger = options.logger;
    this.maxSampleHz = options.maxSampleHz ?? XP_DEFAULT_MAX_SAMPLE_HZ;
    this.connectTimeoutMs = options.connectTimeoutMs ?? XP_CONNECT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    let requestId = 0;
    this.nextRequestId =
      options.requestId ??
      (() => {
        requestId += 1;
        return requestId;
      });
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get capabilities(): SimSourceCapabilities {
    return {
      sim: this.id,
      maxSampleHz: this.maxSampleHz,
      // XP отдаёт прямой `sim/time/paused` (ADR-0023 §2/R6) — точнее MSFS.
      pauseDetection: 'direct',
      adapter: 'xp-web-api-v1',
    };
  }

  diagnostics(): SimSourceDiagnostics | null {
    return this.subscriptionDiagnostics;
  }

  async connect(): Promise<SimSourceOpenInfo> {
    const capabilities = await this.rest.getCapabilities();
    this.simVersion = capabilities.simVersion;

    const targets = planWebApiSubscriptions();
    const idToTarget = new Map<number, XPlaneSubscriptionTarget>();
    const resolved: string[] = [];
    const missing: string[] = [];
    for (const target of targets) {
      const info = await this.rest.findDataref(target.dataref);
      if (info) {
        idToTarget.set(info.id, target);
        resolved.push(target.dataref);
      } else {
        missing.push(target.dataref);
      }
    }

    const socket = this.socketFactory(toXPlaneWebSocketUrl(this.rest.baseUrl));
    try {
      await this.openSocket(socket);
    } catch (error) {
      closeQuietly(socket);
      throw error;
    }

    this.socket = socket;
    this.idToTarget = idToTarget;
    this.resolved = resolved;
    this.missing = missing;
    this.subscriptionDiagnostics = describeXPlaneSubscription({
      transport: 'xp-web-api-v1',
      resolved,
      missing,
      required: XPLANE_REQUIRED_DATAREFS,
      coreRequired: XPLANE_CORE_REQUIRED_DATAREFS,
      unsupported: XPLANE_NO_EQUIVALENT_FIELDS,
    });
    this.logger?.info(this.subscriptionDiagnostics.message, this.subscriptionDiagnostics.meta);
    if (missing.length > 0) {
      this.logger?.warn(describeMissingXPlaneDatarefs(missing), {
        transport: 'xp-web-api-v1',
        unavailable: missing.length,
      });
    }

    this.subscribe(socket, [...idToTarget.keys()]);
    this.isConnected = true;

    const info: SimSourceOpenInfo = {
      applicationName: 'X-Plane 12',
      applicationVersion: this.simVersion ?? 'unknown',
      simConnectVersion: 'n/a',
      sim: this.id,
      simVersion: this.simVersion,
      adapter: 'xp-web-api-v1',
      protocol: 'websocket',
    };
    this.emit('open', info);
    return info;
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (socket) {
      try {
        socket.send(buildUnsubscribeMessage(this.nextRequestId(), [...this.idToTarget.keys()]));
      } catch {
        // Отписка best-effort: закрытие сокета всё равно прекращает поток.
      }
    }
    this.markDisconnected('client requested disconnect');
  }

  private subscribe(socket: XPlaneSocket, ids: readonly number[]): void {
    if (ids.length === 0) return;
    try {
      socket.send(buildSubscribeMessage(this.nextRequestId(), ids));
    } catch (error) {
      this.emit('error', toError(error));
    }
  }

  private openSocket(socket: XPlaneSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let opened = false;
      let closed = false;
      const timer = setTimeout(() => {
        if (opened || closed) return;
        closed = true;
        reject(new XPlaneWebApiError('timeout', 'X-Plane WebSocket did not open in time'));
      }, this.connectTimeoutMs);

      socket.onopen = () => {
        if (opened || closed) return;
        opened = true;
        clearTimeout(timer);
        socket.onmessage = (event) => this.handleMessage(event.data);
        socket.onerror = () => this.markDisconnected('websocket error');
        socket.onclose = () => this.markDisconnected('websocket closed');
        resolve();
      };
      socket.onerror = () => {
        if (opened || closed) return;
        closed = true;
        clearTimeout(timer);
        reject(new XPlaneWebApiError('unreachable', 'X-Plane WebSocket error before open'));
      };
      socket.onclose = () => {
        if (opened || closed) return;
        closed = true;
        clearTimeout(timer);
        reject(new XPlaneWebApiError('unreachable', 'X-Plane WebSocket closed before open'));
      };
    });
  }

  private handleMessage(data: unknown): void {
    const payload = decodeWsPayload(data);
    if (payload === null) return;
    const updates = parseUpdateMessage(payload);
    if (updates === null) return;
    for (const update of updates) {
      const target = this.idToTarget.get(update.id);
      if (!target) continue;
      setXPlaneValue(this.values, target, update.value);
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
          transport: 'xp-web-api-v1',
        });
      }
      return;
    }
    this.lastEmitMs = now;
    this.emit('sample', buildXPlaneSample(this.values, new Date(now).toISOString()));
  }

  private markDisconnected(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      closeQuietly(socket);
    }
    if (!this.isConnected) return;
    this.isConnected = false;
    this.emit('disconnect', reason);
  }

  /** Число зарезолвленных/отсутствующих dataref (диагностика; только allow-list). */
  get subscriptionSummary(): { resolved: number; missing: number } {
    return { resolved: this.resolved.length, missing: this.missing.length };
  }
}

function decodeWsPayload(data: unknown): unknown {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (data instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(data));
    } catch {
      return null;
    }
  }
  return null;
}

function closeQuietly(socket: XPlaneSocket): void {
  try {
    socket.close();
  } catch {
    // ignore
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
