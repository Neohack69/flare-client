/**
 * X-Plane 12 arrival runway geometry from the simulator's own `apt.dat`
 * (R1). Read-only: the file is streamed and cached per ICAO for the process.
 *
 * `Global Scenery/Global Airports/Earth nav data/apt.dat` is the base; any
 * `Custom Scenery/<pack>/Earth nav data/apt.dat` overrides runways by ident
 * (custom wins). Discovery fails soft (returns `null`) — no simulator install
 * must not break recording.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { SimRunway } from '@flightlog/contracts';

export const XPLANE_DIR_ENV = 'FLIGHTLOG_XPLANE_DIR';

const METERS_PER_DEG_LAT = 111_320;
const DEG_TO_RAD = Math.PI / 180;
const APT_RELATIVE_PATH = join('Global Scenery', 'Global Airports', 'Earth nav data', 'apt.dat');
const CUSTOM_APT_RELATIVE_PATH = join('Earth nav data', 'apt.dat');

/** Matching thresholds from the R1 spec. */
export const SIM_RUNWAY_MATCH = {
  maxDistanceM: 60,
  maxHeadingDeltaDeg: 25,
  beforeThresholdM: 150,
} as const;

export interface AptRunway {
  ident: string;
  surfaceCode: number | null;
  widthM: number;
  lengthM: number;
  headingDeg: number;
  threshold: { lat: number; lon: number };
  end: { lat: number; lon: number };
}

export interface AptAirport {
  icao: string;
  elevationFt: number | null;
  runways: AptRunway[];
}

/** Airport reference point from `1302 datum_lat/datum_lon` (for offline ICAO lookup). */
export interface AptAirportLocation {
  icao: string;
  latitude: number;
  longitude: number;
  elevationFt: number | null;
}

export interface SimTouchdownPoint {
  latitude: number;
  longitude: number;
  /** True heading at touchdown; `null`/absent skips the heading check. */
  headingDeg?: number | null;
}

export interface XPlaneDiscoveryOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  /** Test hook: returns the raw `HKCU\Software\Valve\Steam\SteamPath` value. */
  runRegistry?: () => string | null;
  /** Test hook: `false` disables Steam/common-path probing. */
  enableDefaults?: boolean;
}

export interface AptDatOptions extends XPlaneDiscoveryOptions {
  /** Explicit install root; skips discovery when set. */
  installDir?: string | null;
  /** Test hook / per-process cache override. */
  cache?: Map<string, AptAirport | null>;
}

const defaultCache = new Map<string, AptAirport | null>();
const airportIndexCache = new Map<string, AptAirportLocation[]>();
const airportIndexPromises = new Map<string, Promise<AptAirportLocation[]>>();

function cacheFor(options: AptDatOptions): Map<string, AptAirport | null> {
  return options.cache ?? defaultCache;
}

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

function normalizeIcao(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const icao = value.trim().toUpperCase();
  return /^[A-Z0-9]{4}$/.test(icao) ? icao : null;
}

export function bearingDeg(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const midLat = ((from.lat + to.lat) / 2) * DEG_TO_RAD;
  const north = (to.lat - from.lat) * METERS_PER_DEG_LAT;
  const east = (to.lon - from.lon) * METERS_PER_DEG_LAT * Math.cos(midLat);
  return normalizeHeading((Math.atan2(east, north) / DEG_TO_RAD) || 0);
}

function distanceM(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const north = (to.lat - from.lat) * METERS_PER_DEG_LAT;
  const east =
    (to.lon - from.lon) * METERS_PER_DEG_LAT * Math.cos(((from.lat + to.lat) / 2) * DEG_TO_RAD);
  return Math.hypot(north, east);
}

/**
 * X-Plane install discovery: `FLIGHTLOG_XPLANE_DIR`, Steam registry +
 * `libraryfolders.vdf`, then common paths. Never throws.
 */
export function findXPlaneInstallDir(options: XPlaneDiscoveryOptions = {}): string | null {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));

  const explicit = env[XPLANE_DIR_ENV]?.trim();
  if (explicit && isXPlaneInstall(explicit, exists)) return explicit;
  if (options.enableDefaults === false) return null;

  const candidates = new Set<string>();
  const add = (base: string | null | undefined): void => {
    if (!base || base.trim().length === 0) return;
    candidates.add(join(base, 'steamapps', 'common', 'X-Plane 12'));
  };

  const steamRoots = discoverSteamRoots(options, exists, readFile);
  for (const root of steamRoots) add(root);

  const home = homedir();
  for (const direct of [
    'C:\\X-Plane 12',
    'C:\\Program Files\\X-Plane 12',
    'D:\\X-Plane 12',
    'F:\\X-Plane 12',
    'F:\\SteamLibrary\\steamapps\\common\\X-Plane 12',
    join(home, 'X-Plane 12'),
    '/Applications/X-Plane 12',
  ]) {
    candidates.add(direct);
  }

  for (const candidate of candidates) {
    if (isXPlaneInstall(candidate, exists)) return candidate;
  }
  return null;
}

