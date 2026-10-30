import {
  QUALITY_BITS,
  type FlightEvent,
  type FlightEventType,
  type LandingMetricsResponse,
  type LandingScore,
  type SimRunway,
  type TouchdownPoint,
} from '@flightlog/contracts';
import { assessTouchdownWindow } from '@flightlog/scoring';

import type { OutboxBuffer } from '../buffer/types.js';
import { AdaptiveSampler, type AdaptiveSamplerOptions } from '../flight/adaptive-sampler.js';
import { FlightAnalysis } from '../flight/analysis.js';
import { toFlightEvent, toTrackPoint } from '../flight/build.js';
import {
  AIRCRAFT_DB_VERSION,
  resolveAircraftIcao,
  selectAircraftModelRaw,
  type AircraftIcaoSource,
} from '../flight/aircraft-icao.js';
import type { IcaoTypeDesignatorLookup } from '../flight/aircraft-config.js';
import {
  FlightPhaseDetector,
  type FlightPhase,
  type PhaseDetectorOptions,
} from '../flight/phases.js';
import {
  LandingTracker,
  type LandingPreview,
  type TouchdownEvent,
  type LandingTrackerOptions,
} from '../flight/touchdown.js';
import { hasSampleFlightEvidence } from '../flight/liftoff.js';
import {
  detectTeleport,
  TELEPORT_JUMP_LIMITS,
  type TeleportDetection,
} from './teleport.js';
import { atcRunwayMissingReason, buildAtcSimRunway } from '../sim/atc-runway.js';
import { checkSampleSanity, type TelemetrySanityReason } from '../sim/sanity.js';
import type { SimSource, SimSourceId } from '../sim/source.js';
import {
  findNearestAirportIcao,
  prewarmAirportIndex,
  prewarmAirportRunways,
  resolveCachedSimRunway,
  resolveSimRunway,
  type SimTouchdownPoint,
} from '../sim/xplane/apt-dat.js';
import type { SimConnectAdapter, SimConnectOpenInfo, TelemetrySample } from '../sim/types.js';
import { systemClock, type Clock } from '../util/clock.js';
import { TypedEmitter } from '../util/emitter.js';
import { uuidGenerator, type IdGenerator } from '../util/id.js';

