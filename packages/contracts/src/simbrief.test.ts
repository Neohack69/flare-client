import { describe, expect, it } from 'vitest';

import { simbriefLoadSchema, simbriefPlanSchema, simbriefUsernameSchema } from './simbrief.js';

describe('simbriefUsernameSchema', () => {
  it('принимает имя и числовой id', () => {
    expect(simbriefUsernameSchema.parse('Pilot_1')).toBe('Pilot_1');
    expect(simbriefUsernameSchema.parse('  123456  ')).toBe('123456');
  });

  it('отклоняет пустое, пробелы и символы, из которых нельзя собрать query', () => {
    expect(simbriefUsernameSchema.safeParse('').success).toBe(false);
    expect(simbriefUsernameSchema.safeParse('a b').success).toBe(false);
    expect(simbriefUsernameSchema.safeParse('../admin').success).toBe(false);
    expect(simbriefUsernameSchema.safeParse('user@host').success).toBe(false);
  });
});

describe('simbriefLoadSchema', () => {
  it('не принимает лишние поля', () => {
    expect(simbriefLoadSchema.safeParse({ username: 'Pilot', raw: '{}' }).success).toBe(false);
  });
});

describe('simbriefPlanSchema', () => {
  it('принимает план без части полей', () => {
    const parsed = simbriefPlanSchema.parse({
      origin_icao: 'BIKF',
      destination_icao: 'BGGH',
      alternate_icao: null,
      aircraft_icao: 'B738',
      flight_number: 'SBI1',
      cruise_altitude_ft: 35000,
      route: 'KEF DCT',
      enroute_seconds: 3600,
      fuel_burn: 4200,
      fuel_unit: 'kg',
      landing_weight_kg: 60_000,
      fixes: [{ ident: 'KEF', lat: 63.99, lon: -22.6 }],
      fetched_at: '2026-10-02T09:00:00.000Z',
    });
    expect(parsed.cruise_altitude_ft).toBe(35000);
    expect(parsed.landing_weight_kg).toBe(60_000);
  });

  it('WAVE 3b: landing_weight_kg nullable, но обязательный ключ', () => {
    const base = {
      origin_icao: 'BIKF',
      destination_icao: 'BGGH',
      alternate_icao: null,
      aircraft_icao: 'B738',
      flight_number: null,
      cruise_altitude_ft: null,
      route: null,
      enroute_seconds: null,
      fuel_burn: null,
      fuel_unit: null,
      fixes: [],
      fetched_at: '2026-10-02T09:00:00.000Z',
    };
    expect(simbriefPlanSchema.safeParse({ ...base, landing_weight_kg: null }).success).toBe(true);
    expect(simbriefPlanSchema.safeParse(base).success).toBe(false);
    expect(simbriefPlanSchema.safeParse({ ...base, landing_weight_kg: -1 }).success).toBe(false);
  });
});
