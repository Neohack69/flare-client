import {
  LANDING_ANALYSIS_VERSION,
  landingAnalysisSchema,
  type EngineAggregate,
  type EngineMode,
  type FlightPhaseStats,
  type FlightStabilityStats,
  type FlightTrendEvent,
  type LandingAnalysis,
  type LandingAnalysisSeriesPoint,
} from '@flightlog/contracts';

import {
  AGL_DATUM_VERSION,
  bankWindowStats,
  measureAglDatumOffset,
  toWheelHeightFt,
  type GroundHeightSample,
} from '@flightlog/scoring';

import type { FlightEventType } from '@flightlog/contracts';

import type { TelemetrySample } from '../sim/types.js';

/** 1 радиан → градусы (AoA хранится в градусах, SimVar — в радианах). */
const RAD_TO_DEG = 180 / Math.PI;

/** Предел «окна подхода» по времени (с) — покрывает заход с 3000 ft AGL. */
const APPROACH_WINDOW_S = 300;
/** Предел окна по числу кадров (10 Гц × 300 с = 3000). */
const APPROACH_WINDOW_MAX = 3000;
/** Шаг прореживания time-series для графиков (с). */
const SERIES_STEP_S = 1;
/** Максимум секунд до касания в серии (оставляем только заход). */
const SERIES_WINDOW_S = 120;
/** Окно «около касания» для пика AoA (с). */
const AOA_NEAR_TD_S = 5;
/** Окно оценки wind shear (с). */
const WIND_SHEAR_WINDOW_S = 30;
/** Порог «стабилизирован по крену» (град). */
const STABILIZED_BANK_MAX_DEG = 5;
/** Минимальные закрылки для «стабилизирован» (%). */
const STABILIZED_FLAPS_MIN_PERCENT = 25;
/** Порог срабатывания выравнивания по вертикальной скорости (fpm). */
const FLARE_VS_FPM = -300;
/**
 * Высота, ниже которой ищем начало выравнивания (ft **опорной точки**, FOQA-DATUM-1;
 * не колёс). Порог — потолок поиска (реальное выравнивание начинается заметно
 * ниже), поэтому датум-сдвиг на него не влияет.
 */
const FLARE_MAX_AGL_FT = 100;
/**
 * Предел числа наземных сэмплов, по которым измеряется датум AGL
 * (`measureAglDatumOffset`). Площадка стоянки на старте рейса — надёжный
 * носитель сдвига; кэп защищает память на долгих рулениях.
 */
const AGL_DATUM_MAX_SAMPLES = 4096;
/** ENGINE-MODE: полоса высот вокруг 1000/500 ft для агрегата двигателей. */
const ENGINE_ALT_BAND_FT = 50;
/** ENGINE-MODE: окно до касания для агрегата двигателей (с). */
const ENGINE_TOUCHDOWN_WINDOW_S = 5;
/** ENGINE-MODE: предельная длительность пробега для агрегата (с). */
const ROLLOUT_MAX_S = 120;
/** ENGINE-MODE: минимальная длительность пробега до «торможение завершено» (с). */
const ROLLOUT_MIN_S = 3;
/** ENGINE-MODE: скорость, ниже которой пробег считается завершённым (kt). */
const ROLLOUT_END_GS_KT = 30;

type PhaseClass = 'takeoff' | 'climb' | 'cruise' | 'descent' | 'approach';

interface Accumulator {
  count: number;
  sum: number;
}

interface EngineRolloutState {
  seq: number;
  touchdownMs: number;
  samples: TelemetrySample[];
  lastGroundMs: number | null;
}

function acc(): Accumulator {
  return { count: 0, sum: 0 };
}

function push(accumulator: Accumulator, value: number | null | undefined): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    accumulator.count += 1;
    accumulator.sum += value;
  }
}

function mean(accumulator: Accumulator): number | null {
  return accumulator.count > 0 ? accumulator.sum / accumulator.count : null;
}

function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Индексы работающих двигателей (N1 > 0 %); пусто — N1 нет/все стоят. */
function activeEngineIndexes(sample: TelemetrySample): number[] {
  const n1 = sample.n1_percent;
  if (!Array.isArray(n1)) return [];
  const indexes: number[] = [];
  for (let index = 0; index < n1.length; index += 1) {
    const value = n1[index];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) indexes.push(index);
  }
  return indexes;
}

function engineValues(
  sample: TelemetrySample,
  values: ReadonlyArray<number | null> | null | undefined,
  activeIndexes: readonly number[],
  filterByActive: boolean,
): number[] {
  if (!Array.isArray(values)) return [];
  const out: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (filterByActive && activeIndexes.length > 0 && !activeIndexes.includes(index)) continue;
    const value = values[index];
    if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  }
  return out;
}

