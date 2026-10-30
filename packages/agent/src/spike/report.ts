import { SPIKE_REQUIRED_SIMVARS, type SpikeFieldStat, type SpikeProbeSnapshot } from './probe.js';

import type { SimConnectOpenInfo } from '../sim/types.js';

export type SpikeVerdict = 'GO' | 'NO-GO';

export type SpikeFinishReason =
  | 'max_samples'
  | 'duration'
  | 'idle_timeout'
  | 'disconnect'
  | 'connect_error'
  | 'connect_timeout';

export interface SpikeReport {
  verdict: SpikeVerdict;
  reasons: string[];
  warnings: string[];
  connection: {
    connectedEver: boolean;
    openInfo: SimConnectOpenInfo | null;
    protocol: string;
    errors: string[];
    disconnectReason: string | null;
    finishedBy: SpikeFinishReason;
  };
  samples: {
    count: number;
    firstTs: string | null;
    lastTs: string | null;
    durationS: number | null;
    rateHz: number | null;
  };
  fields: SpikeFieldStat[];
  phases: SpikeProbeSnapshot['phases'];
}

export interface SpikeVerdictInput {
  connectedEver: boolean;
  openInfo: SimConnectOpenInfo | null;
  fatalConnectError: string | null;
  errors: string[];
  sampleCount: number;
  minSamples: number;
  fields: SpikeFieldStat[];
}

export interface SpikeVerdictEvaluation {
  verdict: SpikeVerdict;
  reasons: string[];
  warnings: string[];
}

/** Порог, ниже которого сессия считается «данных нет», а не «мало данных». */
export const SPIKE_ZERO_SAMPLES = 0;

/**
 * Детерминированная оценка Go/No-Go по собранной статистике (без I/O).
 *
 * GO требует: соединение установлено, пришло ≥ `minSamples` сэмплов и каждый
 * обязательный SimVar хотя бы раз вернул валидное значение. Детект взлёта/
 * касания — наблюдаемый факт, а не условие GO (владелец может проверять
 * совместимость на стоянке).
 */
export function evaluateSpikeVerdict(input: SpikeVerdictInput): SpikeVerdictEvaluation {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (input.fatalConnectError) {
    reasons.push(`Не удалось подключиться к SimConnect: ${input.fatalConnectError}`);
  }
  if (!input.connectedEver || !input.openInfo) {
    reasons.push(
      'Соединение с SimConnect не установлено (MSFS 2024 не запущен, SimConnect недоступен или занят).',
    );
  }
  if (input.sampleCount <= SPIKE_ZERO_SAMPLES) {
    reasons.push('SimConnect открылся, но данные (SimVars) не пришли за отведённое время.');
  } else if (input.sampleCount < input.minSamples) {
    reasons.push(
      `Получено сэмплов: ${input.sampleCount} — меньше минимума ${input.minSamples} для вердикта.`,
    );
  }

  const missing = input.fields.filter((field) => field.valid === 0);
  if (missing.length > 0) {
    reasons.push(
      `Недоступны обязательные SimVar: ${missing
        .map((field) => `${field.simvar} (${field.field})`)
        .join(', ')}.`,
    );
  }

  for (const field of input.fields) {
    if (field.valid > 0 && field.invalid > 0) {
      warnings.push(
        `${field.simvar} (${field.field}): валидных ${field.valid}/${field.samples}, остальные null/NaN.`,
      );
    }
  }

  if (input.errors.length > 0) {
    warnings.push(`Ошибки адаптера: ${input.errors.join('; ')}`);
  }

  return { verdict: reasons.length === 0 ? 'GO' : 'NO-GO', reasons, warnings };
}

export interface BuildSpikeReportInput {
  probe: SpikeProbeSnapshot;
  openInfo: SimConnectOpenInfo | null;
  connectedEver: boolean;
  protocol: string;
  errors: string[];
  disconnectReason: string | null;
  fatalConnectError: string | null;
  finishedBy: SpikeFinishReason;
  minSamples: number;
}

