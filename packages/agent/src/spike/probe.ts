import { FlightPhaseDetector, type PhaseTransition } from '../flight/phases.js';
import { LandingTracker } from '../flight/touchdown.js';
import { SIMVAR_DEFINITION, type SimVarField } from '../sim/node-simconnect-adapter.js';
import type { TelemetrySample } from '../sim/types.js';

/**
 * CD-1 (Spike S2) — обязательный минимум SimVar для проверки связки
 * `node-simconnect` ↔ MSFS 2024: позиция, высота, скорости, `SIM ON GROUND`
 * и факт работы двигателя. Всё это — вход детекта фаз/касания.
 *
 * Имена SimVar не дублируются: они берутся из единственного источника —
 * `SIMVAR_DEFINITION` (`node-simconnect-adapter.ts`).
 */
export const SPIKE_REQUIRED_FIELDS = [
  'lat',
  'lon',
  'alt_ft',
  'agl_ft',
  'gs_kt',
  'vs_fpm',
  'on_ground',
  'engine_running',
] as const;

export type SpikeRequiredField = (typeof SPIKE_REQUIRED_FIELDS)[number];

export interface SpikeRequiredSimVar {
  field: SpikeRequiredField;
  name: string;
  unit: string | null;
}

const SIMVAR_BY_FIELD = new Map<SimVarField, { name: string; unit: string | null }>(
  SIMVAR_DEFINITION.map((def) => [def.field, { name: def.name, unit: def.unit }]),
);

export const SPIKE_REQUIRED_SIMVARS: readonly SpikeRequiredSimVar[] = SPIKE_REQUIRED_FIELDS.map(
  (field) => {
    const def = SIMVAR_BY_FIELD.get(field);
    if (!def) {
      throw new Error(`CD-1: SimVar для поля «${field}» отсутствует в SIMVAR_DEFINITION`);
    }
    return { field, name: def.name, unit: def.unit };
  },
);

/** Числовое представление поля сэмпла: boolean → 0/1, `null`/`NaN` → `null`. */
export function numericFieldValue(
  sample: TelemetrySample,
  field: SpikeRequiredField,
): number | null {
  const value = sample[field];
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/** Человекочитаемое значение поля сэмпла (включая невалидные). */
export function fieldDisplayValue(
  sample: TelemetrySample,
  field: SpikeRequiredField,
): string {
  const value = sample[field];
  if (value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'null';
  return Number.isFinite(value) ? String(value) : 'NaN';
}

export interface SpikeFieldStat {
  field: SpikeRequiredField;
  simvar: string;
  unit: string | null;
  /** Сколько сэмплов всего пришло за время проверки. */
  samples: number;
  /** Сколько сэмплов имели валидное (конечное/булево) значение. */
  valid: number;
  /** Валидное значение отсутствовало (`null`/`NaN`) в этом числе сэмплов. */
  invalid: number;
  min: number | null;
  max: number | null;
  /** Последнее валидное числовое значение (boolean → 0/1). */
  lastValue: number | null;
  /** Последнее «сырое» значение (для глаза: `NaN`/`null`/`true`). */
  lastDisplay: string | null;
  lastTs: string | null;
}

export interface SpikePhaseReport {
  transitions: PhaseTransition[];
  confirmedLiftoff: boolean;
  touchdownDetected: boolean;
  landings: number;
  lastScore: number | null;
  lastGrade: string | null;
}

export interface SpikeProbeSnapshot {
  sampleCount: number;
  firstTs: string | null;
  lastTs: string | null;
  /** Длительность окна наблюдения по клиентским меткам (с). */
  durationS: number | null;
  /** Измеренная частота прихода сэмплов (Гц). */
  rateHz: number | null;
  fields: SpikeFieldStat[];
  phases: SpikePhaseReport;
}

interface MutableFieldStat {
  field: SpikeRequiredField;
  simvar: string;
  unit: string | null;
  samples: number;
  valid: number;
  min: number | null;
  max: number | null;
  lastValue: number | null;
  lastDisplay: string | null;
  lastTs: string | null;
}

function createFieldStats(): MutableFieldStat[] {
  return SPIKE_REQUIRED_SIMVARS.map((def) => ({
    field: def.field,
    simvar: def.name,
    unit: def.unit,
    samples: 0,
    valid: 0,
    min: null,
    max: null,
    lastValue: null,
    lastDisplay: null,
    lastTs: null,
  }));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Наблюдатель за живой сессией SimConnect для Go/No-Go. Не делает I/O:
 * принимает уже нормализованные `TelemetrySample`, копит статистику по
 * обязательным SimVar и прогоняет существующие `FlightPhaseDetector`
 * (`flight/phases.ts`) и `LandingTracker` (`flight/touchdown.ts`).
 */
export class SpikeProbe {
  private readonly phaseDetector = new FlightPhaseDetector();
  private readonly landingTracker = new LandingTracker();
  private readonly stats = createFieldStats();
  private readonly transitionList: PhaseTransition[] = [];
  private sampleCountValue = 0;
  private firstTs: string | null = null;
  private lastTs: string | null = null;
  private firstTsMs: number | null = null;
  private lastTsMs: number | null = null;
  private lastScore: number | null = null;
  private lastGrade: string | null = null;

  get sampleCount(): number {
    return this.sampleCountValue;
  }

  handleSample(sample: TelemetrySample): void {
    this.sampleCountValue += 1;
    this.firstTs ??= sample.ts;
    this.lastTs = sample.ts;

    const tsMs = Date.parse(sample.ts);
    if (Number.isFinite(tsMs)) {
      this.firstTsMs ??= tsMs;
      this.lastTsMs = tsMs;
    }

    for (const stat of this.stats) {
      stat.samples += 1;
      stat.lastDisplay = fieldDisplayValue(sample, stat.field);
      stat.lastTs = sample.ts;
      const value = numericFieldValue(sample, stat.field);
      if (value === null) continue;
      stat.valid += 1;
      stat.min = stat.min === null ? value : Math.min(stat.min, value);
      stat.max = stat.max === null ? value : Math.max(stat.max, value);
      stat.lastValue = value;
    }

    const transition = this.phaseDetector.update(sample);
    if (transition) this.transitionList.push(transition);

    const events = this.landingTracker.update(sample);
    const lastEvent = events[events.length - 1];
    if (lastEvent) {
      this.lastScore = lastEvent.score.score;
      this.lastGrade = lastEvent.score.grade;
    }
  }

  snapshot(): SpikeProbeSnapshot {
    let durationS: number | null = null;
    let rateHz: number | null = null;
    if (this.firstTsMs !== null && this.lastTsMs !== null && this.lastTsMs > this.firstTsMs) {
      durationS = round2((this.lastTsMs - this.firstTsMs) / 1000);
      rateHz = round2(((this.sampleCountValue - 1) * 1000) / (this.lastTsMs - this.firstTsMs));
    }

    return {
      sampleCount: this.sampleCountValue,
      firstTs: this.firstTs,
      lastTs: this.lastTs,
      durationS,
      rateHz,
      fields: this.stats.map((stat) => ({
        ...stat,
        invalid: stat.samples - stat.valid,
      })),
      phases: {
        transitions: [...this.transitionList],
        confirmedLiftoff: this.landingTracker.hasConfirmedLiftoff,
        touchdownDetected: this.landingTracker.hasTouchdown,
        landings: this.landingTracker.landingCount,
        lastScore: this.lastScore,
        lastGrade: this.lastGrade,
      },
    };
  }
}