function dominantEngineMode(modes: ReadonlyMap<EngineMode, number>): EngineMode | null {
  let best: EngineMode | null = null;
  let bestCount = 0;
  for (const [mode, count] of modes) {
    if (mode === 'unknown') continue;
    if (count > bestCount) {
      best = mode;
      bestCount = count;
    }
  }
  if (best !== null) return best;
  return modes.has('unknown') ? 'unknown' : null;
}

/**
 * Детерминированный агрегат двигателей по окну сэмплов. N1 — только по
 * работающим двигателям (N1 > 0), тяга/расход — по тем же индексам (fallback —
 * все непустые). `null` — в окне нет ни одного двигательного значения.
 */
function engineAggregate(samples: readonly TelemetrySample[]): EngineAggregate | null {
  const n1 = acc();
  const throttle = acc();
  const fuel = acc();
  let n1Max: number | null = null;
  let throttleMax: number | null = null;
  let fuelMax: number | null = null;
  let reverse: boolean | null = null;
  let engineSamples = 0;
  const modes = new Map<EngineMode, number>();

  for (const sample of samples) {
    const active = activeEngineIndexes(sample);
    const n1Values = engineValues(sample, sample.n1_percent, active, false).filter(
      (value) => value > 0,
    );
    const throttleValues = engineValues(sample, sample.throttle_percent, active, true);
    const fuelValues = engineValues(sample, sample.fuel_flow_pph, active, true);

    for (const value of n1Values) {
      push(n1, value);
      n1Max = n1Max === null ? value : Math.max(n1Max, value);
    }
    for (const value of throttleValues) {
      push(throttle, value);
      throttleMax = throttleMax === null ? value : Math.max(throttleMax, value);
    }
    for (const value of fuelValues) {
      push(fuel, value);
      fuelMax = fuelMax === null ? value : Math.max(fuelMax, value);
    }
    if (sample.reverse_engaged === true) reverse = true;
    else if (sample.reverse_engaged === false && reverse === null) reverse = false;
    if (sample.engine_mode) {
      modes.set(sample.engine_mode, (modes.get(sample.engine_mode) ?? 0) + 1);
    }
    if (
      n1Values.length > 0 ||
      throttleValues.length > 0 ||
      fuelValues.length > 0 ||
      sample.reverse_engaged !== null && sample.reverse_engaged !== undefined ||
      sample.engine_mode !== null && sample.engine_mode !== undefined
    ) {
      engineSamples += 1;
    }
  }

  if (engineSamples === 0) return null;
  return {
    mode: reverse === true ? 'reverse' : dominantEngineMode(modes),
    samples: engineSamples,
    n1_mean_percent: round(mean(n1), 1),
    n1_max_percent: round(n1Max, 1),
    throttle_mean_percent: round(mean(throttle), 1),
    throttle_max_percent: round(throttleMax, 1),
    reverse_engaged: reverse,
    reverse_duration_s: null,
    fuel_flow_pph_mean: round(mean(fuel), 1),
    fuel_flow_pph_max: round(fuelMax, 1),
    duration_s: null,
  };
}

function engineAggregateAtAgl(
  window: readonly TelemetrySample[],
  targetAgl: number,
): EngineAggregate | null {
  let nearest: TelemetrySample | null = null;
  let nearestDelta = Number.POSITIVE_INFINITY;
  const band: TelemetrySample[] = [];
  for (const sample of window) {
    const agl = finite(sample.agl_ft);
    if (agl === null) continue;
    const delta = Math.abs(agl - targetAgl);
    if (delta <= ENGINE_ALT_BAND_FT) band.push(sample);
    if (delta < nearestDelta) {
      nearestDelta = delta;
      nearest = sample;
    }
  }
  if (band.length > 0) return engineAggregate(band);
  return nearest ? engineAggregate([nearest]) : null;
}

function engineAggregateNearTouchdown(
  window: readonly TelemetrySample[],
  touchdown: TelemetrySample,
): EngineAggregate | null {
  const tdMs = Date.parse(touchdown.ts);
  if (!Number.isFinite(tdMs)) return engineAggregate([touchdown]);
  const samples = window.filter((sample) => {
    const ms = Date.parse(sample.ts);
    return Number.isFinite(ms) && tdMs - ms <= ENGINE_TOUCHDOWN_WINDOW_S * 1000 && ms <= tdMs;
  });
  if (!samples.some((sample) => sample.ts === touchdown.ts)) samples.push(touchdown);
  return engineAggregate(samples);
}

/**
 * Детерминированная классификация кадра в фазу для агрегатов рейса
 * (`stats.phases`, llm-debrief-prompt.md). Не заменяет state machine фаз —
 * только группирует метрики. `null` — кадр на земле.
 */