export interface FlightRecorderOptions {
  /** Канонический read-only источник телеметрии (ADR-0023; предпочтительно). */
  source?: SimSource;
  /** @deprecated Используйте `source`. Алиас сохранён на один релиз. */
  adapter?: SimConnectAdapter;
  buffer: OutboxBuffer;
  clock?: Clock;
  idGenerator?: IdGenerator;
  /** Явное переопределение ICAO; иначе выводится из `ATC TYPE`/`ATC MODEL`. */
  aircraftIcao?: string;
  /**
   * Робастный резолвер `icao_type_designator` из `aircraft.cfg` (T-ICAO-BCS3).
   * В production задаётся `bootstrapAgent`; в тестах не задаётся (чистый резолв).
   */
  aircraftIcaoLookup?: IcaoTypeDesignatorLookup;
  callsign?: string | null;
  deviceId?: string | null;
  originIcao?: string | null;
  destinationIcao?: string | null;
  phase?: Partial<PhaseDetectorOptions>;
  sampler?: Partial<AdaptiveSamplerOptions>;
  touchdown?: Partial<LandingTrackerOptions>;
  /** Секунд на земле с выключенным двигателем до завершения рейса. */
  endEngineOffS?: number;
  /** Секунд неподвижности на земле до завершения рейса, если касаний ещё не было. */
  endStationaryS?: number;
  /**
   * Секунд неподвижности на земле до завершения рейса, если в сессии уже были
   * касания (ADR-0010 §2): руление/ожидание между кругами не режет сессию.
   */
  patternStationaryS?: number;
  /** Нет сэмплов дольше этого времени → локально `completed`; `is_partial=true`, если посадка не подтверждена. */
  endNoDataS?: number;
  /** Период watchdog-проверки `no_data` (мс). */
  watchdogIntervalMs?: number;
  /** Автозапуск watchdog через `setInterval` (в тестах можно отключить и звать `tick()`). */
  autoWatchdog?: boolean;
  /** Скорость ниже которой ВС считается остановившимся (kt). */
  stopSpeedKt?: number;
  /** Скорость/движение, при которых начинается запись нового рейса (kt). */
  startSpeedKt?: number;
  /** Порог частоты окна касания, ниже которого рейс не допускается в лидерборд (Гц). */
  minLeaderboardHz?: number;
  /**
   * Сколько **подряд** правдоподобных кадров нужно после мусорных кадров
   * (меню/загрузка), чтобы разрешить старт рейса. Чистый старт (без мусора)
   * окно не ждёт — валидный рейс не задерживается.
   */
  settleFrames?: number;
  /**
   * Карантин после (ре)коннекта/загрузки сима (с): первые кадры SimConnect
   * нестабильны. Пока карантин не истёк и состояние не устоялось
   * (2 подряд кадра с одинаковым `on_ground`/высотой), рейс не стартует.
   * `0` отключает карантин (тесты/совместимость).
   */
  loadQuarantineS?: number;
  /**
   * Rate-limited колбэк о пропущенных мусорных кадрах. Используется host'ом для
   * логирования (`logger.warn`); по умолчанию no-op.
   */
  warn?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface FlightStartedInfo {
  client_flight_id: string;
  started_at: string;
  aircraft_icao: string;
  aircraft_icao_source: AircraftIcaoSource;
}

export interface FlightEndedInfo {
  client_flight_id: string;
  started_at: string;
  ended_at: string;
  reason: string;
  point_count: number;
  event_count: number;
  bounce_count: number;
  /** Число посадок сессии (ADR-0010); 0 — касаний не было. */
  landings_count: number;
  /** Число посадок, помеченных touch-and-go. */
  touch_and_go_count: number;
  /** Посадки сессии в порядке `seq` (предпросмотр; авторитет — сервер). */
  landings: LandingPreview[];
  score_preview: LandingScore | null;
  metrics: LandingMetricsResponse | null;
  is_partial: boolean;
  leaderboard_eligible: boolean;
  quality_flags: number;
  paused_total_s: number;
  confidence: number;
  /**
   * Сессия отброшена: не было подтверждённого отрыва, это не рейс. Событие
   * `landing` не эмитилось; серверный `/complete` удаляет такой рейс.
   */
  discarded: boolean;
  /** Причина отбрасывания (P2): только `no_flight_evidence` (стоянка/руление). */
  discard_reason: 'no_flight_evidence' | null;
}

export interface RecorderState {
  phase: FlightPhase;
  recording: boolean;
  client_flight_id: string | null;
  seq: number;
  point_count: number;
  event_count: number;
  bounce_count: number;
  /** Число подтверждённых касаний (посадок) в текущей сессии. */
  landing_count: number;
  /** Число touch-and-go среди посадок сессии. */
  touch_and_go_count: number;
  /** Текущее состояние ВС: на земле или в воздухе. */
  on_ground: boolean;
  rate_hz: number;
  score_preview: LandingScore | null;
  metrics: LandingMetricsResponse | null;
}

export interface FlightRecorderEvents {
  flight_started: (info: FlightStartedInfo) => void;
  flight_ended: (info: FlightEndedInfo) => void;
  event: (event: FlightEvent) => void;
  score: (result: TouchdownEvent) => void;
  disconnect: (reason?: string) => void;
  error: (error: Error) => void;
}

const DEFAULTS = {
  endEngineOffS: 30,
  endStationaryS: 300,
  patternStationaryS: 600,
  endNoDataS: 120,
  watchdogIntervalMs: 1000,
  stopSpeedKt: 1,
  startSpeedKt: 3,
  minLeaderboardHz: 5,
  settleFrames: 3,
  loadQuarantineS: 4,
  aircraftIcao: null as string | null,
  callsign: null as string | null,
  deviceId: null as string | null,
  originIcao: null as string | null,
  destinationIcao: null as string | null,
};

/**
 * AGL (ft), ещё совместимый с положением «на земле». Первые кадры SimConnect
 * могут ложно сообщать большой `agl` при `on_ground=true` — такой кадр не
 * считается устоявшимся и рейс по нему не стартует.
 */
const MAX_GROUND_AGL_FT = 100;

/**
 * Минимальный интервал между сообщениями о пропущенных мусорных кадрах (мс).
 * В меню/на загрузке кадры идут потоком — логируем не чаще, чем раз в интервал
 * (первое сообщение — сразу), с накопленным счётчиком.
 */
const IMPLAUSIBLE_LOG_INTERVAL_MS = 30_000;

/** 1 lb = 0.45359237 кг (точно, SI). */
const LB_TO_KG = 0.45359237;

/**
 * WAVE 3b: перевод `TOTAL WEIGHT` (фунты) в целые кг. Некорректное/отсутствующее
 * значение (`null`/NaN/≤0) → `null` (absent), без подмены нулём.
 */
function poundsToKg(pounds: number | null | undefined): number | null {
  if (typeof pounds !== 'number' || !Number.isFinite(pounds) || pounds <= 0) return null;
  return Math.round(pounds * LB_TO_KG);
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Оркестратор записи рейса (T8/T9/T33): связывает read-only адаптер SimConnect,
 * state machine фаз, адаптивный сэмплер, детект касания, watchdog и durable-буфер.
 * Сеть/device flow намеренно отсутствуют в рекордере (см. `sync/`).
 */
export class FlightRecorder extends TypedEmitter<FlightRecorderEvents> {
  private readonly adapter: SimConnectAdapter;
  /** Метка источника (`xplane12` → допуск отрицательной IAS «без потока»). */
  private readonly simSourceId: SimSourceId | null;
  private readonly buffer: OutboxBuffer;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly configuredAircraftIcao: string | null;
  private readonly aircraftIcaoLookup: IcaoTypeDesignatorLookup | null;
  private readonly callsign: string | null;
  private readonly deviceId: string | null;
  private readonly originIcao: string | null;
  private readonly destinationIcao: string | null;
  private readonly endEngineOffS: number;
  private readonly endStationaryS: number;
  private readonly patternStationaryS: number;
  private readonly endNoDataS: number;
  private readonly watchdogIntervalMs: number;
  private readonly autoWatchdog: boolean;
  private readonly stopSpeedKt: number;
  private readonly startSpeedKt: number;
  private readonly minLeaderboardHz: number;
  private readonly settleFrames: number;
  private readonly loadQuarantineS: number;
  private readonly warn: (message: string, meta?: Record<string, unknown>) => void;

  private readonly phases: FlightPhaseDetector;
  private readonly sampler: AdaptiveSampler;
  private readonly landing: LandingTracker;
  /** WAVE 4 (FOQA): агрегаты фаз/стабильности/событий и per-landing анализ. */
  private readonly analysis = new FlightAnalysis();

  private recording = false;
  private clientFlightId: string | null = null;
  private startedAt: string | null = null;
  private seq = 0;
  private pointCount = 0;
  private eventCount = 0;
  private bounceCount = 0;
  private maxAltFt = 0;
  private previousEngine: boolean | null = null;
  private previousGearDown: boolean | null = null;
  private groundStoppedSinceMs: number | null = null;
  private lastSample: TelemetrySample | null = null;
  private finalMetrics: LandingMetricsResponse | null = null;
  private finalScore: LandingScore | null = null;
  private readonly recordedTs = new Set<string>();
  private readonly gapBeforeTs = new Set<string>();
  /** WAVE 3b: посадочная масса (кг) по `seq` посадки, снятая на касании. */
  private readonly landingWeightKgBySeq = new Map<number, number>();
  /** R1: точка касания/курс по `seq` для sim-геометрии ВПП. */
  /** Fallback sim_runway, когда destination ICAO неизвестен (apt.dat по точке). */
  private readonly touchdownSimRunways = new Map<number, SimRunway>();
  private readonly touchdownFixes = new Map<
    number,
    {
      latitude: number;
      longitude: number;
      headingDeg: number | null;
      aglFt: number | null;
      gsKt: number | null;
    }
  >();
  private previousSampleMs: number | null = null;
  /**
   * Последний **принятый** кадр для детекта телепорта/загрузки (P2). Кадры,
   * отброшенные карантином/скачком, базу не двигают, иначе скачок «размажется».
   */
  private previousAcceptedSample: TelemetrySample | null = null;
  /** Карантин после (ре)коннекта/загрузки: до какого `ts` кадры игнорируются. */
  private quarantineUntilMs: number | null = null;
  private quarantineLastSample: TelemetrySample | null = null;
  private quarantineStableStreak = 0;
  private quarantineSatisfied = true;
  /**
   * Последний скачок позиции/высоты (диагностика). Это НЕ причина отбрасывать
   * сессию: одиночный кадр-глюк сима не должен стоить пилоту рейса и посадки.
   * Кадр пропускается, запись продолжается с новой базой; зачётность посадки
   * считает сервер по `SLEW`/окну захода.
   */
  private positionGlitch: TeleportDetection | null = null;
  private teleportLogged = false;
  private lastSampleReceivedMs: number | null = null;
  private pausedTotalS = 0;
  /** Был ли в сессии хотя бы один кадр `slew` (диагностика в `stats`). */
  private slewSeen = false;
  private aircraftIcao = 'ZZZZ';
  private aircraftIcaoSource: AircraftIcaoSource = 'unknown';
  /** T-D §5.6: сырая строка модели (`ATC MODEL`/`TITLE`) для самообучения словаря. */
  private aircraftModelRaw: string | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** Подряд идущие правдоподобные кадры вне записи (окно оседания). */
  private coordinateSettleStreak = 0;
  /** С момента арма видели мусорный кадр → старт требует окна оседания. */
  private implausibleFrameSeen = false;
  /** Всего пропущено мусорных кадров (наблюдаемость в `stats`). */
  private implausibleSkipped = 0;
  private lastImplausibleLogMs: number | null = null;

  constructor(options: FlightRecorderOptions) {
    super();
    const source: SimSource | SimConnectAdapter | undefined = options.source ?? options.adapter;
    if (!source) {
      throw new Error('FlightRecorder requires a `source` (or legacy `adapter`)');
    }
    this.adapter = source;
    // Сохраняем метку сима для source-aware проверки правдоподобия (`sanity.ts`).
    // Legacy-путь через `adapter` (MSFS-мок/старый инстанс) метки не несёт → null.
    this.simSourceId = options.source?.id ?? null;
    this.buffer = options.buffer;
    this.clock = options.clock ?? systemClock;
    this.idGenerator = options.idGenerator ?? uuidGenerator;
    this.configuredAircraftIcao = options.aircraftIcao ?? DEFAULTS.aircraftIcao;
    this.aircraftIcaoLookup = options.aircraftIcaoLookup ?? null;
    this.callsign = options.callsign ?? DEFAULTS.callsign;
    this.deviceId = options.deviceId ?? DEFAULTS.deviceId;
    this.originIcao = options.originIcao ?? DEFAULTS.originIcao;
    this.destinationIcao = options.destinationIcao ?? DEFAULTS.destinationIcao;
    this.endEngineOffS = options.endEngineOffS ?? DEFAULTS.endEngineOffS;
    this.endStationaryS = options.endStationaryS ?? DEFAULTS.endStationaryS;
    this.patternStationaryS = options.patternStationaryS ?? DEFAULTS.patternStationaryS;
    this.endNoDataS = options.endNoDataS ?? DEFAULTS.endNoDataS;
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? DEFAULTS.watchdogIntervalMs;
    this.autoWatchdog = options.autoWatchdog ?? true;
    this.stopSpeedKt = options.stopSpeedKt ?? DEFAULTS.stopSpeedKt;
    this.startSpeedKt = options.startSpeedKt ?? DEFAULTS.startSpeedKt;
    this.minLeaderboardHz = options.minLeaderboardHz ?? DEFAULTS.minLeaderboardHz;
    this.settleFrames = options.settleFrames ?? DEFAULTS.settleFrames;
    this.loadQuarantineS = options.loadQuarantineS ?? DEFAULTS.loadQuarantineS;
    this.warn = options.warn ?? (() => {});

    this.phases = new FlightPhaseDetector(options.phase);
    this.sampler = new AdaptiveSampler(options.sampler);
    this.landing = new LandingTracker({
      aircraftIcao: this.configuredAircraftIcao ?? undefined,
      ...options.touchdown,
    });
  }

  get state(): RecorderState {
    return {
      phase: this.phases.phase,
      recording: this.recording,
      client_flight_id: this.clientFlightId,
      seq: this.seq,
      point_count: this.pointCount,
      event_count: this.eventCount,
      bounce_count: this.bounceCount,
      landing_count: this.landing.landingCount,
      touch_and_go_count: this.landing.touchAndGoCount,
      on_ground: this.landing.onGround,
      rate_hz: this.sampler.currentRateHz,
      score_preview: this.finalScore,
      metrics: this.finalMetrics,
    };
  }

  async start(): Promise<SimConnectOpenInfo> {
    // CD-3.2 (Gap 3.2): повторный connect (реконнект) не должен плодить
    // обработчики. `on*` — стабильные ссылки, поэтому off-before-on идемпотентен.
    this.adapter.off('sample', this.onSample);
    this.adapter.off('disconnect', this.onDisconnect);
    this.adapter.off('error', this.onError);
    this.adapter.on('sample', this.onSample);
    this.adapter.on('disconnect', this.onDisconnect);
    this.adapter.on('error', this.onError);
    // P2: после (ре)коннекта сим может отдавать кадры меню/загрузки. Карантин
    // отсчитывается от первого полученного кадра (не от локальных часов), чтобы
    // не зависеть от расхождения времени клиента и сима.
    this.armLoadQuarantine();
    const info = await this.adapter.connect();
    if (this.autoWatchdog && this.watchdog === null) {
      this.watchdog = setInterval(() => this.tick(), this.watchdogIntervalMs);
      this.watchdog.unref?.();
    }
    return info;
  }

  async stop(): Promise<void> {
    this.clearWatchdog();
    if (this.recording && this.lastSample) {
      this.finishFlight(this.lastSample, 'agent_stop');
    }
    this.adapter.off('sample', this.onSample);
    this.adapter.off('disconnect', this.onDisconnect);
    this.adapter.off('error', this.onError);
    await this.adapter.disconnect();
  }

  /**
   * Проверка watchdog `no_data`: если сэмплов нет дольше `endNoDataS`, рейс
   * закрывается локально как `completed` c `is_partial=true` — но только если
   * посадка ещё не подтверждена (ADR-0008 §2, T99).
   */
  tick(): void {
    if (!this.recording || !this.lastSample || this.lastSampleReceivedMs === null) return;
    const elapsedMs = this.clock.nowMs() - this.lastSampleReceivedMs;
    if (elapsedMs >= this.endNoDataS * 1000) {
      this.finishFlight(this.lastSample, 'no_data');
    }
  }

  private readonly onSample = (sample: TelemetrySample): void => {
    // Кадры повтора (X-Plane replay) — не полёт: ни точки, ни события, ни фазы,
    // ни старт/продление/закрытие рейса. `lastSample` не обновляем.
    if (sample.replay === true) return;
    try {
      this.handleSample(sample);
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  };

  private readonly onDisconnect = (reason?: string): void => {
    if (this.recording && this.lastSample) {
      this.finishFlight(this.lastSample, 'sim_disconnected');
    }
    this.emit('disconnect', reason);
  };

  private readonly onError = (error: Error): void => {
    this.emit('error', error);
  };

  private handleSample(sample: TelemetrySample): void {
    // P0 (data integrity): мусорные кадры меню/загрузки (null island, произвольные
    // `alt`/`agl`, нечисловые значения) не должны ни стартовать рейс, ни попадать
    // в запись. Пороги — `TELEMETRY_SANITY_LIMITS` (`@flightlog/scoring`).
    const sanity = checkSampleSanity(sample, { sim: this.simSourceId });
    if (!sanity.ok) {
      this.onImplausibleSample(sanity.reason);
      return;
    }

    this.lastSampleReceivedMs = this.clock.nowMs();
    if (sample.slew) this.slewSeen = true;

    // P2: скачок высоты/позиции — загрузка/телепорт, а не полёт. Кадр
    // отбрасывается, база детекта сбрасывается; если сессия уже пишется, она
    // помечается discarded и не даст ни посадок, ни баллов.
    const teleport = detectTeleport(this.previousAcceptedSample, sample);
    if (teleport.detected) {
      this.onTeleportSample(teleport);
      return;
    }

    // P2: после (ре)коннекта/загрузки не стартуем на первых нестабильных кадрах.
    if (!this.recording && !this.passesLoadQuarantine(sample)) return;

    this.previousAcceptedSample = sample;
    this.lastSample = sample;

    if (!this.recording) {
      // Арм-окно: пока телеметрия не устоялась, кадры игнорируются (рейс не
      // стартует и точки/события не эмитятся). Bogus-airborne на стоянке
      // (`on_ground=false` при `gs≈0`, произвольные `agl`/`alt`) и «на земле»
      // с невозможным AGL сюда не проходят.
      this.coordinateSettleStreak += 1;
      if (!this.telemetrySettled(sample)) return;
      if (!this.shouldStart(sample)) return;
      // После мусорных кадров (меню/загрузка) не стартуем на первом же валидном
      // кадре — ждём короткое окно оседания. Чистый старт окна не ждёт.
      if (this.implausibleFrameSeen && this.coordinateSettleStreak < this.settleFrames) return;
      this.startFlight(sample);
    } else {
      this.tryResolveAircraftIcao(sample);
    }

    this.detectGap(sample);

    // WAVE 4 (FOQA): копим агрегаты фаз/стабильности и окно для per-landing анализа.
    this.analysis.onSample(sample);

    const previousEngine = this.previousEngine;
    this.previousEngine = sample.engine_running;
    if (sample.engine_running && previousEngine !== true) {
      this.emitEvent('engine_start', sample, {});
    } else if (!sample.engine_running && previousEngine === true) {
      this.emitEvent('engine_stop', sample, {});
    }

    if (Number.isFinite(sample.alt_ft)) this.maxAltFt = Math.max(this.maxAltFt, sample.alt_ft);

    const previousGearDown = this.previousGearDown;
    if (typeof sample.gear_down === 'boolean') {
      if (previousGearDown !== null && previousGearDown !== sample.gear_down) {
        this.emitEvent(sample.gear_down ? 'gear_down' : 'gear_up', sample, {
          gear_down: sample.gear_down,
        });
      }
      this.previousGearDown = sample.gear_down;
    }

    const transition = this.phases.update(sample);
    if (transition) {
      if (transition.to === 'taxi') this.emitEvent('taxi', sample, { reason: transition.reason });
      if (transition.to === 'airborne' && transition.from === 'takeoff') {
        this.emitEvent('takeoff', sample, {});
      }
    }

    const decision = this.sampler.push(sample);
    if (decision.record) this.persistPoint(sample);

    for (const touchdownEvent of this.landing.update(sample)) {
      this.handleTouchdownEvent(touchdownEvent, sample);
    }

    this.checkFlightEnd(sample);
  }

  /** Gap-based детект паузы (api.md §4.2, ADR-0008 §1): `delta > max(3×target, 2 c)`. */
  private detectGap(sample: TelemetrySample): void {
    const nowMs = Date.parse(sample.ts);
    if (!Number.isFinite(nowMs)) return;
    const previousMs = this.previousSampleMs;
    this.previousSampleMs = nowMs;
    if (previousMs === null) return;

    const deltaS = (nowMs - previousMs) / 1000;
    if (deltaS <= 0) return;
    const targetPeriodS = this.sampler.currentRateHz > 0 ? 1 / this.sampler.currentRateHz : 0;
    const thresholdS = Math.max(3 * targetPeriodS, 2);
    if (deltaS > thresholdS) {
      this.pausedTotalS += deltaS;
      this.gapBeforeTs.add(sample.ts);
    }
  }

  /** Перезапуск карантина после коннекта/загрузки/телепорта. */
  private armLoadQuarantine(): void {
    this.previousAcceptedSample = null;
    this.quarantineUntilMs = null;
    this.quarantineLastSample = null;
    this.quarantineStableStreak = 0;
    this.quarantineSatisfied = this.loadQuarantineS <= 0;
  }

  /**
   * Карантин старта: `loadQuarantineS` секунд по `ts` сим-кадров плюс два
   * подряд устойчивых кадра (тот же `on_ground`, высота без скачка).
   */
  private passesLoadQuarantine(sample: TelemetrySample): boolean {
    if (this.quarantineSatisfied) return true;
    const ts = Date.parse(sample.ts);
    if (!Number.isFinite(ts)) return false;
    if (this.quarantineUntilMs === null) {
      this.quarantineUntilMs = ts + this.loadQuarantineS * 1000;
    }
    if (ts < this.quarantineUntilMs) {
      this.quarantineLastSample = sample;
      return false;
    }
    const previous = this.quarantineLastSample;
    this.quarantineLastSample = sample;
    const consistent =
      previous !== null &&
      previous.on_ground === sample.on_ground &&
      Number.isFinite(previous.alt_ft) &&
      Number.isFinite(sample.alt_ft) &&
      Math.abs(sample.alt_ft - previous.alt_ft) <=
        TELEPORT_JUMP_LIMITS.maxAltitudeJumpFt;
    this.quarantineStableStreak = consistent ? this.quarantineStableStreak + 1 : 1;
    if (this.quarantineStableStreak >= 2) {
      this.quarantineSatisfied = true;
      return true;
    }
    return false;
  }

  /**
   * Скачок позиции/высоты: кадр не принимается, база сбрасывается. Это шум
   * сима/GPS, а не приговор сессии: запись продолжается, посадка остаётся.
   * Зачётность (slew в окне захода) определяет сервер по точкам трека.
   */
  private onTeleportSample(teleport: TeleportDetection): void {
    if (this.recording) {
      this.positionGlitch = teleport;
      this.previousAcceptedSample = null;
    } else {
      this.armLoadQuarantine();
    }
    if (this.teleportLogged) return;
    this.teleportLogged = true;
    this.warn('position glitch (frame skipped, flight kept)', {
      kind: teleport.kind,
      altitude_delta_ft: teleport.altitudeDeltaFt,
      horizontal_m: teleport.horizontalM,
      dt_s: teleport.dtS,
    });
  }

  /**
   * Мусорный кадр: сбрасывает окно оседания, помечает «арм был грязным» и
   * rate-limited логирует факт (первое сообщение — сразу, далее не чаще
   * `IMPLAUSIBLE_LOG_INTERVAL_MS`) с причиной и накопленным счётчиком.
   */
  private onImplausibleSample(reason: TelemetrySanityReason | null): void {
    this.coordinateSettleStreak = 0;
    this.implausibleFrameSeen = true;
    this.implausibleSkipped += 1;
    const nowMs = this.clock.nowMs();
    if (
      this.lastImplausibleLogMs !== null &&
      nowMs - this.lastImplausibleLogMs < IMPLAUSIBLE_LOG_INTERVAL_MS
    ) {
      return;
    }
    this.lastImplausibleLogMs = nowMs;
    this.warn('implausible telemetry frame skipped', {
      reason: reason ?? 'unknown',
      skipped: this.implausibleSkipped,
    });
  }

  /**
   * Устоялась ли телеметрия на старте сессии. `on_ground=false` принимается
   * только с признаками реального полёта (`hasFlightEvidence`: скорость,
   * вертикаль, отделение), иначе кадр — bogus (ВС на полосе). `on_ground=true`
   * с заведомо невозможным AGL тоже отбрасывается.
   */
  private telemetrySettled(sample: TelemetrySample): boolean {
    if (sample.on_ground) {
      return sample.agl_ft === null || sample.agl_ft <= MAX_GROUND_AGL_FT;
    }
    return hasSampleFlightEvidence(sample);
  }

  private shouldStart(sample: TelemetrySample): boolean {
    return sample.engine_running || !sample.on_ground || sample.gs_kt >= this.startSpeedKt;
  }

  /** `icao_type_designator` из `aircraft.cfg` (best-effort, не бросает). */
  private lookupIcaoTypeDesignator(sample: TelemetrySample): string | null {
    if (!this.aircraftIcaoLookup) return null;
    try {
      return this.aircraftIcaoLookup({ title: sample.title, atcModel: sample.atc_model });
    } catch {
      return null;
    }
  }

  private startFlight(sample: TelemetrySample): void {
    const resolved = this.configuredAircraftIcao
      ? { icao: this.configuredAircraftIcao, source: 'config' as const }
      : resolveAircraftIcao({
          atc_model: sample.atc_model,
          atc_type: sample.atc_type,
          title: sample.title,
          icaoTypeDesignator: this.lookupIcaoTypeDesignator(sample),
        });
    this.aircraftIcao = resolved.icao;
    this.aircraftIcaoSource = resolved.source;
    this.aircraftModelRaw = selectAircraftModelRaw(sample);
    this.landing.setAircraftIcao(resolved.icao);

    this.clientFlightId = this.idGenerator();
    this.startedAt = sample.ts;
    this.recording = true;
    this.seq = 0;
    this.pointCount = 0;
    this.eventCount = 0;
    this.bounceCount = 0;
    this.pausedTotalS = 0;
    this.maxAltFt = Number.isFinite(sample.alt_ft) ? sample.alt_ft : 0;
    this.groundStoppedSinceMs = null;
    this.previousEngine = null;
    this.previousGearDown = null;
    this.slewSeen = false;
    this.coordinateSettleStreak = 0;
    this.implausibleFrameSeen = false;
    this.positionGlitch = null;
    this.teleportLogged = false;
    this.quarantineSatisfied = true;
    this.finalMetrics = null;
    this.finalScore = null;
    this.previousSampleMs = Date.parse(sample.ts);
    this.recordedTs.clear();
    this.gapBeforeTs.clear();
    this.landingWeightKgBySeq.clear();
    this.touchdownFixes.clear();
    this.touchdownSimRunways.clear();
    if (this.simSourceId === 'xplane12') {
      if (this.destinationIcao) prewarmAirportRunways(this.destinationIcao);
      else prewarmAirportIndex();
    }
    this.phases.reset();
    this.sampler.reset();
    this.landing.reset();
    this.analysis.reset();

    const now = this.clock.nowIso();
    this.buffer.upsertFlight({
      client_flight_id: this.clientFlightId,
      aircraft_icao: this.aircraftIcao,
      callsign: this.callsign,
      origin_icao: this.originIcao,
      destination_icao: this.destinationIcao,
      device_id: this.deviceId,
      started_at: sample.ts,
      ended_at: null,
      status: 'in_progress',
      stats: this.progressStats(),
      created_at: now,
      updated_at: now,
      synced_at: null,
    });

    this.emit('flight_started', {
      client_flight_id: this.clientFlightId,
      started_at: sample.ts,
      aircraft_icao: this.aircraftIcao,
      aircraft_icao_source: this.aircraftIcaoSource,
    });
  }

  /** Если на старте `ATC MODEL/TYPE` ещё не заполнены — до-резолвим ICAO в полёте. */
  private tryResolveAircraftIcao(sample: TelemetrySample): void {
    if (this.aircraftIcaoSource !== 'unknown' || !this.clientFlightId || !this.startedAt) return;
    const resolved = resolveAircraftIcao({
      atc_model: sample.atc_model,
      atc_type: sample.atc_type,
      title: sample.title,
      icaoTypeDesignator: this.lookupIcaoTypeDesignator(sample),
    });
    // T-D §5.6: сырая строка модели могла появиться позже старта — фиксируем её,
    // даже если тип всё ещё не распознан (это и есть ценная обучающая пара).
    const raw = selectAircraftModelRaw(sample);
    const rawChanged = raw !== null && raw !== this.aircraftModelRaw;
    if (resolved.source === 'unknown' && !rawChanged) return;
    if (rawChanged) this.aircraftModelRaw = raw;
    if (resolved.source !== 'unknown') {
      this.aircraftIcao = resolved.icao;
      this.aircraftIcaoSource = resolved.source;
      this.landing.setAircraftIcao(resolved.icao);
    }
    this.buffer.upsertFlight({
      client_flight_id: this.clientFlightId,
      aircraft_icao: this.aircraftIcao,
      callsign: this.callsign,
      origin_icao: this.originIcao,
      destination_icao: this.destinationIcao,
      device_id: this.deviceId,
      started_at: this.startedAt,
      ended_at: null,
      status: 'in_progress',
      stats: this.progressStats(),
      created_at: this.startedAt,
      updated_at: this.clock.nowIso(),
      synced_at: null,
    });
  }

  /** Статистика in_progress-рейса: источник ICAO + (если есть) сырая строка модели. */
  private progressStats(): Record<string, unknown> {
    const stats: Record<string, unknown> = {
      aircraft_icao_source: this.aircraftIcaoSource,
      aircraft_db_version: AIRCRAFT_DB_VERSION,
    };
    if (this.aircraftModelRaw) stats.aircraft_model_raw = this.aircraftModelRaw;
    return stats;
  }

  private persistPoint(sample: TelemetrySample): void {
    if (!this.clientFlightId || this.recordedTs.has(sample.ts)) return;
    // id генерируется один раз в момент материализации и не перегенерируется (ADR-0007).
    const clientPointId = this.idGenerator();
    const quality = this.qualityForSample(sample);
    const point = toTrackPoint(sample, this.seq + 1, { clientPointId, quality });
    this.seq += 1;
    this.buffer.appendPoints(this.clientFlightId, [point]);
    this.recordedTs.add(sample.ts);
    this.pointCount += 1;
  }

  private qualityForSample(sample: TelemetrySample): number {
    let quality = sample.slew ? QUALITY_BITS.SLEW : 0;
    if (this.gapBeforeTs.has(sample.ts)) quality |= QUALITY_BITS.GAP_BEFORE;
    return quality;
  }

  private emitEvent(
    type: FlightEventType,
    sample: TelemetrySample,
    data: Record<string, unknown>,
    severity = 0,
  ): FlightEvent | null {
    if (!this.clientFlightId) return null;
    const event = toFlightEvent(type, sample, data, this.idGenerator(), severity);
    this.buffer.appendEvents(this.clientFlightId, [event]);
    this.eventCount += 1;
    // WAVE 4: событие также в агрегат рейса (`stats.events`, привязка к касанию).
    this.analysis.onEvent(type, event.ts);
    this.emit('event', event);
    return event;
  }

  private handleTouchdownEvent(event: TouchdownEvent, sample: TelemetrySample): void {
    // Скачок позиции/высоты (глюк кадра) не отменяет посадку: кадр уже
    // пропущен, трек продолжается, зачётность решает сервер по окну захода.
    if (event.kind === 'touchdown') {
      // WAVE 3b: масса снимается на кадре касания этой посадки (не на отскоке).
      const weightKg = poundsToKg(sample.total_weight_lb);
      if (weightKg !== null) this.landingWeightKgBySeq.set(event.landingSeq, weightKg);
      // R1: точка касания (WGS84) и курс — для геометрии ВПП из симулятора.
      const landingLat = finiteNumber(event.latitude);
      const landingLon = finiteNumber(event.longitude);
      if (landingLat !== null && landingLon !== null) {
        const fix = {
          latitude: landingLat,
          longitude: landingLon,
          headingDeg: finiteNumber(event.headingDeg) ?? finiteNumber(sample.heading_deg) ?? null,
        };
        this.touchdownFixes.set(event.landingSeq, {
          ...fix,
          aglFt: finiteNumber(sample.agl_ft),
          gsKt: finiteNumber(sample.gs_kt),
        });
        if (this.simSourceId === 'xplane12' && !this.destinationIcao) {
          void this.resolveFallbackSimRunway(event.landingSeq, fix);
        }
      }
      // WAVE 4 (FOQA): per-landing анализ (конфигурация/ILS/AoA/касание/серии).
      this.analysis.onTouchdown(event.landingSeq, sample, null);
      const { backfill } = this.sampler.markTouchdown(event.ts);
      for (const buffered of backfill) this.persistPoint(buffered);
    } else {
      this.sampler.extendWindow(event.ts);
    }

    // FOQA-FIDELITY (touchdown VS): кадр самого перехода `air→ground` обязан быть
    // в треке. На заходе сэмплер пишет ~1 Гц (окно 10 Гц включается только на
    // касании), поэтому кадр касания может не пройти обычный `push`, а backfill
    // окна намеренно исключает якорь (`ts < anchor`). Без него серверный
    // `segmentLandings` берёт следующую наземную точку (~+110 мс — уже после
    // обжатия/derotation), и `vs_fpm` выходит мягче фактического (инцидент:
    // клиент −114, сервер −111). `persistPoint` идемпотентен по `ts`, поэтому в
    // обычном случае (кадр уже записан `push`) вызов ничего не меняет.
    this.persistPoint(sample);

    this.bounceCount = this.landing.landings.reduce((sum, landing) => sum + landing.bounceCount, 0);
    this.syncRepresentative();

    this.emitEvent(
      event.kind,
      sample,
      {
        landing_seq: event.landingSeq,
        vs_fpm: event.metrics.vs_fpm,
        // Пик снижения окна — отдельно (R5.7): сервер сверяет его с оконным
        // минимумом трека, а `vs_fpm` метрики остаётся VS касания.
        vs_peak_fpm: event.vsPeakFpm,
        g: event.metrics.g_force,
        pitch_deg: event.metrics.pitch_deg ?? undefined,
        bank_deg: event.metrics.bank_deg ?? undefined,
        bounce_count: event.bounceCount,
        touch_and_go: event.touchAndGo,
      },
      event.kind === 'bounce' ? 1 : 0,
    );
    this.emit('score', event);
  }

  /**
   * R1: sim_runway для представительной посадки. X-Plane — по кэшу apt.dat
   * (прогрет на старте рейса), MSFS — по значениям ATC на кадре касания.
   */
  private simRunwayForLanding(
    best: LandingPreview | null,
    point: TouchdownPoint | null,
  ): SimRunway | null {
    if (!best) return null;
    return this.simRunwayForSeq(best.seq, point);
  }

  /** R1: sim runway geometry for one landing (0.3.34 per-landing). */
  private simRunwayForSeq(seq: number, point: TouchdownPoint | null): SimRunway | null {
    const fix = this.touchdownFixes.get(seq);
    if (!fix) return null;
    if (this.simSourceId === 'xplane12') {
      if (this.destinationIcao) return resolveCachedSimRunway(this.destinationIcao, fix);
      return this.touchdownSimRunways.get(seq) ?? null;
    }
    return buildAtcSimRunway(fix, point);
  }

  /** apt.dat fallback: ближайший аэропорт по точке касания, затем его полоса. */
  private async resolveFallbackSimRunway(seq: number, fix: SimTouchdownPoint): Promise<void> {
    try {
      const icao = await findNearestAirportIcao(fix.latitude, fix.longitude);
      if (!icao) return;
      const runway = await resolveSimRunway(icao, fix);
      if (runway) this.touchdownSimRunways.set(seq, runway);
    } catch {
      // soft: apt.dat не обязателен для записи посадки
    }
  }

  /** Представительная (лучшая) посадка сессии — политика `best` (ADR-0010 §4). */
  private representativeLanding(): LandingPreview | null {
    let best: LandingPreview | null = null;
    for (const landing of this.landing.landings) {
      if (best === null) {
        best = landing;
        continue;
      }
      if (landing.score.score !== best.score.score) {
        if (landing.score.score > best.score.score) best = landing;
        continue;
      }
      if (landing.touchdown_at !== best.touchdown_at) {
        if (landing.touchdown_at > best.touchdown_at) best = landing;
        continue;
      }
      if (landing.seq > best.seq) best = landing;
    }
    return best;
  }

  private syncRepresentative(): void {
    const best = this.representativeLanding();
    this.finalMetrics = best?.metrics ?? null;
    this.finalScore = best?.score ?? null;
  }

  private checkFlightEnd(sample: TelemetrySample): void {
    if (!this.recording) return;
    if (sample.on_ground && sample.gs_kt < this.stopSpeedKt) {
      const nowMs = Date.parse(sample.ts);
      if (this.groundStoppedSinceMs === null) this.groundStoppedSinceMs = nowMs;
      const stoppedForS = (nowMs - this.groundStoppedSinceMs) / 1000;
      // До первого касания «брошенная» сессия закрывается раньше; после посадок
      // действует щадящий порог, чтобы руление/ожидание между кругами не резало
      // сессию на несколько рейсов (ADR-0010 §2).
      const stationaryThreshold =
        this.landing.landingCount > 0 ? this.patternStationaryS : this.endStationaryS;
      if (this.allEnginesOff(sample) && stoppedForS >= this.endEngineOffS) {
        this.finishFlight(sample, 'engine_stop');
      } else if (stoppedForS >= stationaryThreshold) {
        this.finishFlight(sample, 'parked');
      }
    } else {
      this.groundStoppedSinceMs = null;
    }
  }

  /** Все двигатели `GENERAL ENG COMBUSTION:1..4` выключены (fallback — двиг. 1). */
  private allEnginesOff(sample: TelemetrySample): boolean {
    if (typeof sample.engines_running === 'number') return sample.engines_running === 0;
    return !sample.engine_running;
  }

  private finishFlight(sample: TelemetrySample, reason: string): void {
    if (!this.recording || !this.clientFlightId || !this.startedAt) return;
    const endedAt = sample.ts;
    const elapsedS = Math.max(
      0,
      Math.round((Date.parse(endedAt) - Date.parse(this.startedAt)) / 1000),
    );
    const pausedTotalS = Math.round(this.pausedTotalS);
    const durationS = Math.max(0, elapsedS - pausedTotalS);

    const landings = this.landing.landings.map((landing) => ({ ...landing }));

    // Сессия без подтверждённого отрыва — это не рейс (стоянка/руление). На
    // сервер она уйдёт, но `/complete` её удалит (API-проверка flight-evidence),
    // а `landing`-событие не эмитится, чтобы не фиксировать ложную посадку.
    const noFlightEvidence = !this.landing.hasConfirmedLiftoff && landings.length === 0;
    const discarded = noFlightEvidence;
    const discardReason: 'no_flight_evidence' | null = noFlightEvidence
      ? 'no_flight_evidence'
      : null;

    const best = this.representativeLanding();
    const touchdownTs = best?.touchdown_at ?? null;
    // WAVE 3b: масса представительной (лучшей) посадки сессии, снятая на касании.
    const landingWeightKg = best ? (this.landingWeightKgBySeq.get(best.seq) ?? null) : null;
    const totalBounceCount = landings.reduce((sum, landing) => sum + landing.bounceCount, 0);
    const touchAndGoCount = landings.filter((landing) => landing.touchAndGo).length;

    const assessment = this.assessQuality(touchdownTs);
    // ADR-0008 §2 (T99): терминальная потеря данных (`no_data`/`sim_disconnected`)
    // делает рейс partial только если до неё не было подтверждённого касания.
    // Посадки, случившиеся до обрыва, уже записаны в окнах касания, поэтому рейс
    // остаётся полным и допускается в лидерборд (при отсутствии value-битов).
    const lostBeforeLanding =
      (reason === 'no_data' || reason === 'sim_disconnected') && landings.length === 0;
    const isPartial = lostBeforeLanding || assessment.gap_in_window;
    // Клиентский preview: `is_partial` (gap/терминальная потеря) — заметка о
    // полноте записи и больше не лишает лидерборда. Гейтят только slew в окне
    // до касания и пауза (учтены в `assessment.leaderboard_eligible`).
    const leaderboardEligible = !discarded && assessment.leaderboard_eligible;

    const stats: Record<string, unknown> = {
      point_count: this.pointCount,
      max_altitude_ft: Math.round(this.maxAltFt),
      duration_s: durationS,
      elapsed_s: elapsedS,
      paused_total_s: pausedTotalS,
      touchdown_at: touchdownTs,
      // WAVE 3b: посадочная масса (кг) и её источник; `null` = измерения нет.
      landing_weight_kg: landingWeightKg,
      landing_weight_source: landingWeightKg === null ? null : 'sim',
      landings_count: landings.length,
      touch_and_go_count: touchAndGoCount,
      bounce_count: totalBounceCount,
      end_reason: reason,
      score_preview: this.finalScore,
      is_partial: isPartial,
      leaderboard_eligible: leaderboardEligible,
      quality_flags: assessment.quality_flags,
      confidence: assessment.confidence,
      effective_window_hz: assessment.effective_hz,
      window_sample_count: assessment.sample_count,
      aircraft_icao_source: this.aircraftIcaoSource,
      aircraft_db_version: AIRCRAFT_DB_VERSION,
      // Диагностика: были ли в сессии кадры slew (детекторы их игнорируют).
      slew_seen: this.slewSeen,
      // P0: сколько мусорных кадров (меню/загрузка) пропущено за сессию.
      implausible_samples_skipped: this.implausibleSkipped,
      // Явный сигнал «сессию не сохраняем» (нет отрыва — стоянка/руление):
      // сервер по нему удаляет рейс, uploader — отзывает локальную сессию.
      no_flight_evidence: discarded,
      // P2: причина отбрасывания и диагностика пропущенного кадра-глюка. Глюк
      // позиции рейс не отбрасывает — это шум сима, а не телепорт пилота.
      discard_reason: discardReason,
      position_glitch: this.positionGlitch
        ? {
            kind: this.positionGlitch.kind,
            altitude_delta_ft: this.positionGlitch.altitudeDeltaFt,
            horizontal_m: this.positionGlitch.horizontalM,
            dt_s: this.positionGlitch.dtS,
          }
        : null,
    };
    // T-D §5.6: сырая строка модели переживает `finalizeFlight` (stats замещаются
    // целиком) и уходит в `POST /v1/flights` для самообучения словаря.
    if (this.aircraftModelRaw) stats.aircraft_model_raw = this.aircraftModelRaw;

    // WAVE 4 (FOQA): агрегаты фаз/стабильности/событий и per-landing анализ.
    // Скалярные агрегаты — от представительной (лучшей) посадки; полный анализ
    // каждой посадки — в `landings_analysis` (сервер разложит по `landings.analysis`).
    const aggregate = this.analysis.finalize(touchdownTs);
    stats.phases = aggregate.phases;
    stats.stability = aggregate.stability;
    stats.events = aggregate.events;
    const bestAnalysis = best ? this.analysis.getLandingAnalysis(best.seq) : undefined;
    if (bestAnalysis) {
      stats.config_at_1000ft = bestAnalysis.config_at_1000ft;
      stats.config_at_500ft = bestAnalysis.config_at_500ft;
      stats.ap_disconnect_agl_ft = bestAnalysis.ap_disconnect_agl_ft;
      stats.at_disconnect_agl_ft = bestAnalysis.at_disconnect_agl_ft;
      stats.flare_height_ft = bestAnalysis.flare_height_ft;
      stats.flare_duration_s = bestAnalysis.flare_duration_s;
      // FOQA-DATUM-1: датум-калибровка и высоты колёс представительной посадки.
      stats.agl_datum_offset_ft = bestAnalysis.agl_datum_offset_ft;
      stats.agl_datum_version = bestAnalysis.agl_datum_version;
      stats.height_datum_calibrated = bestAnalysis.height_datum_calibrated;
      stats.flare_height_wheel_ft = bestAnalysis.flare_height_wheel_ft;
      stats.ils = bestAnalysis.ils;
      stats.aoa_touchdown_deg = bestAnalysis.aoa_touchdown_deg;
      stats.aoa_max_near_touchdown_deg = bestAnalysis.aoa_max_near_touchdown_deg;
      stats.cg_percent_touchdown = bestAnalysis.cg_percent_touchdown;
      stats.surface_condition = bestAnalysis.surface_condition;
      stats.surface_type = bestAnalysis.surface_type;
      stats.touchdown_point = bestAnalysis.touchdown_point;
      stats.radio_height_touchdown_ft = bestAnalysis.radio_height_touchdown_ft;
      stats.wheel_height_touchdown_ft = bestAnalysis.wheel_height_touchdown_ft;
      // ENGINE-MODE: двигатели представительной посадки (касание + пробег).
      stats.engine_touchdown = bestAnalysis.engine_touchdown;
      stats.engine_rollout = bestAnalysis.engine_rollout;
      stats.wind_shear = bestAnalysis.wind_shear;
    }
    // R1: геометрия ВПП от симулятора (X-Plane apt.dat / MSFS ATC) для
    // представительной посадки; `null` — сервер использует OurAirports.
    const bestFix = best ? this.touchdownFixes.get(best.seq) : undefined;
    if (bestFix) {
      // Локальный ключ для uploader (не уходит в `stats`: whitelist).
      stats.touchdown_geo = {
        latitude: bestFix.latitude,
        longitude: bestFix.longitude,
        heading_deg: bestFix.headingDeg,
      };
    }
    const simRunway = this.simRunwayForLanding(best, bestAnalysis?.touchdown_point ?? null);
    if (simRunway) stats.sim_runway = simRunway;
    // MSFS: the server falls back to OurAirports when the ATC contact values are
    // unusable. Make that fallback visible once per flight (no raw sim values on
    // success; AGL/GS at touchdown are diagnostic context, not PII).
    if (this.simSourceId === 'msfs2024' && !simRunway && best && bestAnalysis) {
      const reason = atcRunwayMissingReason(bestAnalysis.touchdown_point);
      if (reason) {
        stats.atc_runway_missing = true;
        this.warn('ATC runway data missing at touchdown', {
          reason,
          aglFt: bestFix?.aglFt ?? null,
          gsKt: bestFix?.gsKt ?? null,
        });
      }
    }
    const landingsAnalysis: Record<string, unknown> = {};
    for (const [seq, analysis] of this.analysis.allLandingAnalysis) {
      // 0.3.34: each landing carries its own sim runway (parallel 06L/06C).
      const simRunway = this.simRunwayForSeq(seq, analysis.touchdown_point ?? null);
      landingsAnalysis[String(seq)] = simRunway ? { ...analysis, sim_runway: simRunway } : analysis;
    }
    if (Object.keys(landingsAnalysis).length > 0) stats.landings_analysis = landingsAnalysis;

    if (!discarded) {
      this.emitEvent('landing', sample, stats, 0);
    }
    this.buffer.finalizeFlight(
      this.clientFlightId,
      endedAt,
      'completed',
      stats,
      this.clock.nowIso(),
    );

    this.recording = false;
    this.emit('flight_ended', {
      client_flight_id: this.clientFlightId,
      started_at: this.startedAt,
      ended_at: endedAt,
      reason,
      point_count: this.pointCount,
      event_count: this.eventCount,
      bounce_count: totalBounceCount,
      landings_count: landings.length,
      touch_and_go_count: touchAndGoCount,
      landings,
      score_preview: this.finalScore,
      metrics: this.finalMetrics,
      is_partial: isPartial,
      leaderboard_eligible: leaderboardEligible,
      quality_flags: assessment.quality_flags,
      paused_total_s: pausedTotalS,
      confidence: assessment.confidence,
      discarded,
      discard_reason: discardReason,
    });
  }

  private assessQuality(touchdownTs: string | null): {
    effective_hz: number;
    confidence: number;
    gap_in_window: boolean;
    quality_flags: number;
    leaderboard_eligible: boolean;
    sample_count: number;
  } {
    if (!touchdownTs || !this.clientFlightId) {
      return {
        effective_hz: 0,
        confidence: 0,
        gap_in_window: false,
        quality_flags: 0,
        leaderboard_eligible: false,
        sample_count: 0,
      };
    }
    const points = this.buffer.loadPoints(this.clientFlightId).map((point) => ({
      client_point_id: point.client_point_id,
      ts: point.ts,
      quality: point.quality,
    }));
    const assessment = assessTouchdownWindow(points, {
      touchdownTs,
      windowS: this.sampler.windowS,
      targetHz: this.sampler.touchdownHz,
      minLeaderboardHz: this.minLeaderboardHz,
    });
    if (assessment.point_updates.length > 0) {
      this.buffer.updatePointQuality(this.clientFlightId, assessment.point_updates);
    }
    return {
      effective_hz: assessment.effective_hz,
      confidence: assessment.confidence,
      gap_in_window: assessment.gap_in_window,
      quality_flags: assessment.quality_flags,
      leaderboard_eligible: assessment.leaderboard_eligible,
      sample_count: assessment.sample_count,
    };
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }
}
