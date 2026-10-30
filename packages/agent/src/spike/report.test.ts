import { describe, expect, it } from 'vitest';

import {
  SPIKE_REQUIRED_SIMVARS,
  type SpikeFieldStat,
  type SpikeProbeSnapshot,
  type SpikeRequiredField,
} from './probe.js';
import { buildSpikeReport, evaluateSpikeVerdict, formatSpikeReport } from './report.js';

import type { SimConnectOpenInfo } from '../sim/types.js';

const TS = '2026-10-07T12:00:00.000Z';

const OPEN_INFO: SimConnectOpenInfo = {
  applicationName: 'Microsoft Flight Simulator 2024',
  applicationVersion: '1.39.9.0',
  simConnectVersion: '0.0.0.0',
};

function makeFields(
  overrides: Partial<Record<SpikeRequiredField, Partial<SpikeFieldStat>>> = {},
): SpikeFieldStat[] {
  return SPIKE_REQUIRED_SIMVARS.map((def) => ({
    field: def.field,
    simvar: def.name,
    unit: def.unit,
    samples: 10,
    valid: 10,
    invalid: 0,
    min: 0,
    max: 100,
    lastValue: 42,
    lastDisplay: '42',
    lastTs: TS,
    ...overrides[def.field],
  }));
}

function makeProbe(overrides: Partial<SpikeProbeSnapshot> = {}): SpikeProbeSnapshot {
  return {
    sampleCount: 10,
    firstTs: TS,
    lastTs: TS,
    durationS: 1,
    rateHz: 10,
    fields: makeFields(),
    phases: {
      transitions: [],
      confirmedLiftoff: false,
      touchdownDetected: false,
      landings: 0,
      lastScore: null,
      lastGrade: null,
    },
    ...overrides,
  };
}

describe('evaluateSpikeVerdict', () => {
  it('GO: соединение, сэмплы и все 8 SimVar валидны', () => {
    const result = evaluateSpikeVerdict({
      connectedEver: true,
      openInfo: OPEN_INFO,
      fatalConnectError: null,
      errors: [],
      sampleCount: 10,
      minSamples: 5,
      fields: makeFields(),
    });
    expect(result.verdict).toBe('GO');
    expect(result.reasons).toEqual([]);
  });

  it('NO-GO: нет соединения', () => {
    const result = evaluateSpikeVerdict({
      connectedEver: false,
      openInfo: null,
      fatalConnectError: null,
      errors: [],
      sampleCount: 0,
      minSamples: 5,
      fields: makeFields({ lat: { valid: 0, invalid: 10 } }),
    });
    expect(result.verdict).toBe('NO-GO');
    expect(result.reasons.join(' ')).toContain('Соединение');
  });

  it('NO-GO: отсутствует обязательный SimVar', () => {
    const result = evaluateSpikeVerdict({
      connectedEver: true,
      openInfo: OPEN_INFO,
      fatalConnectError: null,
      errors: [],
      sampleCount: 10,
      minSamples: 5,
      fields: makeFields({ vs_fpm: { valid: 0, invalid: 10 } }),
    });
    expect(result.verdict).toBe('NO-GO');
    expect(result.reasons.join(' ')).toContain('VERTICAL SPEED (vs_fpm)');
  });

  it('NO-GO: данные не пришли', () => {
    const result = evaluateSpikeVerdict({
      connectedEver: true,
      openInfo: OPEN_INFO,
      fatalConnectError: null,
      errors: [],
      sampleCount: 0,
      minSamples: 5,
      fields: makeFields({ lat: { valid: 0, invalid: 0 }, on_ground: { valid: 0, invalid: 0 } }),
    });
    expect(result.verdict).toBe('NO-GO');
    expect(result.reasons.join(' ')).toContain('данные');
  });

  it('NO-GO: ошибка подключения с причиной', () => {
    const result = evaluateSpikeVerdict({
      connectedEver: false,
      openInfo: null,
      fatalConnectError: 'connect ENOENT',
      errors: [],
      sampleCount: 0,
      minSamples: 5,
      fields: makeFields(),
    });
    expect(result.verdict).toBe('NO-GO');
    expect(result.reasons.join(' ')).toContain('connect ENOENT');
  });

  it('GO с предупреждением о частично валидной переменной', () => {
    const result = evaluateSpikeVerdict({
      connectedEver: true,
      openInfo: OPEN_INFO,
      fatalConnectError: null,
      errors: ['SimConnect exception: {}'],
      sampleCount: 10,
      minSamples: 5,
      fields: makeFields({ agl_ft: { valid: 7, invalid: 3 } }),
    });
    expect(result.verdict).toBe('GO');
    expect(result.warnings.join(' ')).toContain('PLANE ALT ABOVE GROUND');
    expect(result.warnings.join(' ')).toContain('SimConnect exception');
  });
});

describe('buildSpikeReport / formatSpikeReport', () => {
  it('формирует отчёт GO с SimVar и фазами', () => {
    const probe = makeProbe({
      phases: {
        transitions: [{ from: 'on_ground', to: 'airborne', reason: 'liftoff', ts: TS }],
        confirmedLiftoff: true,
        touchdownDetected: false,
        landings: 0,
        lastScore: null,
        lastGrade: null,
      },
    });
    const report = buildSpikeReport({
      probe,
      openInfo: OPEN_INFO,
      connectedEver: true,
      protocol: 'sunrise',
      errors: [],
      disconnectReason: null,
      fatalConnectError: null,
      finishedBy: 'max_samples',
      minSamples: 5,
    });

    expect(report.verdict).toBe('GO');
    const text = formatSpikeReport(report);
    expect(text).toContain('VERDICT: GO');
    expect(text).toContain('PLANE LATITUDE');
    expect(text).toContain('read-only');
    expect(text).toContain('on_ground -> airborne');
    expect(text).toContain('~10 Гц');
  });

  it('формирует отчёт NO-GO с причинами', () => {
    const report = buildSpikeReport({
      probe: makeProbe({ sampleCount: 0, fields: makeFields({ lat: { valid: 0, invalid: 0 } }) }),
      openInfo: null,
      connectedEver: false,
      protocol: 'sunrise',
      errors: [],
      disconnectReason: null,
      fatalConnectError: 'no sim',
      finishedBy: 'connect_error',
      minSamples: 5,
    });

    expect(report.verdict).toBe('NO-GO');
    const text = formatSpikeReport(report);
    expect(text).toContain('VERDICT: NO-GO');
    expect(text).toContain('Причины NO-GO:');
    expect(text).toContain('no sim');
  });
});
