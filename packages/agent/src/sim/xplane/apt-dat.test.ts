import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  findNearestAirportIcao,
  findXPlaneInstallDir,
  matchRunwayTouchdown,
  parseSteamLibraryFolders,
  readAirportFromInstall,
  readAptDatAirport,
  toSimRunway,
} from './apt-dat.js';

const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const GLOBAL_APT = join(FIXTURES, 'apt-ltac.dat');
const CUSTOM_APT = join(FIXTURES, 'apt-ltac-custom.dat');

/** LTAC 03R touchdown from the owner's flight 4bef5962. */
const LTAC_TOUCHDOWN = { latitude: 40.10237, longitude: 32.99166, headingDeg: 36.1 };

const tempDirs: string[] = [];

function makeInstall(): string {
  const root = mkdtempSync(join(tmpdir(), 'flightlog-xp-'));
  tempDirs.push(root);
  const globalDir = join(root, 'Global Scenery', 'Global Airports', 'Earth nav data');
  mkdirSync(globalDir, { recursive: true });
  copyFileSync(GLOBAL_APT, join(globalDir, 'apt.dat'));
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('apt.dat parser (R1)', () => {
  it('reads the LTAC block with three runways and computes true headings', async () => {
    const airport = await readAptDatAirport(GLOBAL_APT, 'LTAC');
    expect(airport?.icao).toBe('LTAC');
    expect(airport?.elevationFt).toBe(3125);
    expect(airport?.runways.map((runway) => runway.ident)).toEqual(['03C', '03L', '03R']);

    const runway03R = airport?.runways.find((runway) => runway.ident === '03R');
    expect(runway03R?.widthM).toBe(45);
    expect(runway03R?.lengthM).toBeGreaterThan(3700);
    expect(runway03R?.lengthM).toBeLessThan(3800);
    expect(runway03R?.headingDeg).toBeGreaterThan(30);
    expect(runway03R?.headingDeg).toBeLessThan(40);
  });

  it('picks 03R for the real LTFM→LTAC touchdown (not 03C/03L)', async () => {
    const airport = await readAptDatAirport(GLOBAL_APT, 'LTAC');
    const runway = matchRunwayTouchdown(airport?.runways ?? [], LTAC_TOUCHDOWN);
    expect(runway?.ident).toBe('03R');

    const payload = toSimRunway(runway!, airport?.elevationFt ?? null);
    expect(payload.ident).toBe('03R');
    expect(payload.width_m).toBe(45);
    expect(payload.threshold.lat).toBeCloseTo(40.10036, 5);
    expect(payload.threshold.lon).toBeCloseTo(32.98973, 5);
    expect(payload.heading_deg).toBeCloseTo(36.1, 0);
  });

  it('rejects a touchdown far from the runway or with a wrong heading', async () => {
    const airport = await readAptDatAirport(GLOBAL_APT, 'LTAC');
    const runways = airport?.runways ?? [];
    expect(
      matchRunwayTouchdown(runways, { latitude: 40.2, longitude: 33.2, headingDeg: 36.1 }),
    ).toBeNull();
    expect(
      matchRunwayTouchdown(runways, { ...LTAC_TOUCHDOWN, headingDeg: 180 }),
    ).toBeNull();
  });

  it('resolves the arrival ICAO offline from the touchdown point', async () => {
    const root = makeInstall();
    await expect(
      findNearestAirportIcao(LTAC_TOUCHDOWN.latitude, LTAC_TOUCHDOWN.longitude, {
        installDir: root,
      }),
    ).resolves.toBe('LTAC');
    await expect(
      findNearestAirportIcao(0, 0, { installDir: root, maxDistanceM: 20_000 }),
    ).resolves.toBeNull();
  });

  it('merges Custom Scenery override over Global Airports (custom wins)', async () => {
    const root = makeInstall();
    const customDir = join(root, 'Custom Scenery', 'LTAC override', 'Earth nav data');
    mkdirSync(customDir, { recursive: true });
    copyFileSync(CUSTOM_APT, join(customDir, 'apt.dat'));

    const airport = await readAirportFromInstall(root, 'LTAC');
    expect(airport?.runways).toHaveLength(3);
    const runway03R = airport?.runways.find((runway) => runway.ident === '03R');
    expect(runway03R?.widthM).toBe(50);
  });
});

describe('X-Plane install discovery (R1)', () => {
  it('honours FLIGHTLOG_XPLANE_DIR and fails soft without an install', () => {
    const root = makeInstall();
    expect(
      findXPlaneInstallDir({ env: { FLIGHTLOG_XPLANE_DIR: root }, enableDefaults: false }),
    ).toBe(root);
    expect(
      findXPlaneInstallDir({ env: { FLIGHTLOG_XPLANE_DIR: 'Z:\\nope' }, enableDefaults: false }),
    ).toBeNull();

    // Partial/old folder with only `Custom Scenery` must not win over the real install.
    const partial = mkdtempSync(join(tmpdir(), 'flightlog-xp-partial-'));
    tempDirs.push(partial);
    mkdirSync(join(partial, 'Custom Scenery'), { recursive: true });
    expect(
      findXPlaneInstallDir({ env: { FLIGHTLOG_XPLANE_DIR: partial }, enableDefaults: false }),
    ).toBeNull();
  });

  it('parses Steam libraryfolders.vdf paths (escaped backslashes)', () => {
    const vdf = [
      '"libraryfolders"',
      '{',
      '  "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" }',
      '  "1" { "path" "F:\\\\SteamLibrary" }',
      '}',
    ].join('\n');
    expect(parseSteamLibraryFolders(vdf)).toEqual([
      'C:\\Program Files (x86)\\Steam',
      'F:\\SteamLibrary',
    ]);
  });
});
