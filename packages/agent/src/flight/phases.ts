import { hasSampleFlightEvidence } from './liftoff.js';
import { isImplausiblePositionJump } from './teleport.js';

import type { TelemetrySample } from '../sim/types.js';

/**
 * Состояния полёта (T8). Соответствуют требованиям задачи:
 * `taxi` / `takeoff` / `airborne` / `landing` / `on_ground`.
 */
export const FLIGHT_PHASES = ['on_ground', 'taxi', 'takeoff', 'airborne', 'landing'] as const;
export type FlightPhase = (typeof FLIGHT_PHASES)[number];

export type PhaseTransitionReason =
  | 'ground_movement'
  | 'takeoff_roll'
  | 'liftoff'
  | 'approach'
  | 'go_around'
  | 'touchdown'
  | 'stopped'
  | 'aborted_takeoff';

export interface PhaseTransition {
  from: FlightPhase;
  to: FlightPhase;
  reason: PhaseTransitionReason;
  ts: string;
}

export interface PhaseDetectorOptions {
  /** Минимальная скорость для перехода в taxi (kt). */
  taxiSpeedKt: number;
  /** Скорость начала разбега (kt). */
  takeoffSpeedKt: number;
  /**
   * Высота **опорной точки** модели (не колёс, FOQA-DATUM-1), выше которой отрыв
   * считается подтверждённым (ft). При датум-сдвиге `D` фактическая высота колёс
   * = `liftoffAglFt − D` (A220: ≈0 ft при значении 10). Поведение намеренно не
   * менялось, чтобы не сдвигать существующие детекты (риск: ВС с крупным датумом
   * проходит порог по меньшей высоте колёс).
   */
  liftoffAglFt: number;
  /**
   * Высота **опорной точки** (не колёс), ниже которой начинается фаза захода на
   * посадку (ft). Датум-сдвиг здесь <2% — поведение оставлено как есть.
   */
  landingAglFt: number;
  /** Гистерезис для ухода на повторный круг (ft). */
  goAroundHysteresisFt: number;
  /**
   * «Арм-окно» старта сессии (с). Резервный критерий достоверного отрыва, когда
   * AGL и `vs_fpm` оба недоступны: устойчивый `on_ground=false` дольше окна.
   * Транзиентный `SIM ON GROUND=false` в первых кадрах сессии (ВС на земле) не
   * должен давать ложный отрыв/посадку.
   */
  armWindowS: number;
}

const DEFAULT_OPTIONS: PhaseDetectorOptions = {
  taxiSpeedKt: 3,
  takeoffSpeedKt: 45,
  liftoffAglFt: 10,
  landingAglFt: 500,
  goAroundHysteresisFt: 150,
  armWindowS: 3,
};

/**
 * Детерминированная state machine фаз полёта. Не содержит таймеров/случайности:
 * переходы зависят только от полей сэмпла, гистерезис — по значениям AGL.
 *
 * Телепорт-инвалидация: кадр `slew` и неправдоподобный скачок позиции помечают
 * сессию (`teleportedSinceGround`), и пока она помечена, переход в `airborne`
 * подавлен — slew, завершившийся в воздухе, не даёт ложную фазу отрыва. Флаг
 * снимает только обработанный наземный кадр.
 */
export class FlightPhaseDetector {
  private current: FlightPhase = 'on_ground';
  private readonly options: PhaseDetectorOptions;
  private airborneSinceMs: number | null = null;
  private previousSample: TelemetrySample | null = null;
  /**
   * Сессия «инвалидирована телепортом»: был slew/неправдоподобный скачок и с
   * тех пор не обработано ни одного наземного кадра. Пока флаг стоит, переход в
   * `airborne` подавлен (slew, завершившийся в воздухе, не даёт ложный отрыв).
   * Снимается только на обработанном кадре `on_ground === true`.
   */
  private teleportedSinceGround = false;

