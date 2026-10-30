import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BASE_SIMVAR_DEFINITION,
  buildSimVarDefinition,
  buildSimVarSendIdMap,
  describeInertEngineReading,
  describeRejectedSimVar,
  describeSimVarDefinition,
  expectedSimVarLayoutSize,
  findFoqaGroupForField,
  DEFAULT_FOQA_GROUPS,
  FOQA_GROUP_ORDER,
  FOQA_SIMVAR_GROUPS,
  parseFoqaGroups,
  parseSampleWithMeta,
  sanitizeEngineTemperature,
  sanitizeFuelFlow,
  selectRejectedSimVar,
  type FoqaSimVarGroup,
  type SimVarDefinition,
  type SimVarReader,
} from './node-simconnect-adapter.js';

const TS = '2026-10-15T18:00:00.000Z';
const BASE_BYTES = 940;
/** База + все live-проверенные группы = дефолт клиента (env не задан). */
const DEFAULT_ALL_BYTES = 1380;
const DEFAULT_ALL_FIELDS = 90;
/** База + engines (все 26 полей, включая подтверждённые engine-mode). */
const ENGINES_BYTES = 1144;

const GROUP_DELTAS: Record<FoqaSimVarGroup, number> = {
  config: 52,
  autopilot: 16,
  ils: 44,
  aoa: 24,
  touchdown: 92,
  engines: 204,
  weight: 8,
};

/** Чекпоинты из `docs/architecture/foqa-simvars-staging.md` §3 (порядок групп). */
const CUMULATIVE_CHECKPOINTS: Array<[FoqaSimVarGroup, number]> = [
  ['config', 992],
  ['autopilot', 1008],
  ['ils', 1052],
  ['aoa', 1076],
  ['touchdown', 1168],
  ['engines', 1372],
  ['weight', 1380],
];

function fieldSize(type: SimVarDefinition['type']): number {
  if (type === 'string256') return 256;
  if (type === 'int32') return 4;
  return 8;
}

/** Читатель по произвольному набору с жёстким `limit` (модель обрезанного буфера). */
function truncatedReader(definition: readonly SimVarDefinition[], limit: number): SimVarReader {
  let index = 0;
  let offset = 0;
  const take = (): void => {
    const def = definition[index];
    if (!def) throw new Error('read past definition');
    const size = fieldSize(def.type);
    if (offset + size > limit) throw new RangeError('short buffer');
    offset += size;
    index += 1;
  };
  return {
    readFloat64: () => {
      take();
      return 1;
    },
    readInt32: () => {
      take();
      return 1;
    },
    readString256: () => {
      take();
      return '';
    },
    remaining: () => limit - offset,
  };
}