export function buildSpikeReport(input: BuildSpikeReportInput): SpikeReport {
  const verdict = evaluateSpikeVerdict({
    connectedEver: input.connectedEver,
    openInfo: input.openInfo,
    fatalConnectError: input.fatalConnectError,
    errors: input.errors,
    sampleCount: input.probe.sampleCount,
    minSamples: input.minSamples,
    fields: input.probe.fields,
  });

  return {
    verdict: verdict.verdict,
    reasons: verdict.reasons,
    warnings: verdict.warnings,
    connection: {
      connectedEver: input.connectedEver,
      openInfo: input.openInfo,
      protocol: input.protocol,
      errors: input.errors,
      disconnectReason: input.disconnectReason,
      finishedBy: input.finishedBy,
    },
    samples: {
      count: input.probe.sampleCount,
      firstTs: input.probe.firstTs,
      lastTs: input.probe.lastTs,
      durationS: input.probe.durationS,
      rateHz: input.probe.rateHz,
    },
    fields: input.probe.fields,
    phases: input.probe.phases,
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function fmt(value: number | null): string {
  if (value === null) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatFieldLine(stat: SpikeFieldStat): string {
  const status = stat.valid === 0 ? 'MISSING' : stat.invalid > 0 ? 'PARTIAL' : 'OK';
  const name = pad(stat.simvar, 27);
  const field = pad(stat.field, 15);
  const unit = stat.unit ? `${stat.unit}` : '—';
  return (
    `  ${pad(status, 8)} ${name} ${field} ` +
    `last=${pad(stat.lastDisplay ?? '—', 12)} valid=${stat.valid}/${stat.samples} ` +
    `min=${pad(fmt(stat.min), 10)} max=${pad(fmt(stat.max), 10)} [${unit}]`
  );
}

function formatConnection(report: SpikeReport): string {
  const { connection, samples } = report;
  const lines: string[] = [];
  if (connection.connectedEver && connection.openInfo) {
    const info = connection.openInfo;
    lines.push(`Соединение: OK (read-only, протокол ${connection.protocol})`);
    lines.push(
      `  Приложение: ${info.applicationName} ${info.applicationVersion} · SimConnect ${info.simConnectVersion}`,
    );
  } else {
    lines.push('Соединение: НЕТ');
  }
  const duration = samples.durationS !== null ? `${samples.durationS} c` : '—';
  const rate = samples.rateHz !== null ? `~${samples.rateHz} Гц` : '—';
  lines.push(`  Сэмплы: ${samples.count} за ${duration} (${rate})`);
  lines.push(`  Завершено: ${connection.finishedBy}`);
  if (connection.disconnectReason) lines.push(`  Disconnect: ${connection.disconnectReason}`);
  return lines.join('\n');
}

function formatPhases(report: SpikeReport): string {
  const { phases } = report;
  const lines: string[] = [];
  if (phases.transitions.length === 0) {
    lines.push('  Переходы фаз: нет');
  } else {
    for (const transition of phases.transitions) {
      lines.push(`  ${transition.from} -> ${transition.to} (${transition.reason}) @ ${transition.ts}`);
    }
  }
  lines.push(`  Взлёт подтверждён: ${phases.confirmedLiftoff ? 'да' : 'нет'}`);
  lines.push(
    `  Касание: ${phases.touchdownDetected ? 'да' : 'нет'} (посадок: ${phases.landings}` +
      (phases.lastScore !== null ? `, последний балл: ${phases.lastScore} ${phases.lastGrade ?? ''}` : '') +
      ')',
  );
  if (!phases.confirmedLiftoff && !phases.touchdownDetected) {
    lines.push('  (взлёт/касание не наблюдались — это нормально, если ВС не летало во время проверки)');
  }
  return lines.join('\n');
}

/** Человекочитаемый отчёт для владельца: заканчивается строкой `VERDICT: GO|NO-GO`. */
export function formatSpikeReport(report: SpikeReport): string {
  const sections: string[] = [];
  sections.push('=== CD-1 Spike S2: node-simconnect <-> MSFS 2024 (STRICTLY READ-ONLY) ===');
  sections.push(formatConnection(report));
  sections.push(`Обязательные SimVar (${SPIKE_REQUIRED_SIMVARS.length}):`);
  sections.push(report.fields.map((stat) => formatFieldLine(stat)).join('\n'));
  sections.push('Фазы полёта:');
  sections.push(formatPhases(report));

  if (report.warnings.length > 0) {
    sections.push('Предупреждения:');
    sections.push(report.warnings.map((warning) => `  - ${warning}`).join('\n'));
  }
  if (report.reasons.length > 0) {
    sections.push('Причины NO-GO:');
    sections.push(report.reasons.map((reason) => `  - ${reason}`).join('\n'));
  }

  sections.push(`VERDICT: ${report.verdict}`);
  return sections.join('\n');
}