export function isXPlaneInstall(
  dir: string,
  exists: (path: string) => boolean = existsSync,
): boolean {
  // A partial/old folder may contain only `Custom Scenery`; require the sim
  // executable or the Global Scenery tree that actually holds Global Airports.
  return (
    exists(join(dir, 'X-Plane.exe')) ||
    exists(join(dir, 'Global Scenery')) ||
    exists(join(dir, APT_RELATIVE_PATH))
  );
}

function discoverSteamRoots(
  options: XPlaneDiscoveryOptions,
  exists: (path: string) => boolean,
  readFile: (path: string) => string,
): string[] {
  const roots = new Set<string>();
  const platform = options.platform ?? process.platform;
  const registryValue =
    options.runRegistry ??
    (platform === 'win32' ? readSteamPathFromRegistry : () => null);
  const registry = registryValue();
  if (registry && exists(registry)) roots.add(registry);

  const home = homedir();
  for (const candidate of [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    'F:\\SteamLibrary',
    join(home, '.steam', 'steam'),
    join(home, '.local', 'share', 'Steam'),
    join(home, 'Library', 'Application Support', 'Steam'),
  ]) {
    if (exists(candidate)) roots.add(candidate);
  }

  const libraries = new Set<string>(roots);
  for (const root of roots) {
    const vdfPath = join(root, 'steamapps', 'libraryfolders.vdf');
    if (!exists(vdfPath)) continue;
    try {
      for (const library of parseSteamLibraryFolders(readFile(vdfPath))) libraries.add(library);
    } catch {
      // soft: unreadable library list must not break discovery
    }
  }
  return [...libraries];
}

function readSteamPathFromRegistry(): string | null {
  try {
    const output = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { encoding: 'utf8', windowsHide: true },
    );
    const match = /SteamPath\s+REG_SZ\s+(.+)/i.exec(output);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Extract library paths from `libraryfolders.vdf` (modern `"path"` format). */
export function parseSteamLibraryFolders(vdf: string): string[] {
  const paths: string[] = [];
  const pattern = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(vdf)) !== null) {
    const value = match[1]?.replace(/\\\\/g, '\\');
    if (value) paths.push(value);
  }
  return paths;
}

interface ParsedHeader {
  icao: string;
  elevationFt: number | null;
}

function parseAirportHeader(line: string): ParsedHeader | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5 || parts[0] !== '1') return null;
  // v1100: `1 <elev> <flag> <flag> <ICAO> <name>`; older files put ICAO at [3].
  const icao = [parts[4], parts[3]]
    .find((token) => token !== undefined && /^[A-Z0-9]{4}$/.test(token))
    ?.toUpperCase();
  if (!icao) return null;
  const elevation = Number(parts[1]);
  return { icao, elevationFt: Number.isFinite(elevation) ? elevation : null };
}

const RUNWAY_IDENT = /^[0-9]{1,2}[A-Z]?$/;

/**
 * v1100 rows carry four extra end fields before the opposite end:
 * `… ident1 lat1 lon1 displaced1 blast1 <4 fields> ident2 lat2 lon2 …`.
 * Older files put `ident2` right after the blast pad, so prefer [17], then [13].
 */
