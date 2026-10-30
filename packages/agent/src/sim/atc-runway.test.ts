import type { TouchdownPoint } from '@flightlog/contracts';
import { describe, expect, it } from 'vitest';

import {
  atcRunwayMissingReason,
  buildAtcSimRunway,
  designatorFromHeading,
  offsetPoint,
} from './atc-runway.js';

const TOUCHDOWN = { latitude: 40.1, longitude: 33.0 };

const ATC_POINT: TouchdownPoint = {
  relative_x_m: 5,
  relative_z_m: -150,
  aiming_x_m: 0,
  aiming_z_m: 300,
  start_distance_m: 150,
  end_distance_m: 2850,
  heading_deg_true: 245,
  length_m: 3000,
  width_m: 45,
};

describe('buildAtcSimRunway (MSFS ATC, R1)', () => {
  it('reconstructs threshold/end from ATC heading, length and start distance', () => {
    const runway = buildAtcSimRunway(TOUCHDOWN, ATC_POINT);
    expect(runway).not.toBeNull();
    expect(runway?.ident).toBe('25');
    expect(runway?.length_m).toBe(3000);
    expect(runway?.width_m).toBe(45);
    expect(runway?.heading_deg).toBe(245);

    const expectedThreshold = offsetPoint(TOUCHDOWN, 245, -150, -5);
    expect(runway?.threshold.lat).toBeCloseTo(expectedThreshold.latitude, 5);
    expect(runway?.threshold.lon).toBeCloseTo(expectedThreshold.longitude, 5);

    const expectedEnd = offsetPoint(expectedThreshold, 245, 3000, 0);
    expect(runway?.end.lat).toBeCloseTo(expectedEnd.latitude, 5);
    expect(runway?.end.lon).toBeCloseTo(expectedEnd.longitude, 5);
  });

  it('skips when ATC values are missing or zero', () => {
    expect(buildAtcSimRunway(TOUCHDOWN, null)).toBeNull();
    expect(buildAtcSimRunway(null, ATC_POINT)).toBeNull();
    expect(buildAtcSimRunway(TOUCHDOWN, { ...ATC_POINT, heading_deg_true: null })).toBeNull();
    expect(buildAtcSimRunway(TOUCHDOWN, { ...ATC_POINT, length_m: 0 })).toBeNull();
    expect(buildAtcSimRunway(TOUCHDOWN, { ...ATC_POINT, width_m: 0 })).toBeNull();
    expect(buildAtcSimRunway(TOUCHDOWN, { ...ATC_POINT, start_distance_m: 0 })).toBeNull();
    expect(buildAtcSimRunway(TOUCHDOWN, { ...ATC_POINT, length_m: 100 })).toBeNull();
  });

  it('derives a 01..36 designator from true heading', () => {
    expect(designatorFromHeading(245)).toBe('25');
    expect(designatorFromHeading(3)).toBe('36');
    expect(designatorFromHeading(359)).toBe('36');
  });
});

describe('atcRunwayMissingReason (MSFS ATC diagnostics)', () => {
  const NULLS: TouchdownPoint = {
    relative_x_m: null,
    relative_z_m: null,
    aiming_x_m: null,
    aiming_z_m: null,
    start_distance_m: null,
    end_distance_m: null,
    heading_deg_true: null,
    length_m: null,
    width_m: null,
  };

  it('reports `missing` when no ATC values are present', () => {
    expect(atcRunwayMissingReason(null)).toBe('missing');
    expect(atcRunwayMissingReason(undefined)).toBe('missing');
    expect(atcRunwayMissingReason(NULLS)).toBe('missing');
  });

  it('reports `zero` when the sim sends zeroed values', () => {
    expect(
      atcRunwayMissingReason({
        ...ATC_POINT,
        heading_deg_true: 0,
        length_m: 0,
        width_m: 0,
        start_distance_m: 0,
      }),
    ).toBe('zero');
  });

  it('reports `no_heading` when the heading is absent but other values exist', () => {
    expect(atcRunwayMissingReason({ ...ATC_POINT, heading_deg_true: null })).toBe('no_heading');
  });

  it('returns null for full usable values', () => {
    expect(atcRunwayMissingReason(ATC_POINT)).toBeNull();
    expect(buildAtcSimRunway(TOUCHDOWN, ATC_POINT)).not.toBeNull();
  });
});