export function classifyPhase(sample: TelemetrySample): PhaseClass | null {
  if (sample.on_ground) return null;
  const agl = finite(sample.agl_ft);
  const vs = finite(sample.vs_fpm);
  // Набор высоты — никогда не заход (проверка VS до AGL): иначе взлёт/уход на
  // второй круг в пределах 3000 ft AGL попадали в окно захода и портили
  // агрегаты стабилизации (A2).
  if (vs !== null && vs > 100) return agl !== null && agl <= 2000 ? 'takeoff' : 'climb';
  if (agl !== null && agl <= 3000) return 'approach';
  if (vs === null) return null;
  if (vs < -100) return 'descent';
  return 'cruise';
}

/** Угловая разница направлений ветра с учётом круга (0..180). */
function angleDelta(a: number, b: number): number {
  const diff = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return diff;
}

function isStabilized(sample: TelemetrySample): boolean | null {
  if (typeof sample.gear_down !== 'boolean') return null;
  const bank = finite(sample.bank_deg);
  if (!sample.gear_down) return false;
  if (bank === null || Math.abs(bank) > STABILIZED_BANK_MAX_DEG) return false;
  const flaps = finite(sample.flaps_percent);
  if (flaps !== null && flaps < STABILIZED_FLAPS_MIN_PERCENT) return false;
  return true;
}

/**
 * WAVE 4 (FOQA): детерминированный сборщик агрегатов рейса и per-landing
 * анализа. Без I/O, `Date.now`/`Math.random` — только арифметика над сэмплами.
 *
 * Per-landing анализ (`landings.analysis`) считается по окну последних
 * `APPROACH_WINDOW_S` секунд перед касанием; агрегаты рейса (`stats.phases`,
 * `stats.stability`, `stats.events`) накапливаются по всему рейсу.
 */
export class FlightAnalysis {
  private readonly recent: TelemetrySample[] = [];
  private readonly events: Array<{ type: FlightEventType; ts: string }> = [];
  private readonly analysisBySeq = new Map<number, LandingAnalysis>();
  /**
   * Наземные сэмплы для измерения датума AGL (FOQA-DATUM-1): сдвиг опорной
   * точки над землёй. Копится по всему рейсу (стоянка на старте, пробег после
   * посадки), чтобы к моменту касания калибровка уже была доступна.
   */
  private readonly groundHeights: GroundHeightSample[] = [];
  /** ENGINE-MODE: активный пробег после касания и готовые агрегаты по seq. */
  private activeRollout: EngineRolloutState | null = null;
  private readonly rolloutsBySeq = new Map<number, EngineAggregate>();

  private readonly takeoffVs = acc();
  private readonly takeoffPitch = acc();
  private readonly climbIas = acc();
  private readonly climbVs = acc();
  private readonly cruiseGs = acc();
  private readonly descentVs = acc();
  private readonly approachGs = acc();

  private maxAltFt: number | null = null;
  private maxDescentIas: number | null = null;
  private gsAt1000: number | null = null;
  private gsAt500: number | null = null;
  private vsAt1000: number | null = null;
  private vsAt500: number | null = null;
  private stabilized1000: boolean | null = null;
  private stabilized500: boolean | null = null;
  /** Сэмплы финального окна 1000→500 ft AGL для `bankWindowStats`. */
  private bankWindowSamples: TelemetrySample[] = [];
  private bankWindowActive = false;
  private approachPrevAgl: number | null = null;
  /** Предыдущий воздушный сэмпл захода — нужен как «до пересечения 1000». */
  private approachPrevSample: TelemetrySample | null = null;
  private vsMinBelow1000: number | null = null;
  private vsMaxBelow1000: number | null = null;

  reset(): void {
    this.recent.length = 0;
    this.events.length = 0;
    this.analysisBySeq.clear();
    this.groundHeights.length = 0;
    this.activeRollout = null;
    this.rolloutsBySeq.clear();
    for (const accumulator of [
      this.takeoffVs,
      this.takeoffPitch,
      this.climbIas,
      this.climbVs,
      this.cruiseGs,
      this.descentVs,
      this.approachGs,
    ]) {
      accumulator.count = 0;
      accumulator.sum = 0;
    }
    this.maxAltFt = null;
    this.maxDescentIas = null;
    this.gsAt1000 = null;
    this.gsAt500 = null;
    this.vsAt1000 = null;
    this.vsAt500 = null;
    this.stabilized1000 = null;
    this.stabilized500 = null;
    this.bankWindowSamples = [];
    this.bankWindowActive = false;
    this.approachPrevAgl = null;
    this.approachPrevSample = null;
    this.vsMinBelow1000 = null;
    this.vsMaxBelow1000 = null;
  }

