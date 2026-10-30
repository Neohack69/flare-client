import type { RuntimeRecorder } from '../cli/runtime.js';
import type { Logger } from '../cli/logger.js';
import type { FlightRecorderEvents } from '../flight/recorder.js';
import type { SimConnectOpenInfo } from './types.js';
import type { SimSource, SimSourceId, SimSourceOpenInfo, SimSourcePreference } from './source.js';
import { SIM_SOURCE_ENV } from './source.js';
import {
  createSimSource,
  discoverSimSourceId,
  probeSimSourceId,
  type SimSourceCreateContext,
} from './registry.js';

/**
 * Re-discovery источника телеметрии (SIM-REDISCOVER-1).
 *
 * `auto`-дискавери раньше выполнялся ровно один раз при bootstrap: если сим
 * запускали позже (или выбранный сим падал), агент вечно ретраил мёртвый
 * источник. Сессия владеет текущим `SimSource` + `FlightRecorder` и умеет
 * переизбрать источник по запросу рантайма, сохраняя инвариант «один рекордер —
 * один сим» (ADR-0023): перед переключением текущий рекордер останавливается
 * по существующим правилам (активный рейс финализируется/отбрасывается).
 *
 * Явный `AGENT_SIM_SOURCE` — аварийный клапан: источник запинен, авто-свитча нет.
 */

/** Частота проб: не чаще одного re-discovery в 30 с (без busy loop). */
export const DEFAULT_REDISCOVERY_COOLDOWN_MS = 30_000;

export type SimRediscoveryReason = 'connect_failures' | 'disconnect' | 'manual';

export type SimRediscoveryStatus = 'switched' | 'unchanged' | 'pinned' | 'cooldown' | 'unavailable';

export interface SimRediscoveryOutcome {
  status: SimRediscoveryStatus;
  from: SimSourceId;
  to: SimSourceId | null;
  reason: SimRediscoveryReason;
  attempted: SimSourceId[];
  /** Сколько мс осталось до следующей разрешённой пробы (для cooldown). */
  nextProbeInMs: number;
}

/** Снимок для статус-канала (аддитивные поля `AgentStatusEvent`). */
export interface SimSessionSnapshot {
  sourceId: SimSourceId;
  connected: boolean;
  pinned: boolean;
  preference: SimSourcePreference;
  lastSampleAt: string | null;
  info: SimSourceOpenInfo | null;
}

/** Поверхность сессии, нужная рантайму для re-discovery и статуса. */
export interface SimSessionDiscovery {
  rediscover(reason: SimRediscoveryReason): Promise<SimRediscoveryOutcome>;
  snapshot(): SimSessionSnapshot;
}

export interface SimSessionOptions {
  /** Разрешённое предпочтение (`auto` — можно переключать). */
  preference: SimSourcePreference;
  initialSource: SimSource;
  initialRecorder: RuntimeRecorder;
  createSource?(id: SimSourceId): SimSource;
  createRecorder(source: SimSource): RuntimeRecorder;
  logger?: Logger;
  /** Пробы источников (тесты); по умолчанию — зарегистрированные фабрики. */
  probe?(id: SimSourceId): Promise<boolean>;
  /** Доступные источники (тесты); по умолчанию — все зарегистрированные. */
  available?: readonly SimSourceId[];
  context?: SimSourceCreateContext;
  cooldownMs?: number;
  now?(): number;
}

type Handler = (...args: unknown[]) => void;
type Proxy = (...args: unknown[]) => void;

/**
 * Владелец текущего источника и рекордера. Реализует `RuntimeSimAdapter`
 * (`connected`) и `RuntimeRecorder`, поэтому рантайм не знает о подмене
 * источника: подписки на события рекордера переживают switch (перевешиваются).
 */
export class SimSession implements SimSessionDiscovery {
  private source: SimSource;
  private recorder: RuntimeRecorder;
  private readonly preference: SimSourcePreference;
  private readonly pinned: boolean;
  private readonly createSourceImpl: (id: SimSourceId) => SimSource;
  private readonly createRecorderImpl: (source: SimSource) => RuntimeRecorder;
  private readonly logger: Logger | undefined;
  private readonly probe: (id: SimSourceId) => Promise<boolean>;
  private readonly available: readonly SimSourceId[] | undefined;
  private readonly context: SimSourceCreateContext;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private readonly handlers = new Map<keyof FlightRecorderEvents, Set<Handler>>();
  private readonly proxies = new Map<keyof FlightRecorderEvents, Proxy>();
  private lastProbeAt = Number.NEGATIVE_INFINITY;
  private lastSampleAt: string | null = null;
  private info: SimSourceOpenInfo | null = null;

