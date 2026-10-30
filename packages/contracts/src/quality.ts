import { z } from 'zod';

/**
 * `quality` — битовая маска точки/рейса (api.md §3.3.1). Неизвестные биты
 * сервер игнорирует (forward-compat); новые биты добавляются без смены API.
 */
export const QUALITY_BITS = {
  /**
   * Активен slew/телепорт. Точка исключается из расчёта скоринга; для допуска
   * в лидерборд значение имеет только slew в последние
   * `SLEW_ELIGIBILITY_WINDOW_S` секунд **до касания** (см. политику ниже).
   */
  SLEW: 1,
  /**
   * `ts` немонотонный/сдвинут. Информационный бит: точка исключается из
   * скоринга, но рейс/посадку из лидерборда **не** исключает.
   */
  CLOCK_INVALID: 2,
  /** Значение синтезировано/интерполировано — информационный бит (не гейтит). */
  INTERPOLATED: 4,
  /** Эффективная частота в окне ниже целевой — информационный бит (не гейтит). */
  LOW_RATE_WINDOW: 8,
  /** Перед точкой разрыв больше порога — информационный бит/`is_partial`. */
  GAP_BEFORE: 16,
  /** Окно/точка покрывает паузу сима — гейтит допуск в лидерборд. */
  PAUSED: 32,
} as const;

export type QualityFlag = keyof typeof QUALITY_BITS;
export type QualityBit = (typeof QUALITY_BITS)[QualityFlag];

/**
 * Slew/телепорт исключает посадку из лидерборда только внутри этого окна до
 * касания (5 минут). Slew раньше в рейсе (смена стоянки, репозиционирование)
 * остаётся помеченным в треке для прозрачности, но не гейтит.
 */
export const SLEW_ELIGIBILITY_WINDOW_S = 300;

/** Биты, исключающие точку из расчёта скоринга. */
export const QUALITY_VALUE_BITS: number =
  QUALITY_BITS.SLEW | QUALITY_BITS.CLOCK_INVALID | QUALITY_BITS.INTERPOLATED;

/**
 * Биты, которые реально лишают допуска в лидерборд: slew (в окне
 * `SLEW_ELIGIBILITY_WINDOW_S`) и пауза в окне касания. Остальные — заметки
 * о качестве записи (наши инфраструктурные проблемы), не препятствие.
 */
export const QUALITY_DISQUALIFYING_BITS: number = QUALITY_BITS.SLEW | QUALITY_BITS.PAUSED;

/** Информационные биты: видны в UI как «качество записи снижено», не гейтят. */
export const QUALITY_INFORMATIONAL_BITS: number =
  QUALITY_BITS.CLOCK_INVALID |
  QUALITY_BITS.INTERPOLATED |
  QUALITY_BITS.LOW_RATE_WINDOW |
  QUALITY_BITS.GAP_BEFORE;

/** Биты временной деградации: не исключают точку, влияют на confidence. */
export const QUALITY_TEMPORAL_BITS: number =
  QUALITY_BITS.LOW_RATE_WINDOW | QUALITY_BITS.GAP_BEFORE | QUALITY_BITS.PAUSED;

export const qualityFlagsSchema = z.number().int().min(0);
export type QualityFlags = z.output<typeof qualityFlagsSchema>;

export function hasQualityBit(mask: number, bit: number): boolean {
  return (mask & bit) !== 0;
}

export function hasAnyQualityBit(mask: number, bits: number): boolean {
  return (mask & bits) !== 0;
}

export function setQualityBit(mask: number, bit: number): number {
  return mask | bit;
}