function parseRunwayEnd(parts: readonly string[]): { ident: string; lat: number; lon: number } | null {
  for (const index of [17, 13]) {
    const ident = parts[index];
    if (!ident || !RUNWAY_IDENT.test(ident)) continue;
    const lat = Number(parts[index + 1]);
    const lon = Number(parts[index + 2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    return { ident: ident.toUpperCase(), lat, lon };
  }
  return null;
}

function parseRunwayRow(line: string): AptRunway | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 14 || parts[0] !== '100') return null;

  const widthM = Number(parts[1]);
  const surfaceCode = Number.parseInt(parts[2] ?? '', 10);
  const ident = (parts[8] ?? '').trim().toUpperCase();
  const threshold = {
    lat: Number(parts[9]),
    lon: Number(parts[10]),
  };
  const end = parseRunwayEnd(parts);
  if (
    !ident ||
    !RUNWAY_IDENT.test(ident) ||
    !Number.isFinite(widthM) ||
    !Number.isFinite(threshold.lat) ||
    !Number.isFinite(threshold.lon) ||
    !end
  ) {
    return null;
  }
  if (threshold.lat < -90 || threshold.lat > 90 || threshold.lon < -180 || threshold.lon > 180) {
    return null;
  }

  const lengthM = distanceM(threshold, end);
  if (widthM <= 0 || lengthM <= 0) return null;

  return {
    ident,
    surfaceCode: Number.isFinite(surfaceCode) ? surfaceCode : null,
    widthM,
    lengthM,
    headingDeg: bearingDeg(threshold, end),
    threshold,
    end: { lat: end.lat, lon: end.lon },
  };
}

async function scanAptDat(filePath: string, icao: string): Promise<AptAirport | null> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let airport: AptAirport | null = null;
  try {
    for await (const line of lines) {
      if (line.startsWith('1 ')) {
        // A new airport header closes the target block (apt.dat is ordered).
        if (airport) break;
        const header = parseAirportHeader(line);
        if (header?.icao === icao) {
          airport = { icao, elevationFt: header.elevationFt, runways: [] };
        }
        continue;
      }
      if (!airport) continue;
      if (line.startsWith('100 ')) {
        const runway = parseRunwayRow(line);
        if (runway) airport.runways.push(runway);
      }
    }
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
  return airport;
}

/** Parse one airport from a specific apt.dat file (no install discovery). */
export async function readAptDatAirport(
  filePath: string,
  icao: string,
): Promise<AptAirport | null> {
  const normalized = normalizeIcao(icao);
  return normalized ? scanAptDat(filePath, normalized) : null;
}

function customAptDatPaths(installDir: string, exists: (path: string) => boolean): string[] {
  const root = join(installDir, 'Custom Scenery');
  if (!exists(root)) return [];
  const paths: string[] = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(root, entry.name, CUSTOM_APT_RELATIVE_PATH);
      if (exists(candidate)) paths.push(candidate);
    }
  } catch {
    return [];
  }
  return paths;
}

function mergeRunways(base: readonly AptRunway[], override: readonly AptRunway[]): AptRunway[] {
  const byIdent = new Map<string, AptRunway>();
  for (const runway of base) byIdent.set(runway.ident, runway);
  for (const runway of override) byIdent.set(runway.ident, runway);
  return [...byIdent.values()];
}

/**
 * Read one airport from an install root, applying Custom Scenery overrides.
 * No cache — exported for tests and for callers that manage their own cache.
 */
export async function readAirportFromInstall(
  installDir: string,
  icao: string,
  options: { exists?: (path: string) => boolean } = {},
): Promise<AptAirport | null> {
  const normalized = normalizeIcao(icao);
  if (!normalized) return null;
  const exists = options.exists ?? existsSync;

  const globalPath = join(installDir, APT_RELATIVE_PATH);
  let airport = exists(globalPath) ? await scanAptDat(globalPath, normalized) : null;

  for (const customPath of customAptDatPaths(installDir, exists)) {
    const override = await scanAptDat(customPath, normalized);
    if (!override) continue;
    airport = airport
      ? {
          ...airport,
          elevationFt: override.elevationFt ?? airport.elevationFt,
          runways: mergeRunways(airport.runways, override.runways),
        }
      : override;
  }
  return airport;
}

async function scanAirportLocations(filePath: string): Promise<AptAirportLocation[]> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const locations: AptAirportLocation[] = [];
  let current:
    | { icao: string; elevationFt: number | null; lat: number | null; lon: number | null }
    | null = null;
  const finish = (): void => {
    if (!current) return;
    if (current.lat !== null && current.lon !== null) {
      locations.push({
        icao: current.icao,
        latitude: current.lat,
        longitude: current.lon,
        elevationFt: current.elevationFt,
      });
    }
    current = null;
  };
  try {
    for await (const line of lines) {
      if (line.startsWith('1 ')) {
        finish();
        const header = parseAirportHeader(line);
        if (header) {
          current = {
            icao: header.icao,
            elevationFt: header.elevationFt,
            lat: null,
            lon: null,
          };
        }
        continue;
      }
      if (!current || !line.startsWith('1302 ')) continue;
      const parts = line.trim().split(/\s+/);
      const key = parts[1];
      const value = Number(parts[2]);
      if (!Number.isFinite(value)) continue;
      if (key === 'datum_lat') current.lat = value;
      else if (key === 'datum_lon') current.lon = value;
    }
    finish();
  } catch {
    return [];
  } finally {
    lines.close();
    stream.destroy();
  }
  return locations;
}