/** Читатель по произвольному набору с заданными значениями float-полей. */
function valueReader(
  definition: readonly SimVarDefinition[],
  values: Record<string, number>,
): SimVarReader {
  let index = 0;
  const next = (): SimVarDefinition => {
    const def = definition[index];
    index += 1;
    if (!def) throw new Error('read past definition');
    return def;
  };
  return {
    readFloat64: () => values[next().field] ?? Number.NaN,
    readInt32: () => values[next().field] ?? 0,
    readString256: () => {
      next();
      return '';
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('node-simconnect');
  vi.resetModules();
});

describe('FOQA SimVar groups (default = all verified)', () => {
  it('база = known-good 0.3.6: 29 полей / 940 байт', () => {
    expect(BASE_SIMVAR_DEFINITION).toHaveLength(29);
    expect(expectedSimVarLayoutSize(BASE_SIMVAR_DEFINITION)).toBe(BASE_BYTES);
    expect(buildSimVarDefinition()).toEqual(BASE_SIMVAR_DEFINITION);
  });

  it('группы совпадают с batch-таблицами staging-доки (размеры и число полей)', () => {
    expect(
      Object.fromEntries(FOQA_GROUP_ORDER.map((group) => [group, FOQA_SIMVAR_GROUPS[group].length])),
    ).toEqual({
      config: 7,
      autopilot: 4,
      ils: 7,
      aoa: 3,
      touchdown: 13,
      engines: 26,
      weight: 1,
    });
    // Все поля engines live-проверены: runtime = полный набор группы.
    expect(buildSimVarDefinition(['engines'])).toHaveLength(29 + 26);
    expect(buildSimVarDefinition(['engines'], { includeUnverified: true })).toHaveLength(29 + 26);
  });

  it('каждая группа добавляет ровно задокументированную дельту', () => {
    for (const group of FOQA_GROUP_ORDER) {
      const size = expectedSimVarLayoutSize(buildSimVarDefinition([group]));
      expect(size - BASE_BYTES).toBe(GROUP_DELTAS[group]);
    }
  });

  it('кумулятивный размер совпадает с чекпоинтами batch\'ей', () => {
    const enabled: FoqaSimVarGroup[] = [];
    for (const [group, bytes] of CUMULATIVE_CHECKPOINTS) {
      enabled.push(group);
      expect(expectedSimVarLayoutSize(buildSimVarDefinition(enabled))).toBe(bytes);
    }
  });

  it('all → полный Wave-4: 90 полей / 1380 байт (и это дефолт)', () => {
    const all = buildSimVarDefinition(FOQA_GROUP_ORDER);
    expect(all).toHaveLength(DEFAULT_ALL_FIELDS);
    expect(expectedSimVarLayoutSize(all)).toBe(DEFAULT_ALL_BYTES);
    expect(DEFAULT_FOQA_GROUPS).toEqual(FOQA_GROUP_ORDER);
    // База (17f + 9i + 3s) + FOQA (49f + 12i) = 66f + 21i + 3s = 90 полей.
    const floats = all.filter((def) => def.type === 'float64').length;
    const ints = all.filter((def) => def.type === 'int32').length;
    const strings = all.filter((def) => def.type === 'string256').length;
    expect({ floats, ints, strings }).toEqual({ floats: 66, ints: 21, strings: 3 });
  });

  it('дефолтный набор включает подтверждённые engine-mode поля (90 / 1380)', () => {
    const definition = buildSimVarDefinition(DEFAULT_FOQA_GROUPS);
    expect(definition).toHaveLength(DEFAULT_ALL_FIELDS);
    expect(expectedSimVarLayoutSize(definition)).toBe(DEFAULT_ALL_BYTES);
    const fields = definition.map((def) => def.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'throttle_1',
        'throttle_2',
        'throttle_3',
        'throttle_4',
        'reverse_1',
        'reverse_2',
        'reverse_3',
        'reverse_4',
        'reverse_engaged',
      ]),
    );
    // Флаг live-пробы больше не добавляет полей — набор идентичен дефолту.
    const withUnverified = buildSimVarDefinition(DEFAULT_FOQA_GROUPS, {
      includeUnverified: true,
    });
    expect(withUnverified).toHaveLength(DEFAULT_ALL_FIELDS);
    expect(expectedSimVarLayoutSize(withUnverified)).toBe(DEFAULT_ALL_BYTES);
  });

  it('порядок групп стабилен: база идёт первой, FOQA — в каноническом порядке', () => {
    const definition = buildSimVarDefinition(['weight', 'config', 'ils']);
    expect(definition.slice(0, 29)).toEqual(BASE_SIMVAR_DEFINITION);
    expect(definition.slice(29).map((def) => def.field)).toEqual([
      ...FOQA_SIMVAR_GROUPS.config.map((def) => def.field),
      ...FOQA_SIMVAR_GROUPS.ils.map((def) => def.field),
      ...FOQA_SIMVAR_GROUPS.weight.map((def) => def.field),
    ]);
  });

  it('findFoqaGroupForField маппит поле на группу (базовые → null)', () => {
    expect(findFoqaGroupForField('gear_position_0')).toBe('config');
    expect(findFoqaGroupForField('hsi_has_localizer')).toBe('ils');
    expect(findFoqaGroupForField('total_weight_lb')).toBe('weight');
    expect(findFoqaGroupForField('lat')).toBeNull();
    expect(findFoqaGroupForField('title')).toBeNull();
  });

  it('engines: live-проверенный ITT вместо отвергнутых EGT (поле egt_* остаётся)', () => {
    const names = FOQA_SIMVAR_GROUPS.engines.map((def) => def.name);
    expect(names.slice(0, 17)).toEqual([
      'TURB ENG N1:1',
      'TURB ENG N1:2',
      'TURB ENG N1:3',
      'TURB ENG N1:4',
      'TURB ENG ITT:1',
      'TURB ENG ITT:2',
      'TURB ENG ITT:3',
      'TURB ENG ITT:4',
      'TURB ENG FUEL FLOW PPH:1',
      'TURB ENG FUEL FLOW PPH:2',
      'TURB ENG FUEL FLOW PPH:3',
      'TURB ENG FUEL FLOW PPH:4',
      'ELEVATOR POSITION',
      'AILERON POSITION',
      'RUDDER POSITION',
      'BRAKE LEFT POSITION',
      'BRAKE RIGHT POSITION',
    ]);
    // ENGINE-MODE: live-verified on MSFS 2024 (2026-10-20), входят в дефолт.
    expect(names.slice(17)).toEqual([
      'GENERAL ENG THROTTLE LEVER POSITION:1',
      'GENERAL ENG THROTTLE LEVER POSITION:2',
      'GENERAL ENG THROTTLE LEVER POSITION:3',
      'GENERAL ENG THROTTLE LEVER POSITION:4',
      'TURB ENG REVERSE NOZZLE PERCENT:1',
      'TURB ENG REVERSE NOZZLE PERCENT:2',
      'TURB ENG REVERSE NOZZLE PERCENT:3',
      'TURB ENG REVERSE NOZZLE PERCENT:4',
      'GENERAL ENG REVERSE THRUST ENGAGED',
    ]);
    const engineMode = (FOQA_SIMVAR_GROUPS.engines as readonly SimVarDefinition[]).slice(17);
    expect(engineMode.map((def) => def.field)).toEqual([
      'throttle_1',
      'throttle_2',
      'throttle_3',
      'throttle_4',
      'reverse_1',
      'reverse_2',
      'reverse_3',
      'reverse_4',
      'reverse_engaged',
    ]);
    expect(engineMode.every((def) => def.verification === 'live')).toBe(true);
    const verifyLive = (FOQA_SIMVAR_GROUPS.engines as readonly SimVarDefinition[]).filter(
      (def) => def.verification === 'VERIFY-LIVE',
    );
    expect(verifyLive).toEqual([]);
    // Отвергнутые живым симом имена не должны вернуться.
    expect(names.some((name) => name.includes('EXHAUST GAS TEMPERATURE'))).toBe(false);
    expect(names).not.toContain('TURB ENG EGT:1');
    // Контракт полей не меняется: egt_1..egt_4 на месте.
    const fields = FOQA_SIMVAR_GROUPS.engines.map((def) => def.field);
    expect(fields).toEqual(expect.arrayContaining(['egt_1', 'egt_2', 'egt_3', 'egt_4']));
    // Runtime-размер engines = полная группа (+204 Б).
    expect(expectedSimVarLayoutSize(buildSimVarDefinition(['engines']))).toBe(
      BASE_BYTES + 204,
    );
    expect(expectedSimVarLayoutSize(FOQA_SIMVAR_GROUPS.engines)).toBe(204);
  });
});

