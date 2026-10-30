import { describe, expect, it } from 'vitest';

import {
  fieldDisplayValue,
  numericFieldValue,
  SPIKE_REQUIRED_FIELDS,
  SPIKE_REQUIRED_SIMVARS,
  SpikeProbe,
} from './probe.js';

import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';
import type { TelemetrySample } from '../sim/types.js';

describe('SPIKE_REQUIRED_SIMVARS', () => {
  it('содержит ровно 8 обязательных переменных из SIMVAR_DEFINITION', () => {
    expect(SPIKE_REQUIRED_FIELDS).toHaveLength(8);
    expect(SPIKE_REQUIRED_SIMVARS.map((def) => def.name)).toEqual([
      'PLANE LATITUDE',
      'PLANE LONGITUDE',
      'PLANE ALTITUDE',
      'PLANE ALT ABOVE GROUND',
      'GROUND VELOCITY',
      'VERTICAL SPEED',
      'SIM ON GROUND',
      'GENERAL ENG COMBUSTION:1',
    ]);
  });
});

describe('numericFieldValue / fieldDisplayValue', () => {
  it('маппит boolean в 0/1, а null/NaN — в null', () => {
    const sample = makeSample(isoAt(BASE_MS, 0), {
      on_ground: true,
      agl_ft: null,
      vs_fpm: Number.NaN,
    });
    expect(numericFieldValue(sample, 'on_ground')).toBe(1);
    expect(numericFieldValue(sample, 'agl_ft')).toBeNull();
    expect(numericFieldValue(sample, 'vs_fpm')).toBeNull();
    expect(numericFieldValue(sample, 'gs_kt')).toBe(0);
    expect(fieldDisplayValue(sample, 'on_ground')).toBe('true');
    expect(fieldDisplayValue(sample, 'vs_fpm')).toBe('NaN');
    expect(fieldDisplayValue(sample, 'agl_ft')).toBe('null');
  });
});

describe('SpikeProbe', () => {
  it('копит статистику по обязательным SimVar и считает частоту', () => {
    const probe = new SpikeProbe();
    for (let index = 0; index < 5; index += 1) {
      probe.handleSample(makeSample(isoAt(BASE_MS, index * 100), { lat: 55 + index * 0.001 }));
    }

    const snapshot = probe.snapshot();
    expect(snapshot.sampleCount).toBe(5);
    expect(snapshot.durationS).toBe(0.4);
    expect(snapshot.rateHz).toBe(10);

    const lat = snapshot.fields.find((field) => field.field === 'lat');
    expect(lat).toMatchObject({ valid: 5, invalid: 0, min: 55, max: 55.004, lastValue: 55.004 });
  });

  it('считает невалидные (null/NaN) значения', () => {
    const probe = new SpikeProbe();
    probe.handleSample(makeSample(isoAt(BASE_MS, 0), { agl_ft: null, vs_fpm: null }));
    probe.handleSample(makeSample(isoAt(BASE_MS, 100), { agl_ft: 120, vs_fpm: 400 }));

    const snapshot = probe.snapshot();
    const agl = snapshot.fields.find((field) => field.field === 'agl_ft');
    const vs = snapshot.fields.find((field) => field.field === 'vs_fpm');
    expect(agl).toMatchObject({ samples: 2, valid: 1, invalid: 1 });
    expect(vs).toMatchObject({ samples: 2, valid: 1, invalid: 1 });
  });

  it('детектит взлёт и касание существующей логикой фаз', () => {
    // Касание — на 13-й секунде: новому правилу нужна воздушная фаза
    // ≥ MIN_AIRBORNE_S (10 с) после достоверного набора высоты.
    const samples: { offsetS: number; override: Partial<TelemetrySample> }[] = [
      { offsetS: 0, override: { on_ground: true, gs_kt: 0, agl_ft: 0, vs_fpm: 0 } },
      { offsetS: 1, override: { on_ground: true, gs_kt: 60, agl_ft: 0, vs_fpm: 0 } },
      { offsetS: 2, override: { on_ground: false, gs_kt: 150, agl_ft: 100, vs_fpm: 700 } },
      { offsetS: 3, override: { on_ground: false, gs_kt: 120, agl_ft: 300, vs_fpm: 500 } },
      { offsetS: 13, override: { on_ground: true, gs_kt: 80, agl_ft: 0, vs_fpm: -300 } },
    ];
    const probe = new SpikeProbe();
    samples.forEach(({ offsetS, override }) => {
      probe.handleSample(makeSample(isoAt(BASE_MS, offsetS * 1000), override));
    });

    const { phases } = probe.snapshot();
    expect(phases.confirmedLiftoff).toBe(true);
    expect(phases.touchdownDetected).toBe(true);
    expect(phases.landings).toBe(1);
    expect(phases.lastScore).not.toBeNull();
    expect(phases.transitions.map((transition) => transition.to)).toEqual([
      'takeoff',
      'airborne',
      'on_ground',
    ]);
  });
});