  /** Накопить кадр (после определения фазы рекордером). */
  onSample(sample: TelemetrySample): void {
    const alt = finite(sample.alt_ft);
    if (alt !== null) this.maxAltFt = this.maxAltFt === null ? alt : Math.max(this.maxAltFt, alt);

    // FOQA-DATUM-1: копим наземные сэмплы для измерения датума AGL. Фильтр по
    // скорости делает сам `measureAglDatumOffset` (наземный разбег/пробег выше
    // порога отбрасывается), здесь важна только память.
    if (sample.on_ground) {
      this.groundHeights.push({
        on_ground: true,
        groundspeed_kt: sample.gs_kt,
        agl_ft: sample.agl_ft,
      });
      if (this.groundHeights.length > AGL_DATUM_MAX_SAMPLES) {
        this.groundHeights.splice(0, this.groundHeights.length - AGL_DATUM_MAX_SAMPLES);
      }
    }

    const phase = classifyPhase(sample);
    switch (phase) {
      case 'takeoff':
        push(this.takeoffVs, sample.vs_fpm);
        push(this.takeoffPitch, sample.pitch_deg);
        break;
      case 'climb':
        push(this.climbIas, sample.ias_kt);
        push(this.climbVs, sample.vs_fpm);
        break;
      case 'cruise':
        push(this.cruiseGs, sample.gs_kt);
        break;
      case 'descent': {
        push(this.descentVs, sample.vs_fpm);
        const ias = finite(sample.ias_kt);
        if (ias !== null) this.maxDescentIas = Math.max(this.maxDescentIas ?? ias, ias);
        break;
      }
      case 'approach':
        this.onApproachSample(sample);
        break;
      default:
        break;
    }

    this.pushRecent(sample);
    this.onRolloutSample(sample);
  }

  /**
   * ENGINE-MODE rollout: копим наземные кадры после касания до полной остановки
   * (gs < 30 kt и реверс выключен), ухода в воздух или `ROLLOUT_MAX_S`.
   * Включает кадр касания, поэтому `duration_s` считается от него.
   */
  private onRolloutSample(sample: TelemetrySample): void {
    const rollout = this.activeRollout;
    if (!rollout) return;
    const ms = Date.parse(sample.ts);
    if (!Number.isFinite(ms)) return;
    const elapsed = ms - rollout.touchdownMs;
    if (!sample.on_ground) {
      this.finishRollout(ms);
      return;
    }
    if (elapsed > ROLLOUT_MAX_S * 1000) {
      this.finishRollout(ms);
      return;
    }
    // Кадр касания уже добавлен в `onTouchdown`; остальные — здесь.
    if (ms > rollout.touchdownMs) rollout.samples.push(sample);
    rollout.lastGroundMs = ms;
    const gs = finite(sample.gs_kt);
    if (
      elapsed >= ROLLOUT_MIN_S * 1000 &&
      gs !== null &&
      gs < ROLLOUT_END_GS_KT &&
      sample.reverse_engaged !== true
    ) {
      this.finishRollout(ms);
    }
  }

  private finishRollout(atMs: number): void {
    const rollout = this.activeRollout;
    if (!rollout) return;
    this.activeRollout = null;
    const aggregate = engineAggregate(rollout.samples);
    if (!aggregate) return;
    const lastGround = rollout.lastGroundMs ?? atMs;
    const duration = (lastGround - rollout.touchdownMs) / 1000;
    const reverseTimes: number[] = [];
    for (const sample of rollout.samples) {
      if (sample.reverse_engaged !== true) continue;
      const ms = Date.parse(sample.ts);
      if (Number.isFinite(ms)) reverseTimes.push(ms);
    }
    const reverseDuration =
      reverseTimes.length === 0
        ? null
        : (reverseTimes[reverseTimes.length - 1]! - reverseTimes[0]!) / 1000;
    this.rolloutsBySeq.set(rollout.seq, {
      ...aggregate,
      reverse_engaged: reverseTimes.length > 0 ? true : aggregate.reverse_engaged,
      reverse_duration_s: round(reverseDuration, 1),
      duration_s: round(duration >= 0 ? duration : null, 1),
    });
  }