describe('sendId-диагностика отвергнутых SimVars', () => {
  const enginesDefinition = buildSimVarDefinition(['engines']);
  // `_open` = sendId 0, AddToDataDefinition-пакеты идут с 1 (natural 1-based).
  const sendIds = enginesDefinition.map((_, index) => index + 1);
  const sendIdMap = buildSimVarSendIdMap(enginesDefinition, sendIds);
  const egtIndex = enginesDefinition.findIndex((def) => def.field === 'egt_1');

  it('buildSimVarSendIdMap связывает sendId с полем и FOQA-группой', () => {
    const entry = sendIdMap.get(egtIndex + 1);
    expect(entry).toMatchObject({ index: egtIndex, group: 'engines' });
    expect(entry?.def).toMatchObject({ name: 'TURB ENG ITT:1', field: 'egt_1' });
    expect(sendIdMap.get(1)?.group).toBeNull(); // первый базовый SimVar
  });

  it('selectRejectedSimVar по NAME_UNRECOGNIZED + sendId называет реального виновника', () => {
    const rejected = selectRejectedSimVar(sendIdMap, {
      sendId: egtIndex + 1,
      exception: 7,
      exceptionName: 'NAME_UNRECOGNIZED',
    });
    expect(rejected).toMatchObject({
      sendId: egtIndex + 1,
      index: egtIndex,
      simVar: 'TURB ENG ITT:1',
      field: 'egt_1',
      group: 'engines',
      exceptionName: 'NAME_UNRECOGNIZED',
    });
    expect(describeRejectedSimVar(rejected!)).toBe(
      "SimConnect rejected SimVar 'TURB ENG ITT:1' (egt_1, FOQA group 'engines') — NAME_UNRECOGNIZED",
    );
  });

  it('иные исключения и неизвестный sendId не маппятся на SimVar', () => {
    expect(
      selectRejectedSimVar(sendIdMap, { sendId: egtIndex + 1, exception: 18, exceptionName: 'INVALID_DATA_TYPE' }),
    ).toBeNull();
    expect(
      selectRejectedSimVar(sendIdMap, { sendId: 9999, exception: 7, exceptionName: 'NAME_UNRECOGNIZED' }),
    ).toBeNull();
    expect(selectRejectedSimVar(sendIdMap, { exception: 7, exceptionName: 'NAME_UNRECOGNIZED' })).toBeNull();
  });
});