async function readAirportIndex(
  installDir: string,
  options: { exists?: (path: string) => boolean } = {},
): Promise<AptAirportLocation[]> {
  const exists = options.exists ?? existsSync;
  const byIcao = new Map<string, AptAirportLocation>();
  const globalPath = join(installDir, APT_RELATIVE_PATH);
  if (exists(globalPath)) {
    for (const location of await scanAirportLocations(globalPath)) {
      byIcao.set(location.icao, location);
    }
  }
  for (const customPath of customAptDatPaths(installDir, exists)) {
    for (const location of await scanAirportLocations(customPath)) {
      byIcao.set(location.icao, location);
    }
  }
  return [...byIcao.values()];
}

/** Load (and cache per install) airport reference points for offline ICAO lookup. */
export async function loadAirportIndex(
  installDir: string,
  options: { exists?: (path: string) => boolean } = {},
): Promise<AptAirportLocation[]> {
  const key = installDir;
  const cached = airportIndexCache.get(key);
  if (cached) return cached;
  let promise = airportIndexPromises.get(key);
  if (!promise) {
    promise = readAirportIndex(installDir, options);
    airportIndexPromises.set(key, promise);
  }
  const index = await promise;
  airportIndexCache.set(key, index);
  airportIndexPromises.delete(key);
  return index;
}

/** Fire-and-forget index warm-up (X-Plane flights without a known destination). */
export function prewarmAirportIndex(options: AptDatOptions = {}): void {
  const installDir = options.installDir ?? findXPlaneInstallDir(options);
  if (!installDir) return;
  void loadAirportIndex(installDir, options).catch(() => {
    // soft: offline lookup is an enhancement
  });
}

function haversineM(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const earthM = 6_371_000;
  const dLat = (b.latitude - a.latitude) * DEG_TO_RAD;
  const dLon = (b.longitude - a.longitude) * DEG_TO_RAD;
  const lat1 = a.latitude * DEG_TO_RAD;
  const lat2 = b.latitude * DEG_TO_RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Nearest airport ICAO to a touchdown point, from the cached apt.dat index.
 * Returns `null` when the index is not ready or the nearest airport is too far.
 */
export async function findNearestAirportIcao(
  latitude: number,
  longitude: number,
  options: AptDatOptions & { maxDistanceM?: number } = {},
): Promise<string | null> {
  const lat = finite(latitude);
  const lon = finite(longitude);
  if (lat === null || lon === null) return null;
  const installDir = options.installDir ?? findXPlaneInstallDir(options);
  if (!installDir) return null;
  const index = await loadAirportIndex(installDir, options);
  const maxDistanceM = options.maxDistanceM ?? 20_000;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const airport of index) {
    const distance = haversineM(
      { latitude: lat, longitude: lon },
      { latitude: airport.latitude, longitude: airport.longitude },
    );
    if (distance < bestDistance) {
      best = airport.icao;
      bestDistance = distance;
    }
  }
  return best !== null && bestDistance <= maxDistanceM ? best : null;
}

/** Load (and cache) an airport from the discovered X-Plane install. */
export async function loadAirportRunways(
  icao: string,
  options: AptDatOptions = {},
): Promise<AptAirport | null> {
  const normalized = normalizeIcao(icao);
  if (!normalized) return null;
  const cache = cacheFor(options);
  if (cache.has(normalized)) return cache.get(normalized) ?? null;

  const installDir = options.installDir ?? findXPlaneInstallDir(options);
  if (!installDir) return null;

  const airport = await readAirportFromInstall(installDir, normalized, options);
  cache.set(normalized, airport);
  return airport;
}

/** Fire-and-forget cache warm-up (flight start) so flight end stays sync. */
export function prewarmAirportRunways(icao: string, options: AptDatOptions = {}): void {
  const normalized = normalizeIcao(icao);
  if (!normalized) return;
  const cache = cacheFor(options);
  if (cache.has(normalized)) return;
  void loadAirportRunways(normalized, options).catch(() => {
    // soft: apt.dat is an enhancement, never a recording dependency
  });
}