  private onApproachSample(sample: TelemetrySample): void {
    push(this.approachGs, sample.gs_kt);
    const agl = finite(sample.agl_ft);

    if (agl === null) return;
    if (agl <= 1000) {
      const vs = finite(sample.vs_fpm);
      if (vs !== null) {
        this.vsMinBelow1000 = this.vsMinBelow1000 === null ? vs : Math.min(this.vsMinBelow1000, vs);
        this.vsMaxBelow1000 = this.vsMaxBelow1000 === null ? vs : Math.max(this.vsMaxBelow1000, vs);
      }
    }

    const prev = this.approachPrevAgl;
    const prevSample = this.approachPrevSample;
    this.approachPrevAgl = agl;
    this.approachPrevSample = sample;
    if (prev === null) return;

    // Финальное окно 1000→500 ft AGL для крена: копим от пересечения 1000 вниз
    // до пересечения 500 вниз (последнее окно перед касанием). Крен считаем
    // эпизодами, а не кадрами (A2). Сэмпл «до 1000» нужен `bankWindowStats`,
    // чтобы увидеть само пересечение вниз.
    if (prev > 1000 && agl <= 1000) {
      this.bankWindowSamples = prevSample ? [prevSample, sample] : [sample];
      this.bankWindowActive = true;
    } else if (this.bankWindowActive) {
      this.bankWindowSamples.push(sample);
    }
    if (prev > 500 && agl <= 500) this.bankWindowActive = false;

    // Пересечение контрольной высоты вниз (prev > H ≥ agl).
    const gs = finite(sample.gs_kt);
    const vs = finite(sample.vs_fpm);
    if (prev > 1000 && agl <= 1000) {
      if (gs !== null) this.gsAt1000 = gs;
      if (vs !== null) this.vsAt1000 = vs;
      const stabilized = isStabilized(sample);
      if (stabilized !== null) this.stabilized1000 = stabilized;
    }
    if (prev > 500 && agl <= 500) {
      if (gs !== null) this.gsAt500 = gs;
      if (vs !== null) this.vsAt500 = vs;
      const stabilized = isStabilized(sample);
      if (stabilized !== null) this.stabilized500 = stabilized;
    }
  }

  private pushRecent(sample: TelemetrySample): void {
    this.recent.push(sample);
    if (this.recent.length > APPROACH_WINDOW_MAX) {
      this.recent.splice(0, this.recent.length - APPROACH_WINDOW_MAX);
    }
    const cutoff = Date.parse(sample.ts) - APPROACH_WINDOW_S * 1000;
    if (Number.isFinite(cutoff)) {
      let drop = 0;
      while (drop < this.recent.length && Date.parse(this.recent[drop]!.ts) < cutoff) drop += 1;
      if (drop > 0) this.recent.splice(0, drop);
    }
  }

  /** Зафиксировать событие рейса (для `stats.events`, привязка к касанию позже). */
  onEvent(type: FlightEventType, ts: string): void {
    this.events.push({ type, ts });
    if (this.events.length > 128) this.events.splice(0, this.events.length - 128);
  }

  /**
   * Финализировать per-landing анализ на касании. `seq` — порядок посадки.
   * Идемпотентно: повторный вызов с тем же `seq` перезаписывает результат.
   */
  onTouchdown(seq: number, sample: TelemetrySample, liftoffAt: string | null): void {
    if (this.activeRollout) {
      this.finishRollout(this.activeRollout.lastGroundMs ?? Date.parse(sample.ts));
    }
    const analysis = this.buildLandingAnalysis(sample, liftoffAt);
    this.analysisBySeq.set(seq, analysis);
    const ms = Date.parse(sample.ts);
    this.activeRollout = Number.isFinite(ms)
      ? {
          seq,
          touchdownMs: ms,
          samples: [sample],
          lastGroundMs: ms,
        }
      : null;
  }

  /** Per-landing анализ по `seq` (только по завершённым касаниям). */
  getLandingAnalysis(seq: number): LandingAnalysis | undefined {
    return this.analysisBySeq.get(seq);
  }

  /** Все per-landing анализы (карта `seq → analysis`). */
  get allLandingAnalysis(): ReadonlyMap<number, LandingAnalysis> {
    return this.analysisBySeq;
  }

  private windowBefore(touchdown: TelemetrySample): TelemetrySample[] {
    const tdMs = Date.parse(touchdown.ts);
    return this.recent.filter((item) => {
      const ms = Date.parse(item.ts);
      return Number.isFinite(ms) && ms <= tdMs;
    });
  }

  private buildLandingAnalysis(
    touchdown: TelemetrySample,
    liftoffAt: string | null,
  ): LandingAnalysis {
    const window = this.windowBefore(touchdown);
    // FOQA-DATUM-1: датум-сдвиг (высота опорной точки над землёй) по наземной
    // площадке рейса. `null` — не измерим (старт в воздухе, нет площадки), тогда
    // высоты колёс отдаются как `null`, а не как завышенная высота опорной точки.
    const datumOffsetFt = measureAglDatumOffset(this.groundHeights);
    const flare = flareStats(window, touchdown, liftoffAt);
    const radioHeightFt = finite(touchdown.radio_height_ft);
    const flareWheel = toWheelHeightFt(flare.flare_height_ft, datumOffsetFt);
    const radioWheel = toWheelHeightFt(radioHeightFt, datumOffsetFt);

    const analysis: LandingAnalysis = {
      version: LANDING_ANALYSIS_VERSION,
      config_at_1000ft: snapshotAtAgl(window, 1000),
      config_at_500ft: snapshotAtAgl(window, 500),
      ap_disconnect_agl_ft: disconnectAgl(window, 'autopilot_master'),
      at_disconnect_agl_ft: disconnectAgl(window, 'autothrottle_active'),
      flare_height_ft: flare.flare_height_ft,
      flare_duration_s: flare.flare_duration_s,
      ils: ilsStats(window),
      aoa_touchdown_deg: aoaDeg(touchdown),
      aoa_max_near_touchdown_deg: maxAoaNearTouchdown(window, touchdown),
      cg_percent_touchdown: finite(touchdown.cg_percent),
      surface_condition: touchdown.surface_condition ?? null,
      surface_type: touchdown.surface_type ?? null,
      on_any_runway: touchdown.on_any_runway ?? null,
      touchdown_point: touchdownPoint(touchdown),
      radio_height_touchdown_ft: radioHeightFt,
      agl_datum_offset_ft: datumOffsetFt,
      agl_datum_version: AGL_DATUM_VERSION,
      height_datum_calibrated: datumOffsetFt !== null,
      flare_height_wheel_ft: flareWheel.value,
      wheel_height_touchdown_ft: radioWheel.value,
      engine_at_1000ft: engineAggregateAtAgl(window, 1000),
      engine_at_500ft: engineAggregateAtAgl(window, 500),
      engine_touchdown: engineAggregateNearTouchdown(window, touchdown),
      engine_rollout: null,
      wind_shear: windShear(window, touchdown),
      series: buildSeries(window, touchdown),
    };
    return landingAnalysisSchema.parse(analysis);
  }