describe('FLIGHTLOG_FOQA_SIMVARS parsing', () => {
  it('empty / undefined → дефолт = все live-проверенные группы', () => {
    const expected = { groups: [...FOQA_GROUP_ORDER], unknown: [] };
    expect(parseFoqaGroups(undefined)).toEqual(expected);
    expect(parseFoqaGroups(null)).toEqual(expected);
    expect(parseFoqaGroups('')).toEqual(expected);
    expect(parseFoqaGroups('   ')).toEqual(expected);
  });

  it('none → дефолт отключён (диагностика)', () => {
    expect(parseFoqaGroups('none')).toEqual({ groups: [], unknown: [] });
    expect(parseFoqaGroups('none,config')).toEqual({ groups: ['config'], unknown: [] });
  });

  it('csv имён — override: case-insensitive, порядок канонический, дубликаты схлопываются', () => {
    expect(parseFoqaGroups('ILS, config')).toEqual({
      groups: ['config', 'ils'],
      unknown: [],
    });
    expect(parseFoqaGroups('config,config')).toEqual({ groups: ['config'], unknown: [] });
  });

  it('all → все группы', () => {
    expect(parseFoqaGroups('all')).toEqual({ groups: [...FOQA_GROUP_ORDER], unknown: [] });
  });

  it('неизвестные имена игнорируются и возвращаются в unknown', () => {
    expect(parseFoqaGroups('config,bogus,ils,bogus')).toEqual({
      groups: ['config', 'ils'],
      unknown: ['bogus'],
    });
    expect(parseFoqaGroups('all,bogus')).toEqual({
      groups: [...FOQA_GROUP_ORDER],
      unknown: ['bogus'],
    });
    // Опечатка в env не отключает FOQA: набор остаётся дефолтным.
    expect(parseFoqaGroups('bogus')).toEqual({
      groups: [...FOQA_GROUP_ORDER],
      unknown: ['bogus'],
    });
  });
});

describe('runtime definition из env (FLIGHTLOG_FOQA_SIMVARS)', () => {
  it('пустой env (default) → all verified: 1380 байт / 90 полей', async () => {
    vi.stubEnv('FLIGHTLOG_FOQA_SIMVARS', '');
    vi.resetModules();
    const mod = await import('./node-simconnect-adapter.js');
    expect(mod.ENABLED_FOQA_GROUPS).toEqual([...FOQA_GROUP_ORDER]);
    expect(mod.UNKNOWN_FOQA_GROUPS).toEqual([]);
    expect(mod.SIMVAR_DEFINITION).toHaveLength(DEFAULT_ALL_FIELDS);
    expect(mod.expectedSimVarLayoutSize()).toBe(DEFAULT_ALL_BYTES);
  });

  it('none → база 940 (диагностический opt-out)', async () => {
    vi.stubEnv('FLIGHTLOG_FOQA_SIMVARS', 'none');
    vi.resetModules();
    const mod = await import('./node-simconnect-adapter.js');
    expect(mod.ENABLED_FOQA_GROUPS).toEqual([]);
    expect(mod.SIMVAR_DEFINITION).toEqual(mod.BASE_SIMVAR_DEFINITION);
    expect(mod.expectedSimVarLayoutSize()).toBe(BASE_BYTES);
  });

  it('engines → только engines: 1144 байта / 55 полей', async () => {
    vi.stubEnv('FLIGHTLOG_FOQA_SIMVARS', 'engines');
    vi.resetModules();
    const mod = await import('./node-simconnect-adapter.js');
    expect(mod.ENABLED_FOQA_GROUPS).toEqual(['engines']);
    expect(mod.SIMVAR_DEFINITION).toHaveLength(55);
    expect(mod.expectedSimVarLayoutSize()).toBe(ENGINES_BYTES);
  });

  it('csv групп — override: только запрошенные группы (staging/bisect)', async () => {
    vi.stubEnv('FLIGHTLOG_FOQA_SIMVARS', 'config,ils');
    vi.resetModules();
    const mod = await import('./node-simconnect-adapter.js');
    expect(mod.ENABLED_FOQA_GROUPS).toEqual(['config', 'ils']);
    expect(mod.expectedSimVarLayoutSize()).toBe(BASE_BYTES + 52 + 44);
  });

  it('all → полный Wave-4 (1380; все поля verified)', async () => {
    vi.stubEnv('FLIGHTLOG_FOQA_SIMVARS', 'all');
    vi.resetModules();
    const mod = await import('./node-simconnect-adapter.js');
    expect(mod.SIMVAR_DEFINITION).toHaveLength(DEFAULT_ALL_FIELDS);
    expect(mod.expectedSimVarLayoutSize()).toBe(DEFAULT_ALL_BYTES);
  });

  it('FLIGHTLOG_FOQA_UNVERIFIED=1 + engines → набор идентичен дефолту (55 / 1144)', async () => {
    vi.stubEnv('FLIGHTLOG_FOQA_SIMVARS', 'engines');
    vi.stubEnv('FLIGHTLOG_FOQA_UNVERIFIED', '1');
    vi.resetModules();
    const mod = await import('./node-simconnect-adapter.js');
    expect(mod.INCLUDE_UNVERIFIED_FOQA).toBe(true);
    expect(mod.SIMVAR_DEFINITION).toHaveLength(55);
    expect(mod.expectedSimVarLayoutSize()).toBe(1144);
  });

  it('FLIGHTLOG_FOQA_UNVERIFIED=1 без env → все группы: 90 / 1380 (без изменений)', async () => {
    vi.stubEnv('FLIGHTLOG_FOQA_SIMVARS', '');
    vi.stubEnv('FLIGHTLOG_FOQA_UNVERIFIED', '1');
    vi.resetModules();
    const mod = await import('./node-simconnect-adapter.js');
    expect(mod.INCLUDE_UNVERIFIED_FOQA).toBe(true);
    expect(mod.SIMVAR_DEFINITION).toHaveLength(90);
    expect(mod.expectedSimVarLayoutSize()).toBe(1380);
  });

  it('неизвестное имя: группа не включается, но попадает в unknown для warning', async () => {
    vi.stubEnv('FLIGHTLOG_FOQA_SIMVARS', 'config,bogus');
    vi.resetModules();
    const mod = await import('./node-simconnect-adapter.js');
    expect(mod.ENABLED_FOQA_GROUPS).toEqual(['config']);
    expect(mod.UNKNOWN_FOQA_GROUPS).toEqual(['bogus']);
    expect(mod.expectedSimVarLayoutSize()).toBe(BASE_BYTES + 52);
  });
});

