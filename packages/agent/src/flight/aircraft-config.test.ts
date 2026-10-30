import { describe, expect, it } from 'vitest';
import { basename, dirname, join } from 'node:path';

import {
  createAircraftCfgIndex,
  matchAircraftCfgEntry,
  parseAircraftCfg,
  toAircraftCfgFields,
  type AircraftCfgEntry,
  type AircraftCfgVirtualFs,
} from './aircraft-config.js';

/** Реальные строки `common/config/aircraft.cfg` Synaptic A220. */
const COMMON_CFG = [
  '[General]',
  'atc_type = "AIRBUS"',
  'atc_model = "BCS3"',
  'icao_type_designator = "BCS3"',
  'Title = "Synaptic Simulations A220-300"',
  'ui_type = "A220-300"',
  '',
].join('\n');

/** Реальные строки пресета inibuilds `presets/inibuilds/A220-300/config/aircraft.cfg`. */
const PRESET_CFG = [
  '[FLTSIM.0]',
  'atc_type = "223"',
  'atc_model = "A220-300"',
  'icao_type_designator =BCS3',
  'title = "A220-300" ; Variation name',
  'ui_type="A220-300"',
  '',
].join('\n');

function entry(path: string, cfg: string): AircraftCfgEntry {
  return { path, ...toAircraftCfgFields(parseAircraftCfg(cfg)) };
}

