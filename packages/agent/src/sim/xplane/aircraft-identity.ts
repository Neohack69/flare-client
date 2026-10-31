/**
 * X-Plane aircraft identity from the simulator's own files (ADR-0023 §2.1a/R6).
 *
 * UDP RREF cannot read string datarefs (`acf_ICAO`/`acf_descrip`), so an RREF
 * session otherwise records `ZZZZ`. X-Plane writes the loaded `.acf` path to
 * `<root>/Log.txt`; the `.acf` text header carries `acf/_ICAO` and
 * `acf/_descrip`. Everything here is read-only and fails soft: no install,
 * unreadable log/ACF or a malformed value simply yields `null`.
 *
 * Security: the logged path is untrusted. It is rejected on `..` segments and
 * must resolve (via realpath) to a file strictly inside the install root.
 */
import { Buffer } from 'node:buffer';
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { aircraftIcaoSchema, canonicalAircraftIcao } from '@flightlog/contracts';

import { findXPlaneInstallDir, type XPlaneDiscoveryOptions } from './apt-dat.js';

/** Re-check interval for a grounded session (aircraft change in the menu). */
export const XPLANE_AIRCRAFT_IDENTITY_RECHECK_MS = 30_000;
/** Only the tail is needed: the last load line is written near the end of Log.txt. */
export const XPLANE_LOG_TAIL_MAX_BYTES = 256 * 1024;
/** An `.acf` text header is a few KiB; anything larger is not a header we trust. */
export const XPLANE_ACF_MAX_BYTES = 1024 * 1024;

const UNKNOWN_AIRCRAFT_ICAO = 'ZZZZ';
const LOG_LOAD_PREFIX = 'Loading airplane number 0 with ';
const LOG_LOAD_PATTERN = /Loading airplane number 0 with (.+\.acf)\s*$/i;
const TRAVERSAL_PATTERN = /(^|[\\/])\.\.([\\/]|$)/;
/** Real text `.acf` properties are `P <key> <value>` inside PROPERTIES_BEGIN..END. */
const ACF_PROPERTY_PREFIX_PATTERN = /^p[ \t]+/i;
const TITLE_MAX_CODE_POINTS = 120;
const TITLE_UNSAFE_PATTERN = /[\p{Cc}\p{Cf}]/gu;

export interface XPlaneAircraftIdentity {
  icao: string;
  title: string;
}

export interface XPlaneAircraftIdentityStats {
  mtimeMs: number;
  size: number;
  /** Present in the default statter; injected stats may omit it. */
  isFile?: boolean;
}

export interface XPlaneAircraftIdentityCacheEntry {
  logMtimeMs: number;
  logSize: number;
  acfPath: string | null;
  acfMtimeMs: number | null;
  identity: XPlaneAircraftIdentity | null;
  checkedAtMs: number;
}

export type XPlaneAircraftIdentityCache = Map<string, XPlaneAircraftIdentityCacheEntry>;

export interface XPlaneAircraftIdentityOptions extends XPlaneDiscoveryOptions {
  /** Explicit install root; when omitted discovery (env/Steam/common paths) is used. */
  installDir?: string | null;
  stat?: (path: string) => XPlaneAircraftIdentityStats | null;
  /** Full ACF text read; only called after the size bound is checked. */
  readFile?: (path: string) => string;
  /** Bounded tail read of Log.txt. */
  readTail?: (path: string, maxBytes: number) => string | null;
  realpath?: (path: string) => string | null;
  now?: () => number;
  /** Test hook / per-process cache override. */
  cache?: XPlaneAircraftIdentityCache;
}

const defaultCache: XPlaneAircraftIdentityCache = new Map();

export function clearXPlaneAircraftIdentityCache(): void {
  defaultCache.clear();
}

/**
 * Last `Loading airplane number 0 with <path>.acf` line in Log.txt.
 * Handles CRLF/LF, spaces and both path separators. Traversal (`..`) and
 * malformed lines are rejected here; the install-root prefix check happens in
 * {@link resolveXPlaneAircraftIdentity}.
 */