describe('диагностика и устойчивость с FOQA-группами', () => {
  it('describeSimVarDefinition называет группы и ожидаемый размер из probe-логики', () => {
    const definition = buildSimVarDefinition(['config', 'ils']);
    const diagnostics = describeSimVarDefinition(definition, ['config', 'ils'], ['bogus']);
    expect(diagnostics.message).toContain(`${definition.length} fields`);
    expect(diagnostics.message).toContain(`${expectedSimVarLayoutSize(definition)} bytes`);
    expect(diagnostics.message).toContain('FOQA groups: config, ils');
    expect(diagnostics.meta).toMatchObject({
      fields: definition.length,
      expected_bytes: expectedSimVarLayoutSize(definition),
      foqa_groups: ['config', 'ils'],
      unknown_groups: ['bogus'],
      foqa_env: 'FLIGHTLOG_FOQA_SIMVARS',
    });
  });

  it('короткий буфер с включённой группой называет поле и группу виновника', () => {
    const definition = buildSimVarDefinition(['config']);
    const limit = BASE_BYTES + 52 - 4; // последний config-float64 (`GEAR POSITION:2`) обрезан
    const { layoutMismatch } = parseSampleWithMeta(
      truncatedReader(definition, limit),
      TS,
      definition,
    );
    expect(layoutMismatch).toMatchObject({
      expectedBytes: 992,
      actualBytes: 988,
      truncated: true,
      field: 'gear_position_2',
      simVar: 'GEAR POSITION:2',
      group: 'config',
    });
  });

  it('полный FOQA-буфер деградации не даёт', () => {
    const definition = buildSimVarDefinition(['config', 'weight']);
    const { layoutMismatch } = parseSampleWithMeta(
      truncatedReader(definition, 1000),
      TS,
      definition,
    );
    expect(layoutMismatch).toBeNull();
  });
});