  constructor(options: Partial<PhaseDetectorOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get phase(): FlightPhase {
    return this.current;
  }

  reset(): void {
    this.current = 'on_ground';
    this.airborneSinceMs = null;
    this.previousSample = null;
    this.teleportedSinceGround = false;
  }

  update(sample: TelemetrySample): PhaseTransition | null {
    // Кадр slew (IS SLEW ACTIVE) — не полёт: пропускаем без изменения состояния,
    // `previousSample` остаётся до-slew кадром, чтобы поймать прыжок после slew off.
    // Сессия при этом инвалидируется до первого настоящего наземного кадра.
    if (sample.slew) {
      this.teleportedSinceGround = true;
      return null;
    }
    if (isImplausiblePositionJump(this.previousSample, sample)) {
      this.teleportedSinceGround = true;
      this.previousSample = sample;
      return null;
    }
    this.previousSample = sample;
    // Обработанный наземный кадр снимает инвалидацию (п. «clear only on ground»).
    if (sample.on_ground) this.teleportedSinceGround = false;
    this.trackStartWindow(sample);
    const next = this.nextPhase(sample);
    if (next === null || next === this.current) return null;
    // Телепорт/slew без наземного кадра — вход в `airborne` не подтверждается.
    if (next === 'airborne' && this.teleportedSinceGround) return null;
    const from = this.current;
    this.current = next;
    return { from, to: next, reason: reasonFor(from, next), ts: sample.ts };
  }

  private trackStartWindow(sample: TelemetrySample): void {
    const nowMs = Date.parse(sample.ts);
    if (!Number.isFinite(nowMs)) return;
    if (sample.on_ground) {
      this.airborneSinceMs = null;
    } else if (this.airborneSinceMs === null) {
      this.airborneSinceMs = nowMs;
    }
  }

  /**
   * Достоверный отрыв: высота выше порога **при движении/вертикальной динамике**,
   * полётная скорость или (при отсутствии обоих сигналов) устойчивый
   * `on_ground=false` дольше арм-окна. Защищает от транзиентного
   * `SIM ON GROUND=false` в первых кадрах сессии (bogus `agl`/`alt` при `gs≈0`).
   */
  private confirmedAirborne(sample: TelemetrySample): boolean {
    // Телепорт/slew без последующего наземного кадра — отрыв недостоверен.
    if (this.teleportedSinceGround) return false;
    const { agl_ft: agl, vs_fpm: vs } = sample;
    if (agl === null && vs === null) {
      const nowMs = Date.parse(sample.ts);
      const since = this.airborneSinceMs;
      return (
        Number.isFinite(nowMs) && since !== null && nowMs - since >= this.options.armWindowS * 1000
      );
    }
    return hasSampleFlightEvidence(sample, { altitudeFt: this.options.liftoffAglFt });
  }

  private nextPhase(sample: TelemetrySample): FlightPhase | null {
    const { agl_ft: agl, gs_kt: gs, engine_running: engine, on_ground: onGround } = sample;
    const { taxiSpeedKt, takeoffSpeedKt, liftoffAglFt, landingAglFt, goAroundHysteresisFt } =
      this.options;

    switch (this.current) {
      case 'on_ground':
        // Отрыв подтверждается только достоверным вертикальным сигналом (или
        // устойчивым `on_ground=false`), иначе транзиент на старте сессии дал бы
        // ложный `airborne` и последующую ложную посадку.
        if (!onGround) return this.confirmedAirborne(sample) ? 'airborne' : null;
        if (engine && gs >= takeoffSpeedKt) return 'takeoff';
        if (engine && gs >= taxiSpeedKt) return 'taxi';
        return null;

      case 'taxi':
        if (engine && gs >= takeoffSpeedKt) return 'takeoff';
        if (!engine && gs < taxiSpeedKt) return 'on_ground';
        // Вертолёты/СВВП: отрыв без достижения порога разбега.
        if (!onGround && agl !== null && agl > liftoffAglFt) return 'airborne';
        return null;

      case 'takeoff':
        if (!onGround && airborneByAgl(agl, sample.vs_fpm, liftoffAglFt)) return 'airborne';
        if (onGround && gs < taxiSpeedKt) return 'taxi';
        return null;

      case 'airborne':
        if (onGround) return 'on_ground';
        if (agl !== null && agl <= landingAglFt && (sample.vs_fpm === null || sample.vs_fpm <= 0)) {
          return 'landing';
        }
        return null;

      case 'landing':
        if (onGround) return 'on_ground';
        if (agl !== null && agl > landingAglFt + goAroundHysteresisFt) return 'airborne';
        if (sample.vs_fpm !== null && sample.vs_fpm > 150) return 'airborne';
        return null;
    }
  }
}

function airborneByAgl(agl: number | null, vsFpm: number | null, liftoffAglFt: number): boolean {
  if (agl !== null) return agl > liftoffAglFt;
  return vsFpm !== null && vsFpm > 0;
}

function reasonFor(from: FlightPhase, to: FlightPhase): PhaseTransitionReason {
  if (to === 'taxi') return from === 'takeoff' ? 'aborted_takeoff' : 'ground_movement';
  if (to === 'takeoff') return 'takeoff_roll';
  if (to === 'airborne') return from === 'landing' ? 'go_around' : 'liftoff';
  if (to === 'landing') return 'approach';
  return from === 'taxi' ? 'stopped' : 'touchdown';
}
