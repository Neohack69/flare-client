import { describe, expect, it } from 'vitest';

import {
  XPLANE_ALLOWED_DATAREFS,
  XPLANE_CORE_REQUIRED_DATAREFS,
  XPLANE_DATAREFS,
  XPLANE_NO_EQUIVALENT_FIELDS,
  XPLANE_REQUIRED_DATAREFS,
  isAllowedXPlaneDataref,
  planRrefSubscriptions,
  planWebApiSubscriptions,
  xplaneDatarefSpec,
  type XPlaneDatarefRole,
} from './datarefs.js';

const ROLES = Object.keys(XPLANE_DATAREFS) as XPlaneDatarefRole[];

describe('X-Plane dataref allow-list (единственная таблица имён)', () => {
  it('allow-list = значения таблицы, без дублей', () => {
    expect(XPLANE_ALLOWED_DATAREFS).toHaveLength(ROLES.length);
    expect(new Set(XPLANE_ALLOWED_DATAREFS).size).toBe(ROLES.length);
  });

  it('isAllowedXPlaneDataref: только имена из таблицы', () => {
    expect(isAllowedXPlaneDataref(XPLANE_DATAREFS.latitude.dataref)).toBe(true);
    expect(isAllowedXPlaneDataref('sim/flightmodel/position/latitudee')).toBe(false);
    expect(isAllowedXPlaneDataref('')).toBe(false);
  });

  it('privacy: нет sim/network/*, ливреи, tail number', () => {
    for (const name of XPLANE_ALLOWED_DATAREFS) {
      expect(name.startsWith('sim/network/')).toBe(false);
      const lower = name.toLowerCase();
      expect(lower).not.toContain('livery');
      expect(lower).not.toContain('tailnum');
      expect(lower).not.toContain('acf_tail');
    }
  });

  it('обязательные R: 13 (12 core + движки), core — 12', () => {
    expect(XPLANE_REQUIRED_DATAREFS).toHaveLength(13);
    expect(XPLANE_CORE_REQUIRED_DATAREFS).toHaveLength(12);
    expect(XPLANE_CORE_REQUIRED_DATAREFS).not.toContain(
      XPLANE_DATAREFS.engine_is_burning_fuel.dataref,
    );
    for (const name of XPLANE_CORE_REQUIRED_DATAREFS) {
      expect(XPLANE_REQUIRED_DATAREFS).toContain(name);
    }
  });

  it('каждый массив имеет arrayLength > 0', () => {
    for (const role of ROLES) {
      const spec = xplaneDatarefSpec(role);
      if (spec.valueType === 'float_array' || spec.valueType === 'int_array') {
        expect(spec.arrayLength, `${role} arrayLength`).toBeGreaterThan(0);
      }
    }
  });

  it('honest-null список содержит поля без XP-эквивалента', () => {
    for (const field of ['fuel_qty_gal', 'atc_type', 'in_cloud', 'surface_type', 'on_any_runway']) {
      expect(XPLANE_NO_EQUIVALENT_FIELDS).toContain(field);
    }
  });

  it('ENGINE-MODE: throttle/reverse datarefs подтверждены в DataRefs.txt 12.4.3', () => {
    for (const role of ['throttle_ratio', 'throttle_beta_rev_ratio', 'thrust_reverser_deploy_ratio'] as const) {
      const spec = xplaneDatarefSpec(role);
      expect(spec.requirement).toBe('A');
      expect(spec.valueType).toBe('float_array');
      expect(spec.arrayLength).toBe(16);
      expect(XPLANE_ALLOWED_DATAREFS).toContain(spec.dataref);
    }
  });

  it('A-04: REPLACED-датарефы погоды не читаются — в allow-list только подтверждённые замены', () => {
    const replaced = [
      'sim/weather/wind_direction_degt',
      'sim/weather/wind_speed_kt',
      'sim/weather/temperature_ambient_c',
      'sim/weather/barometer_sealevel_inhg',
      'sim/weather/rain_percent',
      'sim/weather/visibility_reported_m',
    ];
    for (const name of replaced) {
      expect(XPLANE_ALLOWED_DATAREFS, `${name} is REPLACED`).not.toContain(name);
    }
    for (const name of [
      'sim/weather/aircraft/wind_now_direction_degt',
      'sim/weather/aircraft/wind_now_speed_msc',
      'sim/weather/aircraft/temperature_ambient_deg_c',
      'sim/weather/region/sealevel_pressure_pas',
      'sim/weather/region/rain_percent',
      'sim/weather/region/visibility_reported_sm',
    ]) {
      expect(XPLANE_ALLOWED_DATAREFS, `${name} replacement`).toContain(name);
    }
  });
});

describe('планы подписки', () => {
  it('Web API: один целевой dataref на роль (массивы — целиком)', () => {
    const plan = planWebApiSubscriptions();
    expect(plan).toHaveLength(ROLES.length);
    expect(plan.every((target) => target.element === null)).toBe(true);
  });

  it('RREF: массивы поэлементно, data-строки пропускаются', () => {
    const plan = planRrefSubscriptions();
    const expected = ROLES.reduce((sum, role) => {
      const spec = xplaneDatarefSpec(role);
      if (spec.valueType === 'data') return sum;
      return sum + (spec.arrayLength ?? 1);
    }, 0);
    expect(plan).toHaveLength(expected);

    const dataNames = ROLES.filter((role) => xplaneDatarefSpec(role).valueType === 'data').map(
      (role) => XPLANE_DATAREFS[role].dataref,
    );
    for (const target of plan) {
      expect(dataNames).not.toContain(target.dataref);
    }

    const gear = plan.filter((target) => target.role === 'gear_deploy_ratio');
    expect(gear).toHaveLength(10);
    expect(gear.map((target) => target.element)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