  constructor(options: SimSessionOptions) {
    this.source = options.initialSource;
    this.recorder = options.initialRecorder;
    this.preference = options.preference;
    this.pinned = options.preference !== 'auto';
    this.createSourceImpl =
      options.createSource ?? ((id: SimSourceId) => createSimSource(id, this.context));
    this.createRecorderImpl = options.createRecorder;
    this.logger = options.logger;
    this.available = options.available;
    this.context = options.context ?? {};
    this.cooldownMs = options.cooldownMs ?? DEFAULT_REDISCOVERY_COOLDOWN_MS;
    this.now = options.now ?? (() => Date.now());
    this.probe = options.probe ?? ((id: SimSourceId) => probeSimSourceId(id, this.context));
    this.attachSource();
  }

  get id(): SimSourceId {
    return this.source.id;
  }

  get connected(): boolean {
    return this.source.connected;
  }

  get state() {
    return this.recorder.state;
  }

  async start(): Promise<SimConnectOpenInfo> {
    const info = await this.recorder.start();
    this.info = isSimSourceOpenInfo(info) ? info : null;
    return info;
  }

  async stop(): Promise<void> {
    this.detachSource();
    await this.recorder.stop();
  }

  on<K extends keyof FlightRecorderEvents>(event: K, handler: FlightRecorderEvents[K]): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
      recorderOn(this.recorder, event, this.proxyFor(event));
    }
    set.add(handler as unknown as Handler);
  }

  off<K extends keyof FlightRecorderEvents>(event: K, handler: FlightRecorderEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    set.delete(handler as unknown as Handler);
    if (set.size === 0) {
      this.handlers.delete(event);
      this.detachRecorderEvent(event);
    }
  }

  snapshot(): SimSessionSnapshot {
    return {
      sourceId: this.source.id,
      connected: this.source.connected,
      pinned: this.pinned,
      preference: this.preference,
      lastSampleAt: this.lastSampleAt,
      info: this.info,
    };
  }

  /**
   * Переизбирает источник. Возвращает решение (для логов/статуса), никогда не
   * бросает: ошибка дискавери/создания источника трактуется как «недоступен».
   */
  async rediscover(reason: SimRediscoveryReason): Promise<SimRediscoveryOutcome> {
    const from = this.source.id;
    const base: SimRediscoveryOutcome = {
      status: 'unchanged',
      from,
      to: from,
      reason,
      attempted: [],
      nextProbeInMs: 0,
    };

    if (this.pinned) {
      this.logger?.info(`simulator discovery: not switching (${SIM_SOURCE_ENV} pins the source)`, {
        source_env: SIM_SOURCE_ENV,
        pinned: from,
        reason,
      });
      return { ...base, status: 'pinned' };
    }

    const elapsed = this.now() - this.lastProbeAt;
    if (elapsed < this.cooldownMs) {
      const nextProbeInMs = Math.max(0, this.cooldownMs - elapsed);
      this.logger?.debug('simulator discovery: cooldown active; skipping probe', {
        current: from,
        reason,
        next_probe_in_ms: nextProbeInMs,
      });
      return { ...base, status: 'cooldown', nextProbeInMs };
    }
    this.lastProbeAt = this.now();

    const attempted: SimSourceId[] = [];
    const probed = new Map<SimSourceId, boolean>();
    const probe = async (id: SimSourceId): Promise<boolean> => {
      if (probed.has(id)) return probed.get(id) === true;
      attempted.push(id);
      const result = await this.safeProbe(id);
      probed.set(id, result);
      return result;
    };

    let chosen: SimSourceId;
    try {
      chosen = await discoverSimSourceId({
        available: this.available,
        context: this.context,
        logger: this.logger,
        probe,
      });
    } catch (error) {
      this.logger?.warn('simulator discovery failed; keeping the current source', {
        current: from,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ...base, status: 'unavailable', attempted };
    }

    this.logger?.info('simulator discovery: sources probed', {
      current: from,
      chosen,
      attempted,
      reason,
    });

    if (chosen === from) {
      this.logger?.info('simulator discovery: keeping the current source', {
        current: from,
        chosen,
        reason,
      });
      return { ...base, status: 'unchanged', attempted };
    }

    const chosenAvailable = probed.has(chosen) ? probed.get(chosen) === true : await probe(chosen);
    if (!chosenAvailable) {
      this.logger?.info(
        'simulator discovery: chosen source is not available; keeping the current source',
        { current: from, chosen, attempted, reason },
      );
      return { ...base, status: 'unavailable', attempted };
    }

    try {
      await this.switchTo(chosen, reason, attempted);
    } catch (error) {
      this.logger?.warn('simulator discovery: source switch failed; keeping the current source', {
        current: this.source.id,
        chosen,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ...base, status: 'unavailable', attempted };
    }

    this.logger?.info('simulator discovery: switched source', {
      from,
      to: chosen,
      reason,
      attempted,
    });
    return { ...base, status: 'switched', to: chosen, attempted };
  }

  private async safeProbe(id: SimSourceId): Promise<boolean> {
    try {
      return await this.probe(id);
    } catch {
      return false;
    }
  }

  private async switchTo(
    id: SimSourceId,
    reason: SimRediscoveryReason,
    attempted: readonly SimSourceId[],
  ): Promise<void> {
    const from = this.source.id;
    this.logger?.info('simulator discovery: switching source', {
      from,
      to: id,
      reason,
      attempted,
    });

    // Существующее правило: останавливаем текущий рекордер ДО подмены. Если
    // запись активна, `FlightRecorder.stop()` финализирует её (`agent_stop`);
    // после disconnect она уже завершена как `sim_disconnected` — данные не теряются.
    try {
      await this.recorder.stop();
    } catch (error) {
      this.logger?.warn('simulator discovery: previous recorder stop failed', {
        from,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.detachRecorderHandlers();
    this.detachSource();

    this.source = this.createSourceImpl(id);
    this.recorder = this.createRecorderImpl(this.source);
    this.info = null;
    this.lastSampleAt = null;
    this.attachSource();
    this.attachRecorderHandlers();
  }

  private attachSource(): void {
    this.source.off('sample', this.onSample);
    this.source.on('sample', this.onSample);
  }

  private detachSource(): void {
    this.source.off('sample', this.onSample);
  }

  private readonly onSample = (sample: { ts: string }): void => {
    this.lastSampleAt = sample.ts;
  };

  private attachRecorderHandlers(): void {
    for (const event of this.handlers.keys()) this.attachRecorderEvent(event);
  }

  private attachRecorderEvent(event: keyof FlightRecorderEvents): void {
    recorderOn(this.recorder, event, this.proxyFor(event));
  }

  private detachRecorderEvent(event: keyof FlightRecorderEvents): void {
    recorderOff(this.recorder, event, this.proxyFor(event));
  }

  private detachRecorderHandlers(): void {
    for (const event of this.handlers.keys()) this.detachRecorderEvent(event);
  }

  /**
   * Один прокси на тип события: подписка, живущая между рекордерами. `on`/`off`
   * у `RuntimeRecorder` типизированы generics-ом, поэтому точечный cast.
   */
  private proxyFor(event: keyof FlightRecorderEvents): Proxy {
    let proxy = this.proxies.get(event);
    if (!proxy) {
      proxy = (...args: unknown[]): void => {
        for (const handler of this.handlers.get(event) ?? []) handler(...args);
      };
      this.proxies.set(event, proxy);
    }
    return proxy;
  }
}

function isSimSourceOpenInfo(info: SimConnectOpenInfo): info is SimSourceOpenInfo {
  return typeof (info as { sim?: unknown }).sim === 'string';
}

type RecorderHook = (
  event: keyof FlightRecorderEvents,
  handler: (...args: unknown[]) => void,
) => void;

function recorderOn(
  recorder: RuntimeRecorder,
  event: keyof FlightRecorderEvents,
  handler: Proxy,
): void {
  (recorder.on as unknown as RecorderHook)(event, handler);
}

function recorderOff(
  recorder: RuntimeRecorder,
  event: keyof FlightRecorderEvents,
  handler: Proxy,
): void {
  (recorder.off as unknown as RecorderHook)(event, handler);
}
