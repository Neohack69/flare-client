import type { EngineMode } from '@flightlog/contracts';

/**
 * ENGINE-MODE: пороги «малый газ»/«максимум» для честного режима.
 *
 * Калибровать N1 относительно max N1 конкретного ВС нельзя (нет max N1 в
 * телеметрии), поэтому `climb`/`cruise`/`approach` не выводятся. Режим
 * определяется только однозначными сигналами:
 * - реверс включён → `reverse`;
 * - тяга ≤ 10 % (у турбин idle часто 6..9 %, live X-Plane 12.4.3: 8.2 %) → `idle`;
 * - тяга ≥ 95 % и ВС на земле → `takeoff_thrust`;
 * - иначе → `unknown` (сырые N1/тяга остаются в сэмпле для AI).
 */
export const ENGINE_IDLE_THROTTLE_MAX_PERCENT = 10;
export const ENGINE_TAKEOFF_THROTTLE_MIN_PERCENT = 95;

/** N1 (%), выше которого двигатель считается работающим (согласовано с adapter). */
export const ENGINE_RUNNING_N1_MIN_PERCENT = 5;

export interface EngineModeInput {
  engineRunning: boolean;
  onGround: boolean;
  n1Percent?: ReadonlyArray<number | null> | null;
  throttlePercent?: ReadonlyArray<number | null> | null;
  /** `true` — реверс точно включён; `null`/`false` — сигнала нет/выключен. */
  reverseEngaged?: boolean | null;
}

/** Индексы работающих двигателей (N1 > 5 %); пусто — N1 нет/все стоят. */
export function runningEngineIndexes(
  n1Percent: ReadonlyArray<number | null> | null | undefined,
): number[] {
  if (!Array.isArray(n1Percent)) return [];
  const indexes: number[] = [];
  for (let index = 0; index < n1Percent.length; index += 1) {
    const value = n1Percent[index];
    if (typeof value === 'number' && Number.isFinite(value) && value > ENGINE_RUNNING_N1_MIN_PERCENT) {
      indexes.push(index);
    }
  }
  return indexes;
}

/** Максимальная тяга по работающим двигателям (fallback — все непустые). */
export function maxThrottlePercent(
  throttlePercent: ReadonlyArray<number | null> | null | undefined,
  activeIndexes: readonly number[] = [],
): number | null {
  if (!Array.isArray(throttlePercent)) return null;
  let max: number | null = null;
  for (let index = 0; index < throttlePercent.length; index += 1) {
    if (activeIndexes.length > 0 && !activeIndexes.includes(index)) continue;
    const value = throttlePercent[index];
    if (typeof value === 'number' && Number.isFinite(value)) {
      max = max === null ? value : Math.max(max, value);
    }
  }
  return max;
}

/** Честный режим двигателя по кадру. */
export function deriveEngineMode(input: EngineModeInput): EngineMode {
  if (input.reverseEngaged === true) return 'reverse';
  if (!input.engineRunning) return 'unknown';

  const active = runningEngineIndexes(input.n1Percent);
  const throttle = maxThrottlePercent(input.throttlePercent, active);
  if (throttle === null) return 'unknown';
  if (throttle <= ENGINE_IDLE_THROTTLE_MAX_PERCENT) return 'idle';
  if (throttle >= ENGINE_TAKEOFF_THROTTLE_MIN_PERCENT && input.onGround) return 'takeoff_thrust';
  return 'unknown';
}