  /**
   * Итоговые агрегаты рейса. `touchdownTs` — время представительной посадки для
   * привязки событий `at_sec_from_touchdown`; `null` — касаний нет.
   */
  finalize(touchdownTs: string | null): {
    phases: FlightPhaseStats;
    stability: FlightStabilityStats;
    events: FlightTrendEvent[] | null;
  } {
    this.flushRollouts();
    const sinkRate =
      this.vsAt1000 !== null && this.vsAt500 !== null
        ? (this.vsAt1000 + this.vsAt500) / 2
        : null;
    const vsVariation =
      this.vsMinBelow1000 !== null && this.vsMaxBelow1000 !== null
        ? this.vsMaxBelow1000 - this.vsMinBelow1000
        : null;
    const gsVariation =
      this.gsAt1000 !== null && this.gsAt500 !== null
        ? Math.abs(this.gsAt1000 - this.gsAt500)
        : null;
    const bank = bankWindowStats(this.bankWindowSamples);

    return {
      phases: {
        takeoff: {
          vs_mean_fpm: round(mean(this.takeoffVs), 1),
          pitch_mean_deg: round(mean(this.takeoffPitch), 2),
        },
        climb: {
          avg_ias_kt: round(mean(this.climbIas), 1),
          avg_vs_fpm: round(mean(this.climbVs), 1),
        },
        cruise: {
          altitude_ft: round(this.maxAltFt, 0),
          avg_gs_kt: round(mean(this.cruiseGs), 1),
        },
        descent: {
          avg_vs_fpm: round(mean(this.descentVs), 1),
          max_ias_kt: round(this.maxDescentIas, 1),
        },
        approach: {
          avg_gs_kt: round(mean(this.approachGs), 1),
          gs_at_1000ft_kt: round(this.gsAt1000, 1),
          gs_at_500ft_kt: round(this.gsAt500, 1),
          sink_rate_1000_500_fpm: round(sinkRate, 1),
        },
      },
      stability: {
        stabilized_by_1000ft: this.stabilized1000,
        stabilized_by_500ft: this.stabilized500,
        gs_variation_kt_1000_500: round(gsVariation, 1),
        vertical_speed_variation_fpm: round(vsVariation, 1),
        bank_excursions_count: bank?.episodes ?? null,
        bank_max_deg_1000_500: bank ? round(bank.maxAbsDeg, 1) : null,
        stability_version: 2,
      },
      events: buildEvents(this.events, touchdownTs),
    };
  }

  /**
   * Финализирует активный пробег и вкл��чает `engine_rollout` в per-landing
   * анализ. Идемпотентно: готовые агрегаты применяются повторно.
   */
  private flushRollouts(): void {
    if (this.activeRollout) {
      this.finishRollout(this.activeRollout.lastGroundMs ?? this.activeRollout.touchdownMs);
    }
    for (const [seq, rollout] of this.rolloutsBySeq) {
      const analysis = this.analysisBySeq.get(seq);
      if (!analysis) continue;
      this.analysisBySeq.set(
        seq,
        landingAnalysisSchema.parse({ ...analysis, engine_rollout: rollout }),
      );
    }
  }
}

function buildEvents(
  events: ReadonlyArray<{ type: FlightEventType; ts: string }>,
  touchdownTs: string | null,
): FlightTrendEvent[] | null {
  if (events.length === 0) return null;
  const tdMs = touchdownTs ? Date.parse(touchdownTs) : Number.NaN;
  const out: FlightTrendEvent[] = [];
  for (const event of events) {
    if (!Number.isFinite(tdMs)) {
      out.push({ type: event.type, at_sec_from_touchdown: 0 });
      continue;
    }
    const ms = Date.parse(event.ts);
    if (!Number.isFinite(ms)) continue;
    out.push({
      type: event.type,
      at_sec_from_touchdown: Math.round(((ms - tdMs) / 1000) * 10) / 10,
    });
    if (out.length >= 64) break;
  }
  return out.length > 0 ? out : null;
}

