/**
 * R1: MSFS arrival runway geometry from the FOQA `ATC RUNWAY …` values at the
 * contact frame. The sim reports true heading, length/width and the distance
 * from the threshold to the aircraft; the threshold is reconstructed by
 * walking back from the touchdown point.
 */
import type { SimRunway, TouchdownPoint } from '@flightlog/contracts';

const METERS_PER_DEG_LAT = 111_320;
const DEG_TO_RAD = Math.PI / 180;

export interface AtcTouchdownPosition {
  latitude: number;
  longitude: number;
}

/**
 * Why the MSFS `ATC RUNWAY …` contact values cannot be used for the arrival
 * geometry. `missing` — no usable values at all; `zero` — a required value is
 * zero; `no_heading` — heading is absent while other values are present.
 */
export type AtcRunwayMissingReason = 'missing' | 'zero' | 'no_heading';

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeHeading(value: number): number {
  const wrapped = ((value % 360) + 360) % 360;
  return wrapped >= 360 ? 0 : wrapped;
}

/** Runway designator inferred from true heading (e.g. 245° → `25`). */
export function designatorFromHeading(headingDeg: number): string {
  const rounded = normalizeHeading(headingDeg) / 10;
  const number = Math.round(rounded) % 36;
  return String(number === 0 ? 36 : number).padStart(2, '0');
}

/** Offset a WGS84 point by along-track / cross-track metres. */
export function offsetPoint(
  point: AtcTouchdownPosition,
  headingDeg: number,
  alongM: number,
  crossM: number,
): AtcTouchdownPosition {
  const headingRad = headingDeg * DEG_TO_RAD;
  const north = alongM * Math.cos(headingRad) - crossM * Math.sin(headingRad);
  const east = alongM * Math.sin(headingRad) + crossM * Math.cos(headingRad);
  const latitude = point.latitude + north / METERS_PER_DEG_LAT;
  const longitude =
    point.longitude + east / (METERS_PER_DEG_LAT * Math.cos(point.latitude * DEG_TO_RAD));
  return { latitude, longitude };
}

/**
 * Diagnose why the ATC contact values are unusable. Returns `null` when the
 * required values look valid (a valid `sim_runway` should be buildable).
 */
export function atcRunwayMissingReason(
  point: TouchdownPoint | null | undefined,
): AtcRunwayMissingReason | null {
  const heading = finite(point?.heading_deg_true);
  const length = finite(point?.length_m);
  const width = finite(point?.width_m);
  const start = finite(point?.start_distance_m);
  const required = [heading, length, width, start];
  if (required.every((value) => value === null)) return 'missing';
  if (heading === null) return 'no_heading';
  if (heading !== null && heading < 0) return 'missing';
  if (required.some((value) => value !== null && value <= 0)) return 'zero';
  if (length === null || width === null || start === null) return 'missing';
  if (
    heading > 360 ||
    length < 500 ||
    length > 6000 ||
    width < 15 ||
    width > 100 ||
    start > length
  ) {
    return 'missing';
  }
  return null;
}

/**
 * Build `sim_runway` from the ATC contact values. Returns `null` when any of
 * heading/length/width/start distance is missing or zero (spec: skip).
 */
export function buildAtcSimRunway(
  touchdown: AtcTouchdownPosition | null | undefined,
  point: TouchdownPoint | null | undefined,
): SimRunway | null {
  if (!touchdown || !point) return null;
  const latitude = finite(touchdown.latitude);
  const longitude = finite(touchdown.longitude);
  const heading = finite(point.heading_deg_true);
  const length = finite(point.length_m);
  const width = finite(point.width_m);
  const start = finite(point.start_distance_m);
  if (
    latitude === null ||
    longitude === null ||
    heading === null ||
    length === null ||
    width === null ||
    start === null
  ) {
    return null;
  }
  if (heading < 0 || heading > 360) return null;
  if (length < 500 || length > 6000) return null;
  if (width < 15 || width > 100) return null;
  if (start <= 0 || start > length) return null;

  // `relative_x_m` is the aircraft offset from the centreline; the aiming
  // point (`tdpoint_relative_x_m`) is a fallback when the former is absent.
  const lateral = finite(point.relative_x_m) ?? finite(point.aiming_x_m) ?? 0;

  const threshold = offsetPoint(
    { latitude, longitude },
    heading,
    -start,
    -lateral,
  );
  const end = offsetPoint(threshold, heading, length, 0);
  const normalizedHeading = normalizeHeading(heading);

  return {
    ident: designatorFromHeading(normalizedHeading),
    threshold: {
      lat: round(threshold.latitude, 7),
      lon: round(threshold.longitude, 7),
      elev_ft: null,
    },
    end: {
      lat: round(end.latitude, 7),
      lon: round(end.longitude, 7),
      elev_ft: null,
    },
    width_m: round(width, 1),
    length_m: round(length, 1),
    heading_deg: round(normalizedHeading, 1),
    surface_code: null,
  };
}