function projectOntoRunway(
  runway: AptRunway,
  touchdown: SimTouchdownPoint,
): { alongM: number; crossM: number } {
  const headingRad = runway.headingDeg * DEG_TO_RAD;
  const north = (touchdown.latitude - runway.threshold.lat) * METERS_PER_DEG_LAT;
  const east =
    (touchdown.longitude - runway.threshold.lon) *
    METERS_PER_DEG_LAT *
    Math.cos(touchdown.latitude * DEG_TO_RAD);
  return {
    alongM: east * Math.sin(headingRad) + north * Math.cos(headingRad),
    crossM: east * Math.cos(headingRad) - north * Math.sin(headingRad),
  };
}

function headingDeltaDeg(a: number, b: number): number {
  const delta = Math.abs(normalizeHeading(a) - normalizeHeading(b));
  return Math.min(delta, 360 - delta);
}

/**
 * Closest runway to the touchdown: centreline distance ≤ 60 m, heading delta
 * ≤ 25° (when known) and along-track within [-150 m, length].
 */
export function matchRunwayTouchdown(
  runways: readonly AptRunway[],
  touchdown: SimTouchdownPoint,
  options: {
    maxDistanceM?: number;
    maxHeadingDeltaDeg?: number;
    beforeThresholdM?: number;
  } = {},
): AptRunway | null {
  const lat = finite(touchdown.latitude);
  const lon = finite(touchdown.longitude);
  if (lat === null || lon === null) return null;
  const maxDistanceM = options.maxDistanceM ?? SIM_RUNWAY_MATCH.maxDistanceM;
  const maxHeadingDeltaDeg =
    options.maxHeadingDeltaDeg ?? SIM_RUNWAY_MATCH.maxHeadingDeltaDeg;
  const beforeThresholdM = options.beforeThresholdM ?? SIM_RUNWAY_MATCH.beforeThresholdM;
  const heading = finite(touchdown.headingDeg ?? null);

  let best: AptRunway | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const runway of runways) {
    if (runway.widthM < 15 || runway.widthM > 100) continue;
    if (runway.lengthM < 500 || runway.lengthM > 6000) continue;

    const delta = heading === null ? 0 : headingDeltaDeg(heading, runway.headingDeg);
    if (delta > maxHeadingDeltaDeg) continue;

    const { alongM, crossM } = projectOntoRunway(runway, { latitude: lat, longitude: lon });
    if (alongM < -beforeThresholdM || alongM > runway.lengthM) continue;
    const distance = Math.abs(crossM);
    if (distance > maxDistanceM) continue;
    if (distance < bestDistance || (distance === bestDistance && delta < bestDelta)) {
      best = runway;
      bestDistance = distance;
      bestDelta = delta;
    }
  }
  return best;
}

/** Convert apt.dat geometry to the `/complete.sim_runway` payload. */
export function toSimRunway(runway: AptRunway, airportElevationFt: number | null): SimRunway {
  const elevationFt = finite(airportElevationFt);
  return {
    ident: runway.ident,
    threshold: {
      lat: round(runway.threshold.lat, 7),
      lon: round(runway.threshold.lon, 7),
      elev_ft: elevationFt,
    },
    end: {
      lat: round(runway.end.lat, 7),
      lon: round(runway.end.lon, 7),
      elev_ft: elevationFt,
    },
    width_m: round(runway.widthM, 1),
    length_m: round(runway.lengthM, 1),
    heading_deg: round(runway.headingDeg, 1),
    surface_code: runway.surfaceCode,
  };
}

/** Match from the per-process cache only (no I/O; safe at flight end). */
export function resolveCachedSimRunway(
  icao: string,
  touchdown: SimTouchdownPoint,
  options: AptDatOptions = {},
): SimRunway | null {
  const normalized = normalizeIcao(icao);
  if (!normalized) return null;
  const airport = cacheFor(options).get(normalized);
  if (!airport) return null;
  const runway = matchRunwayTouchdown(airport.runways, touchdown);
  return runway ? toSimRunway(runway, airport.elevationFt) : null;
}

/** Load + match (async); used by tooling/recompute, fails soft. */
export async function resolveSimRunway(
  icao: string,
  touchdown: SimTouchdownPoint,
  options: AptDatOptions = {},
): Promise<SimRunway | null> {
  const airport = await loadAirportRunways(icao, options);
  if (!airport) return null;
  const runway = matchRunwayTouchdown(airport.runways, touchdown);
  return runway ? toSimRunway(runway, airport.elevationFt) : null;
}