function snapshotAtAgl(
  window: readonly TelemetrySample[],
  targetAgl: number,
): LandingAnalysis['config_at_1000ft'] {
  let best: TelemetrySample | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const sample of window) {
    const agl = finite(sample.agl_ft);
    if (agl === null) continue;
    const delta = Math.abs(agl - targetAgl);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = sample;
    }
  }
  if (!best) return null;
  return {
    flaps_percent: finite(best.flaps_percent),
    spoilers_percent: finite(best.spoilers_percent),
    spoilers_armed: best.spoilers_armed ?? null,
    gear_down: best.gear_down ?? null,
    autopilot_master: best.autopilot_master ?? null,
    autothrottle_active: best.autothrottle_active ?? null,
  };
}

function disconnectAgl(
  window: readonly TelemetrySample[],
  field: 'autopilot_master' | 'autothrottle_active',
): number | null {
  let lastOnIndex = -1;
  for (let i = 0; i < window.length; i += 1) {
    if (window[i]![field] === true) lastOnIndex = i;
  }
  if (lastOnIndex === -1) return null;
  for (let i = lastOnIndex + 1; i < window.length; i += 1) {
    if (window[i]![field] === false) return finite(window[i]!.agl_ft);
  }
  return null;
}

function flareStats(
  window: readonly TelemetrySample[],
  touchdown: TelemetrySample,
  _liftoffAt: string | null,
): { flare_height_ft: number | null; flare_duration_s: number | null } {
  const tdMs = Date.parse(touchdown.ts);
  for (const sample of window) {
    const agl = finite(sample.agl_ft);
    const vs = finite(sample.vs_fpm);
    if (agl === null || vs === null) continue;
    if (agl <= FLARE_MAX_AGL_FT && vs >= FLARE_VS_FPM) {
      const ms = Date.parse(sample.ts);
      const duration = Number.isFinite(tdMs) && Number.isFinite(ms) ? (tdMs - ms) / 1000 : null;
      return {
        flare_height_ft: agl,
        flare_duration_s: round(duration, 2),
      };
    }
  }
  return { flare_height_ft: null, flare_duration_s: null };
}

/**
 * Tri-state aggregate of a validity flag: `true` if any sample observed it,
 * `false` only if some sample explicitly reported invalid and none valid,
 * `null` when the sim never exposed the flag (honest unknown, e.g. X-Plane).
 * Never coerces unknown → `false` (analysis/1 additive relaxation).
 */
function triOr(current: boolean | null, value: boolean | null | undefined): boolean | null {
  if (value === true) return true;
  if (value === false && current === null) return false;
  return current;
}

function ilsStats(window: readonly TelemetrySample[]): LandingAnalysis['ils'] {
  let samples = 0;
  let cdiValid: boolean | null = null;
  let gsiValid: boolean | null = null;
  let hasLocalizer: boolean | null = null;
  let maxAbsCdi: number | null = null;
  let maxAbsGsi: number | null = null;
  let minGse: number | null = null;
  let maxGse: number | null = null;

  for (const sample of window) {
    const localizer = sample.hsi_has_localizer === true;
    hasLocalizer = triOr(hasLocalizer, sample.hsi_has_localizer);
    const cdi = finite(sample.hsi_cdi_needle);
    const gsi = finite(sample.hsi_gsi_needle);
    const cdiUsable = cdi !== null && sample.hsi_cdi_needle_valid !== false;
    const gsiUsable = gsi !== null && sample.hsi_gsi_needle_valid !== false;
    cdiValid = triOr(cdiValid, sample.hsi_cdi_needle_valid);
    gsiValid = triOr(gsiValid, sample.hsi_gsi_needle_valid);
    const gse = finite(sample.nav_glide_slope_error_deg);

    if (localizer || cdiUsable || gsiUsable || gse !== null) samples += 1;
    if (cdiUsable) maxAbsCdi = Math.max(maxAbsCdi ?? 0, Math.abs(cdi));
    if (gsiUsable) maxAbsGsi = Math.max(maxAbsGsi ?? 0, Math.abs(gsi));
    if (gse !== null) {
      minGse = minGse === null ? gse : Math.min(minGse, gse);
      maxGse = maxGse === null ? gse : Math.max(maxGse, gse);
    }
  }

  if (samples === 0) return null;
  return {
    samples,
    max_abs_cdi: round(maxAbsCdi),
    max_abs_gsi: round(maxAbsGsi),
    min_glide_slope_error_deg: round(minGse),
    max_glide_slope_error_deg: round(maxGse),
    cdi_valid: cdiValid,
    gsi_valid: gsiValid,
    has_localizer: hasLocalizer,
  };
}