describe('NodeSimConnectAdapter diagnostics at connect', () => {
  async function connectWith(
    definition: readonly SimVarDefinition[],
    foqaGroups: readonly FoqaSimVarGroup[],
  ) {
    const handle = {
      addToDataDefinition: vi.fn(),
      on: vi.fn(),
      requestDataOnSimObject: vi.fn(),
      close: vi.fn(),
    };
    vi.doMock('node-simconnect', () => ({
      Protocol: { SunRise: 'SunRise', KittyHawk: 'KittyHawk', FSX_SP2: 'FSX_SP2' },
      SimConnectDataType: { FLOAT64: 1, INT32: 2, STRING256: 3 },
      SimConnectConstants: { OBJECT_ID_USER: 0 },
      SimConnectPeriod: { SIM_FRAME: 1 },
      open: vi.fn(async () => ({
        recvOpen: {
          applicationName: 'MSFS 2024',
          applicationVersionMajor: 1,
          applicationVersionMinor: 2,
          simConnectVersionMajor: 0,
          simConnectVersionMinor: 0,
        },
        handle,
      })),
    }));
    vi.resetModules();
    const mod = await import('./node-simconnect-adapter.js');
    const logger = { info: vi.fn(), warn: vi.fn() };
    const adapter = new mod.NodeSimConnectAdapter({
      definition,
      foqaGroups,
      unknownFoqaGroups: [],
      logger,
    });
    await adapter.connect();
    return { adapter, logger, handle };
  }

  it('логирует включённые группы и ожидаемый размер payload (один раз)', async () => {
    const definition = buildSimVarDefinition(['config']);
    const { adapter, logger, handle } = await connectWith(definition, ['config']);

    expect(handle.addToDataDefinition).toHaveBeenCalledTimes(definition.length);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.info.mock.calls[0] ?? [];
    expect(message).toContain('expected payload 992 bytes');
    expect(message).toContain('FOQA groups: config');
    expect(meta).toMatchObject({ expected_bytes: 992, foqa_groups: ['config'] });

    await adapter.disconnect();
  });

  it('явно без групп логирует base 940 bytes и `none`', async () => {
    const definition = buildSimVarDefinition([]);
    const { adapter, logger } = await connectWith(definition, []);
    const [message, meta] = logger.info.mock.calls[0] ?? [];
    expect(message).toContain('29 fields, expected payload 940 bytes');
    expect(message).toContain('FOQA groups: none');
    expect(meta).toMatchObject({ expected_bytes: 940, fields: 29 });
    await adapter.disconnect();
  });

  it('D1: cap 20 Гц для окна касания (адаптер не режет поток на 10)', async () => {
    const definition = buildSimVarDefinition([]);
    const { adapter, handle } = await connectWith(definition, []);
    expect(adapter.capabilities.maxSampleHz).toBe(20);
    // Data definition запрашивается на каждый кадр сима (SIM_FRAME), выше 20 Гц.
    expect(handle.requestDataOnSimObject).toHaveBeenCalled();
    const [, period] = handle.requestDataOnSimObject.mock.calls[0] ?? [];
    expect(period).toBe(1);
    await adapter.disconnect();
  });

  it('default (all) логирует 90 fields / 1380 bytes', async () => {
    const definition = buildSimVarDefinition(FOQA_GROUP_ORDER);
    const { adapter, logger } = await connectWith(definition, [...FOQA_GROUP_ORDER]);
    const [message, meta] = logger.info.mock.calls[0] ?? [];
    expect(message).toContain('90 fields, expected payload 1380 bytes');
    expect(message).toContain(`FOQA groups: ${FOQA_GROUP_ORDER.join(', ')}`);
    expect(meta).toMatchObject({ expected_bytes: 1380, fields: 90 });
    await adapter.disconnect();
  });

  it('явный engines логирует 55 fields / 1144 bytes', async () => {
    const definition = buildSimVarDefinition(['engines']);
    const { adapter, logger } = await connectWith(definition, ['engines']);
    const [message, meta] = logger.info.mock.calls[0] ?? [];
    expect(message).toContain('55 fields, expected payload 1144 bytes');
    expect(message).toContain('FOQA groups: engines');
    expect(meta).toMatchObject({ expected_bytes: 1144, fields: 55 });
    await adapter.disconnect();
  });

  it('NAME_UNRECOGNIZED называет поле по sendId один раз и попадает в layout-отчёт', async () => {
    const definition = buildSimVarDefinition(['engines']);
    const handlers = new Map<string, (...args: unknown[]) => void>();
    let sendCounter = 0;
    const handle = {
      addToDataDefinition: vi.fn(() => {
        sendCounter += 1;
        return sendCounter;
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        handlers.set(event, listener);
      }),
      requestDataOnSimObject: vi.fn(),
      close: vi.fn(),
    };
    vi.doMock('node-simconnect', () => ({
      Protocol: { SunRise: 'SunRise', KittyHawk: 'KittyHawk', FSX_SP2: 'FSX_SP2' },
      SimConnectDataType: { FLOAT64: 1, INT32: 2, STRING256: 3 },
      SimConnectConstants: { OBJECT_ID_USER: 0 },
      SimConnectPeriod: { SIM_FRAME: 1 },
      open: vi.fn(async () => ({
        recvOpen: {
          applicationName: 'MSFS 2024',
          applicationVersionMajor: 1,
          applicationVersionMinor: 2,
          simConnectVersionMajor: 0,
          simConnectVersionMinor: 0,
        },
        handle,
      })),
    }));
    vi.resetModules();
    const mod = await import('./node-simconnect-adapter.js');
    const logger = { info: vi.fn(), warn: vi.fn() };
    const adapter = new mod.NodeSimConnectAdapter({
      definition,
      foqaGroups: ['engines'],
      unknownFoqaGroups: [],
      logger,
    });
    const onError = vi.fn();
    adapter.on('error', onError);
    await adapter.connect();

    const egtIndex = definition.findIndex((def) => def.field === 'egt_1');
    const sendId = egtIndex + 1;
    const emitException = handlers.get('exception');
    expect(emitException).toBeTypeOf('function');
    emitException?.({ exception: 7, sendId, index: 2, exceptionName: 'NAME_UNRECOGNIZED' });
    emitException?.({ exception: 7, sendId, index: 2, exceptionName: 'NAME_UNRECOGNIZED' });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe(
      "SimConnect rejected SimVar 'TURB ENG ITT:1' (egt_1, FOQA group 'engines') — NAME_UNRECOGNIZED",
    );

    const shortBuffer = {
      remaining: () => 0,
      readFloat64: () => {
        throw new RangeError('short buffer');
      },
      readInt32: () => {
        throw new RangeError('short buffer');
      },
      readString256: () => {
        throw new RangeError('short buffer');
      },
    };
    handlers.get('simObjectData')?.({ requestID: 1, data: shortBuffer });

    const mismatchCall = onError.mock.calls.find((call) =>
      String((call[0] as Error).message).includes('layout mismatch'),
    );
    expect(mismatchCall).toBeDefined();
    const mismatchMessage = String((mismatchCall?.[0] as Error).message);
    expect(mismatchMessage).toContain('Rejected SimVar(s):');
    expect(mismatchMessage).toContain("'TURB ENG ITT:1' (egt_1)");
    expect(mismatchMessage).toContain('Secondary: fields from #');

    await adapter.disconnect();
  });
});