function virtualFs(files: Record<string, string>): AircraftCfgVirtualFs {
  const dirs = new Set<string>();
  for (const file of Object.keys(files)) {
    let dir = dirname(file);
    while (dir && !dirs.has(dir)) {
      dirs.add(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return {
    listDir(dir) {
      if (!dirs.has(dir)) return null;
      const entries = new Map<string, boolean>();
      for (const candidate of dirs) {
        if (dirname(candidate) === dir) entries.set(basename(candidate), true);
      }
      for (const file of Object.keys(files)) {
        if (dirname(file) === dir) entries.set(basename(file), false);
      }
      return [...entries].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
    readFile(file) {
      const content = files[file];
      if (content === undefined) throw new Error(`no file: ${file}`);
      return content;
    },
  };
}

describe('parseAircraftCfg', () => {
  it('парсит реальный common/config/aircraft.cfg', () => {
    expect(parseAircraftCfg(COMMON_CFG)).toMatchObject({
      atc_type: 'AIRBUS',
      atc_model: 'BCS3',
      icao_type_designator: 'BCS3',
      title: 'Synaptic Simulations A220-300',
      ui_type: 'A220-300',
    });
  });

  it('парсит пресет: `=BCS3` без пробела, комментарий после кавычек, разные регистры', () => {
    expect(parseAircraftCfg(PRESET_CFG)).toMatchObject({
      atc_type: '223',
      atc_model: 'A220-300',
      icao_type_designator: 'BCS3',
      title: 'A220-300',
      ui_type: 'A220-300',
    });
  });

  it('устойчив к `key=value`, регистру, комментариям и пустым значениям', () => {
    const fields = parseAircraftCfg(
      [
        '; full-line comment',
        'TITLE=Foo 737 ; inline comment',
        'Ui_Type = "Bar 737"',
        'empty =   ',
        'icao_type_designator = "B738"',
        'no_equals_line',
      ].join('\n'),
    );
    expect(fields['title']).toBe('Foo 737');
    expect(fields['ui_type']).toBe('Bar 737');
    expect(fields['icao_type_designator']).toBe('B738');
    expect(fields['empty']).toBeUndefined();
  });

  it('не режет `;` внутри кавычек', () => {
    const fields = parseAircraftCfg('title = "A;B" ; real comment');
    expect(fields['title']).toBe('A;B');
  });
});

describe('matchAircraftCfgEntry', () => {
  const entries: AircraftCfgEntry[] = [
    entry(join('msfs', 'Community', 'a220', 'common', 'aircraft.cfg'), COMMON_CFG),
    entry(join('msfs', 'Community', 'a220', 'preset', 'aircraft.cfg'), PRESET_CFG),
  ];

  it('находит BCS3 по TITLE из common', () => {
    expect(
      matchAircraftCfgEntry(entries, { title: 'Synaptic Simulations A220-300' }),
    ).toMatchObject({ icaoTypeDesignator: 'BCS3' });
  });

  it('находит BCS3 по ATC MODEL / title пресета', () => {
    expect(matchAircraftCfgEntry(entries, { atcModel: 'A220-300' })?.icaoTypeDesignator).toBe(
      'BCS3',
    );
    expect(matchAircraftCfgEntry(entries, { title: '  a220-300 ' })?.icaoTypeDesignator).toBe(
      'BCS3',
    );
  });

  it('неизвестный запрос → null', () => {
    expect(matchAircraftCfgEntry(entries, { title: 'Boeing 737-800' })).toBeNull();
    expect(matchAircraftCfgEntry(entries, {})).toBeNull();
  });
});

describe('matchAircraftCfgEntry — мягкое совпадение (R5.8)', () => {
  const pmdgCfg = [
    '[General]',
    'icao_type_designator = "B77L"',
    'title = "PMDG 777-200LR"',
    'ui_type = "777-200LR"',
    'atc_model = "B77L"',
    '',
  ].join('\n');
  const entries: AircraftCfgEntry[] = [
    entry(join('msfs', 'Community', 'pmdg-777', 'aircraft.cfg'), pmdgCfg),
  ];

  it('находит B77L по длинному title с префиксом/суффиксом аддона', () => {
    expect(matchAircraftCfgEntry(entries, { title: 'PMDG 777-200LR v2' })?.icaoTypeDesignator).toBe(
      'B77L',
    );
    expect(matchAircraftCfgEntry(entries, { title: '777-200LR' })?.icaoTypeDesignator).toBe('B77L');
    expect(matchAircraftCfgEntry(entries, { atcModel: 'B77L' })?.icaoTypeDesignator).toBe('B77L');
  });

  it('не путает 777-200 с 777-200LR', () => {
    expect(matchAircraftCfgEntry(entries, { title: 'PMDG 777-200' })).toBeNull();
  });
});

describe('createAircraftCfgIndex', () => {
  const root = join('msfs', 'Community');
  const commonPath = join(root, 'addon-a220', 'common', 'aircraft.cfg');
  const presetPath = join(root, 'addon-a220', 'preset', 'aircraft.cfg');
  const otherPath = join(root, 'addon-b737', 'aircraft.cfg');
  const noDesignatorPath = join(root, 'addon-unknown', 'aircraft.cfg');
  const fs = virtualFs({
    [commonPath]: COMMON_CFG,
    [presetPath]: PRESET_CFG,
    [otherPath]: 'title = "Boeing 737-800"\n',
    [noDesignatorPath]: 'title = "Some Plane"\n',
  });

  it('строит индекс и резолвит BCS3 по обоим cfg', () => {
    const index = createAircraftCfgIndex({ roots: [root], fs, eager: true });
    expect(index.ready).toBe(true);
    expect(index.size).toBe(2);
    expect(index.lookup({ title: 'Synaptic Simulations A220-300' })).toBe('BCS3');
    expect(index.lookup({ atcModel: 'A220-300' })).toBe('BCS3');
    expect(index.lookup({ title: 'Boeing 737-800' })).toBeNull();
  });

  it('ленивый индекс до построения возвращает null и триггерит build', () => {
    const index = createAircraftCfgIndex({ roots: [root], fs });
    expect(index.ready).toBe(false);
    expect(index.lookup({ atcModel: 'A220-300' })).toBeNull();
    index.build();
    expect(index.lookup({ atcModel: 'A220-300' })).toBe('BCS3');
  });

  it('отсутствующий корень не ломает построение', () => {
    const index = createAircraftCfgIndex({
      roots: [join('msfs', 'Nope'), root],
      fs,
      eager: true,
    });
    expect(index.lookup({ title: 'A220-300' })).toBe('BCS3');
  });
});