function aoaDeg(sample: TelemetrySample): number | null {
  const rad = finite(sample.incidence_alpha_rad);
  return rad === null ? null : round(rad * RAD_TO_DEG, 2);
}

function maxAoaNearTouchdown(
  window: readonly TelemetrySample[],
  touchdown: TelemetrySample,
): number | null {
  const tdMs = Date.parse(touchdown.ts);
  let max: number | null = null;
  for (const sample of window) {
    const ms = Date.parse(sample.ts);
    if (!Number.isFinite(ms) || !Number.isFinite(tdMs) || tdMs - ms > AOA_NEAR_TD_S * 1000) continue;
    const value = aoaDeg(sample);
    if (value !== null) max = max === null ? value : Math.max(max, value);
  }
  const td = aoaDeg(touchdown);
  if (td !== null) max = max === null ? td : Math.max(max, td);
  return max;
}

function touchdownPoint(sample: TelemetrySample): LandingAnalysis['touchdown_point'] {
  const values = {
    relative_x_m: finite(sample.atc_runway_relative_x_m),
    relative_z_m: finite(sample.atc_runway_relative_z_m),
    aiming_x_m: finite(sample.atc_runway_tdpoint_relative_x_m),
    aiming_z_m: finite(sample.atc_runway_tdpoint_relative_z_m),
    start_distance_m: finite(sample.atc_runway_start_distance_m),
    end_distance_m: finite(sample.atc_runway_end_distance_m),
    heading_deg_true: finite(sample.atc_runway_heading_deg),
    length_m: finite(sample.atc_runway_length_m),
    width_m: finite(sample.atc_runway_width_m),
  };
  return Object.values(values).some((value) => value !== null) ? values : null;
}

function windShear(
  window: readonly TelemetrySample[],
  touchdown: TelemetrySample,
): LandingAnalysis['wind_shear'] {
  const tdMs = Date.parse(touchdown.ts);
  const recent = window.filter((sample) => {
    const ms = Date.parse(sample.ts);
    return Number.isFinite(ms) && Number.isFinite(tdMs) && tdMs - ms <= WIND_SHEAR_WINDOW_S * 1000;
  });
  let maxSpeedDelta: number | null = null;
  let maxDirDelta: number | null = null;
  let samples = 0;
  let prevSpeed: number | null = null;
  let prevDir: number | null = null;
  for (const sample of recent) {
    const speed = finite(sample.wind_speed_kt);
    const dir = finite(sample.wind_dir_deg);
    samples += 1;
    if (speed !== null && prevSpeed !== null) {
      maxSpeedDelta = Math.max(maxSpeedDelta ?? 0, Math.abs(speed - prevSpeed));
    }
    if (dir !== null && prevDir !== null) {
      maxDirDelta = Math.max(maxDirDelta ?? 0, angleDelta(dir, prevDir));
    }
    prevSpeed = speed;
    prevDir = dir;
  }
  if (samples === 0) return null;
  return {
    samples,
    max_wind_speed_delta_kt: round(maxSpeedDelta, 1),
    max_wind_dir_delta_deg: round(maxDirDelta, 1),
  };
}

function buildSeries(
  window: readonly TelemetrySample[],
  touchdown: TelemetrySample,
): LandingAnalysis['series'] {
  const tdMs = Date.parse(touchdown.ts);
  const points = window.filter((sample) => {
    const ms = Date.parse(sample.ts);
    return Number.isFinite(ms) && Number.isFinite(tdMs) && tdMs - ms <= SERIES_WINDOW_S * 1000;
  });

  const ilsCdi: LandingAnalysisSeriesPoint[] = [];
  const ilsGsi: LandingAnalysisSeriesPoint[] = [];
  const aoa: LandingAnalysisSeriesPoint[] = [];
  const flaps: LandingAnalysisSeriesPoint[] = [];
  let lastT = Number.NEGATIVE_INFINITY;

  for (const sample of points) {
    const ms = Date.parse(sample.ts);
    const t = (ms - tdMs) / 1000;
    if (t - lastT < SERIES_STEP_S) continue;
    lastT = t;
    const tRounded = round(t, 1) ?? 0;
    ilsCdi.push({ t_s: tRounded, value: finite(sample.hsi_cdi_needle) });
    ilsGsi.push({ t_s: tRounded, value: finite(sample.hsi_gsi_needle) });
    aoa.push({ t_s: tRounded, value: aoaDeg(sample) });
    flaps.push({ t_s: tRounded, value: finite(sample.flaps_percent) });
  }

  return { ils_cdi: ilsCdi, ils_gsi: ilsGsi, aoa_deg: aoa, flaps_percent: flaps };
}