export function parseLogAircraftPath(logText: string): string | null {
  if (typeof logText !== 'string' || logText.length === 0) return null;
  let found: string | null = null;
  for (const line of logText.split(/\r\n|\n|\r/)) {
    if (!line.includes(LOG_LOAD_PREFIX)) continue;
    const match = LOG_LOAD_PATTERN.exec(line);
    const raw = match?.[1]?.trim();
    if (!raw || raw.includes('\0') || TRAVERSAL_PATTERN.test(raw)) continue;
    const segments = raw.split(/[\\/]+/);
    const name = segments[segments.length - 1] ?? '';
    if (name.length <= 4 || !name.toLowerCase().endsWith('.acf')) continue;
    found = raw;
  }
  return found;
}

/**
 * Identity from an X-Plane `.acf` text header. Returns `null` unless
 * `acf/_ICAO` is a valid type designator other than `ZZZZ`. Accepts both real
 * property lines (`P acf/_ICAO A20N`) and bare `acf/_ICAO A20N`. `title` comes
 * from `acf/_descrip`; when absent/empty it falls back to the validated ICAO.
 */
export function parseAcfIdentity(text: string): XPlaneAircraftIdentity | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  let icaoRaw: string | null = null;
  let description: string | null = null;

  for (const line of text.split(/\r\n|\n|\r/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const property = parseAcfPropertyLine(trimmed);
    if (!property) continue;
    if (property.key === 'acf/_ICAO' && icaoRaw === null) {
      const token = firstToken(property.value);
      if (token !== null) icaoRaw = token;
    } else if (property.key === 'acf/_descrip' && description === null) {
      if (property.value.length > 0) description = property.value;
    }
  }

  const token = firstToken(icaoRaw);
  if (!token) return null;
  const normalized = token.toUpperCase();
  if (normalized === UNKNOWN_AIRCRAFT_ICAO) return null;
  if (!aircraftIcaoSchema.safeParse(normalized).success) return null;
  const icao = canonicalAircraftIcao(normalized);
  if (icao === UNKNOWN_AIRCRAFT_ICAO) return null;

  return { icao, title: cleanTitle(description) ?? icao };
}

function parseAcfPropertyLine(line: string): { key: string; value: string } | null {
  const content = line.replace(ACF_PROPERTY_PREFIX_PATTERN, '');
  const separator = content.search(/\s/);
  if (separator <= 0) return null;
  const key = content.slice(0, separator);
  const value = content.slice(separator + 1).trim();
  return key.length > 0 ? { key, value } : null;
}

/**
 * Read the active aircraft identity from `<install>/Log.txt` + its `.acf`.
 * Never throws; the identity is cached by `.acf` mtime (and Log.txt mtime/size
 * for the path lookup).
 */
export function resolveXPlaneAircraftIdentity(
  options: XPlaneAircraftIdentityOptions = {},
): XPlaneAircraftIdentity | null {
  try {
    const stat = options.stat ?? defaultStat;
    const readFile = options.readFile ?? defaultReadFile;
    const readTail = options.readTail ?? defaultReadTail;
    const realpath = options.realpath ?? defaultRealpath;
    const now = options.now ?? (() => Date.now());
    const cache = options.cache ?? defaultCache;

    const installDir =
      options.installDir === undefined ? findXPlaneInstallDir(options) : options.installDir;
    if (!installDir) return null;

    const logPath = join(installDir, 'Log.txt');
    const logStat = stat(logPath);
    if (!logStat || logStat.isFile === false) return null;

    const cacheKey = normalizeKey(installDir);
    const cached = cache.get(cacheKey);
    const logUnchanged =
      cached !== undefined &&
      cached.logMtimeMs === logStat.mtimeMs &&
      cached.logSize === logStat.size;

    let acfPath: string;
    if (logUnchanged) {
      if (cached.acfPath === null) return null;
      acfPath = cached.acfPath;
    } else {
      const logTail = readTail(logPath, XPLANE_LOG_TAIL_MAX_BYTES);
      if (logTail === null) return null;
      const loggedPath = parseLogAircraftPath(logTail);
      if (!loggedPath) {
        remember(cache, cacheKey, logStat, null, null, null, now);
        return null;
      }
      const resolved = resolveAcfUnderInstall(installDir, loggedPath, realpath);
      if (!resolved) {
        remember(cache, cacheKey, logStat, null, null, null, now);
        return null;
      }
      acfPath = resolved;
    }

    const acfStat = stat(acfPath);
    if (!acfStat || acfStat.isFile === false || acfStat.size > XPLANE_ACF_MAX_BYTES) {
      remember(cache, cacheKey, logStat, acfPath, acfStat?.mtimeMs ?? null, null, now);
      return null;
    }

    if (cached && cached.acfPath === acfPath && cached.acfMtimeMs === acfStat.mtimeMs) {
      remember(cache, cacheKey, logStat, acfPath, acfStat.mtimeMs, cached.identity, now);
      return cached.identity;
    }

    let acfText = '';
    try {
      acfText = readFile(acfPath);
    } catch {
      acfText = '';
    }
    const identity = acfText.length > XPLANE_ACF_MAX_BYTES ? null : parseAcfIdentity(acfText);
    remember(cache, cacheKey, logStat, acfPath, acfStat.mtimeMs, identity, now);
    return identity;
  } catch {
    return null;
  }
}