describe('inert engine guard (ambient-as-ITT / ~0 fuel flow)', () => {
  const enginesDefinition = buildSimVarDefinition(['engines']);

  it('sanitizeEngineTemperature: sentinel 0 K и ambient-as-ITT → null, реальный ITT сохраняется', () => {
    expect(sanitizeEngineTemperature(null, 90, -55)).toEqual({ value: null, reason: null });
    // 0 K (= −273.15 °C) — sentinel «двигателя нет».
    expect(sanitizeEngineTemperature(-273.15, 0, -55)).toEqual({
      value: null,
      reason: 'itt_sentinel',
    });
    // Работающая турбина, но значение у ambient → псевдо-ITT.
    expect(sanitizeEngineTemperature(-55.3, 90, -55.32)).toEqual({
      value: null,
      reason: 'itt_ambient',
    });
    // Неработающий двигатель у ambient — это реальное показание (не guard).
    expect(sanitizeEngineTemperature(-55.3, 0, -55.32)).toEqual({ value: -55.3, reason: null });
    // Нормальный турбинный ITT проходит.
    expect(sanitizeEngineTemperature(520, 90, -55)).toEqual({ value: 520, reason: null });
    // Без ambient не угадываем: работает только sentinel-guard.
    expect(sanitizeEngineTemperature(-55.3, 90, null)).toEqual({ value: -55.3, reason: null });
  });

  it('sanitizeFuelFlow: ~0 (инертный/отсутствующий канал) → null, реальный расход сохраняется', () => {
    expect(sanitizeFuelFlow(null)).toEqual({ value: null, reason: null });
    expect(sanitizeFuelFlow(0)).toEqual({ value: null, reason: 'flow_inert' });
    expect(sanitizeFuelFlow(1.675894e-5)).toEqual({ value: null, reason: 'flow_inert' });
    expect(sanitizeFuelFlow(0.5)).toEqual({ value: null, reason: 'flow_inert' });
    expect(sanitizeFuelFlow(2500)).toEqual({ value: 2500, reason: null });
  });

  it('живой A220-300 (FL370): ambient-as-ITT и ~0 flow дают null, а не выдуманное число', () => {
    // Значения из live-probe `simvar-probe.mjs --values` на A220-300/BCS3.
    const liveA220 = {
      n1_1: 98.82421768357585,
      n1_2: 98.82421768357585,
      n1_3: 0,
      n1_4: 0,
      egt_1: -55.31634114583312,
      egt_2: -55.31634114583312,
      egt_3: -273.15,
      egt_4: -273.15,
      fuel_flow_pph_1: 1.675894e-5,
      fuel_flow_pph_2: 1.675894e-5,
      fuel_flow_pph_3: 0,
      fuel_flow_pph_4: 0,
      temp_c: -55.31633758544922,
    };
    const { sample, inertEngineReadings } = parseSampleWithMeta(
      valueReader(enginesDefinition, liveA220),
      TS,
      enginesDefinition,
    );

    expect(sample.egt_c).toEqual([null, null, null, null]);
    expect(sample.fuel_flow_pph).toEqual([null, null, null, null]);
    // N1 (sanity-контроль) не трогаем — он реальный.
    expect(sample.n1_percent).toEqual([98.82421768357585, 98.82421768357585, 0, 0]);

    const byField = Object.fromEntries(inertEngineReadings.map((r) => [r.field, r.reason]));
    expect(byField).toEqual({
      egt_1: 'itt_ambient',
      egt_2: 'itt_ambient',
      egt_3: 'itt_sentinel',
      egt_4: 'itt_sentinel',
      fuel_flow_pph_1: 'flow_inert',
      fuel_flow_pph_2: 'flow_inert',
      fuel_flow_pph_3: 'flow_inert',
      fuel_flow_pph_4: 'flow_inert',
    });
    const egt1 = inertEngineReadings.find((r) => r.field === 'egt_1');
    expect(egt1).toMatchObject({ simVar: 'TURB ENG ITT:1', unit: 'celsius', index: 0 });
  });

  it('реальные показания двигателей проходят guard без изменений', () => {
    const healthy = {
      n1_1: 90,
      n1_2: 88,
      n1_3: 0,
      n1_4: 0,
      egt_1: 520,
      egt_2: 505,
      egt_3: -273.15,
      egt_4: -273.15,
      fuel_flow_pph_1: 2600,
      fuel_flow_pph_2: 2550,
      fuel_flow_pph_3: 0,
      fuel_flow_pph_4: 0,
      temp_c: 15,
    };
    const { sample, inertEngineReadings } = parseSampleWithMeta(
      valueReader(enginesDefinition, healthy),
      TS,
      enginesDefinition,
    );

    expect(sample.egt_c).toEqual([520, 505, null, null]);
    expect(sample.fuel_flow_pph).toEqual([2600, 2550, null, null]);
    expect(inertEngineReadings.map((r) => r.field)).toEqual([
      'egt_3',
      'egt_4',
      'fuel_flow_pph_3',
      'fuel_flow_pph_4',
    ]);
  });

  it('describeInertEngineReading называет SimVar, поле, группу и причину', () => {
    const ambient = describeInertEngineReading({
      field: 'egt_1',
      simVar: 'TURB ENG ITT:1',
      unit: 'celsius',
      index: 0,
      reason: 'itt_ambient',
      value: -55.31634114583312,
      n1_percent: 98.82421768357585,
      ambient_c: -55.31633758544922,
    });
    expect(ambient).toContain("engine SimVar 'TURB ENG ITT:1' (egt_1, FOQA group 'engines')");
    expect(ambient).toContain('ambient-as-ITT');
    expect(ambient).toContain('reporting null');

    const flow = describeInertEngineReading({
      field: 'fuel_flow_pph_2',
      simVar: 'TURB ENG FUEL FLOW PPH:2',
      unit: 'pph',
      index: 1,
      reason: 'flow_inert',
      value: 1.675894e-5,
      n1_percent: 98.82421768357585,
      ambient_c: -55.31633758544922,
    });
    expect(flow).toContain("'TURB ENG FUEL FLOW PPH:2' (fuel_flow_pph_2, FOQA group 'engines')");
    expect(flow).toContain('~0 fuel flow');
    expect(flow).toContain('reporting null');
  });

  it('адаптер пишет one-time warn на каждое инертное поле и не спамит на каждый кадр', async () => {
    const definition = buildSimVarDefinition(['engines']);
    const handlers = new Map<string, (...args: unknown[]) => void>();
    let sendCounter = 0;
    const handle = {
      addToDataDefinition: vi.fn(() => {
        sendCounter += 1;
        return sendCounter;
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        handlers.set(event, listener);
      }),
      requestDataOnSimObject: vi.fn(),
      close: vi.fn(),
    };
    vi.doMock('node-simconnect', () => ({
      Protocol: { SunRise: 'SunRise', KittyHawk: 'KittyHawk', FSX_SP2: 'FSX_SP2' },
      SimConnectDataType: { FLOAT64: 1, INT32: 2, STRING256: 3 },
      SimConnectConstants: { OBJECT_ID_USER: 0 },
      SimConnectPeriod: { SIM_FRAME: 1 },
      open: vi.fn(async () => ({
        recvOpen: {
          applicationName: 'MSFS 2024',
          applicationVersionMajor: 1,
          applicationVersionMinor: 2,
          simConnectVersionMajor: 0,
          simConnectVersionMinor: 0,
        },
        handle,
      })),
    }));
    vi.resetModules();
    const mod = await import('./node-simconnect-adapter.js');
    const logger = { info: vi.fn(), warn: vi.fn() };
    const adapter = new mod.NodeSimConnectAdapter({
      definition,
      foqaGroups: ['engines'],
      unknownFoqaGroups: [],
      logger,
      maxSampleHz: 0,
    });
    const samples: unknown[] = [];
    adapter.on('sample', (sample) => samples.push(sample));
    await adapter.connect();

    const liveA220 = {
      n1_1: 98.82421768357585,
      n1_2: 98.82421768357585,
      n1_3: 0,
      n1_4: 0,
      egt_1: -55.31634114583312,
      egt_2: -55.31634114583312,
      egt_3: -273.15,
      egt_4: -273.15,
      fuel_flow_pph_1: 1.675894e-5,
      fuel_flow_pph_2: 1.675894e-5,
      fuel_flow_pph_3: 0,
      fuel_flow_pph_4: 0,
      temp_c: -55.31633758544922,
    };
    const emit = handlers.get('simObjectData');
    expect(emit).toBeTypeOf('function');
    emit?.({ requestID: 1, data: valueReader(definition, liveA220) });
    emit?.({ requestID: 1, data: valueReader(definition, liveA220) });

    const inertWarns = logger.warn.mock.calls.filter((call) =>
      String(call[0]).includes('carries no real reading'),
    );
    // 4 egt + 4 flow — по одному логу на поле за сессию, несмотря на 2 кадра.
    expect(inertWarns).toHaveLength(8);
    expect(samples).toHaveLength(2);
    expect((samples[0] as { egt_c: unknown }).egt_c).toEqual([null, null, null, null]);
    const [message, meta] = inertWarns[0] ?? [];
    expect(String(message)).toContain('TURB ENG ITT:1');
    expect(meta).toMatchObject({ field: 'egt_1', reason: 'itt_ambient' });

    await adapter.disconnect();
  });
});