function remember(
  cache: XPlaneAircraftIdentityCache,
  cacheKey: string,
  logStat: XPlaneAircraftIdentityStats,
  acfPath: string | null,
  acfMtimeMs: number | null,
  identity: XPlaneAircraftIdentity | null,
  now: () => number,
): void {
  cache.set(cacheKey, {
    logMtimeMs: logStat.mtimeMs,
    logSize: logStat.size,
    acfPath,
    acfMtimeMs,
    identity,
    checkedAtMs: now(),
  });
}

function resolveAcfUnderInstall(
  installDir: string,
  loggedPath: string,
  realpath: (path: string) => string | null,
): string | null {
  const segments = loggedPath.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) return null;
  const cleaned = segments.filter((segment) => segment.length > 0 && segment !== '.');
  if (cleaned.length === 0) return null;
  const relativePath = cleaned.join(sep);
  const candidate = isAbsoluteLike(loggedPath) ? loggedPath : join(installDir, relativePath);

  const rootReal = realpath(installDir);
  const candidateReal = realpath(resolve(candidate));
  if (!rootReal || !candidateReal) return null;

  const rel = relative(normalizeKey(rootReal), normalizeKey(candidateReal));
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return candidateReal;
}

function isAbsoluteLike(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}/.test(path);
}

function normalizeKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function firstToken(value: string | null): string | null {
  if (value === null) return null;
  const unquoted = value
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .trim();
  if (unquoted.length === 0) return null;
  const token = unquoted.split(/\s+/)[0];
  return token && token.length > 0 ? token : null;
}

function cleanTitle(value: string | null): string | null {
  if (value === null) return null;
  const unquoted = value.trim().replace(/^"(.*)"$/s, '$1');
  const cleaned = unquoted.replace(TITLE_UNSAFE_PATTERN, '').trim();
  const capped = truncateCodePoints(cleaned, TITLE_MAX_CODE_POINTS).trim();
  return capped.length > 0 ? capped : null;
}

function truncateCodePoints(value: string, max: number): string {
  if (value.length <= max) return value;
  return Array.from(value).slice(0, max).join('');
}

function defaultStat(path: string): XPlaneAircraftIdentityStats | null {
  try {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, size: stats.size, isFile: stats.isFile() };
  } catch {
    return null;
  }
}

function defaultReadFile(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > XPLANE_ACF_MAX_BYTES) {
      throw new Error('unsupported ACF file');
    }
    const length = stats.size;
    if (length === 0) return '';
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function defaultReadTail(path: string, maxBytes: number): string | null {
  try {
    const fd = openSync(path, 'r');
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile()) return null;
      const size = stats.size;
      const start = Math.max(0, size - Math.max(0, maxBytes));
      const length = size - start;
      const buffer = Buffer.alloc(length);
      if (length > 0) readSync(fd, buffer, 0, length, start);
      return buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function defaultRealpath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  }
}
