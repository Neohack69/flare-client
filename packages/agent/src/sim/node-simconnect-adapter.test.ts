import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BASE_SIMVAR_DEFINITION,
  canonicalMsfsAttitude,
  createResilientReader,
  detectSimVarLayoutMismatch,
  expectedSimVarLayoutSize,
  parseSample,
  parseSampleWithMeta,
  type SimVarDefinition,
  type SimVarReader,
} from './node-simconnect-adapter.js';
import { MockSimConnectAdapter } from './mock-adapter.js';
import { makeSample } from '../testing/telemetry-fixture.js';

const TS = '2026-09-23T12:00:00.000Z';

/**
 * Тестовый набор SimVars пришпилен к базе known-good 0.3.6 (29 полей / 940 байт)
 * и передаётся в парсер/детекторы явно.
 *
 * Модульный `SIMVAR_DEFINITION` env-зависим (`FLIGHTLOG_FOQA_SIMVARS` включается
 * оператором) и меняет и layout, и число полей. Тесты обязаны быть герметичными:
 * иначе suite краснеет у любого, у кого включён FOQA opt-in, и маскирует реальные
 * поломки. Поэтому здесь никогда не читаем ambient env, а используем константу.
 */
const DEFINITION = BASE_SIMVAR_DEFINITION;

const VALUES: Record<string, number> = {
  lat: 55.9721,
  lon: 37.4143,
  alt_ft: 1250.5,
  agl_ft: 310.25,
  gs_kt: 148.4,
  ias_kt: 141.2,
  vs_fpm: -712,
  heading_deg: 245.6,
  // MSFS raw: отрицательный pitch = нос вверх, положительный bank = левый крен.
  pitch_deg: -2.4,
  bank_deg: 1.7,
  g: 1.08,
  on_ground: 0,
  gear_down: 1,
  fuel_qty_gal: 182.5,
  engine_running: 1,
  engine_2: 1,
  engine_3: 0,
  engine_4: 0,
  slew: 0,
  wind_dir_deg: 245.5,
  wind_speed_kt: 12.5,
  temp_c: 14.2,
  qnh_hpa: 1013.2,
  precip: 4,
  visibility_m: 9000,
  in_cloud: 1,
};

const STRINGS: Record<string, string> = {
  atc_model: 'Boeing 737-800',
  atc_type: 'B738',
  title: 'Boeing 737-800 Asobo',
};

function scriptedReader(
  values: Record<string, number>,
  onRead?: (field: string, type: 'float64' | 'int32' | 'string256') => void,
  strings: Record<string, string> = STRINGS,
): SimVarReader {
  let index = 0;
  const take = (type: 'float64' | 'int32' | 'string256') => {
    const def = DEFINITION[index];
    index += 1;
    if (!def) throw new Error('read past definition');
    onRead?.(def.field, type);
    return def;
  };
  return {
    readFloat64: () => {
      const def = take('float64');
      return values[def.field] ?? Number.NaN;
    },
    readInt32: () => {
      const def = take('int32');
      return values[def.field] ?? 0;
    },
    readString256: () => {
      const def = take('string256');
      return strings[def.field] ?? '';
    },
  };
}

/**
 * Мини-модель `RawBuffer`: читает поля по `DEFINITION` (база 0.3.6) и бросает
 * `RangeError`, если поле не влезает в `limit`. При `exposeRemaining` отдаёт
 * `remaining()`, как настоящий RawBuffer, — тогда парсер должен заметить обрез
 * заранее и не доводить чтение до исключения.
 */
function truncatedReader(limit: number, exposeRemaining = true): SimVarReader {
  let index = 0;
  let offset = 0;
  const sizeOf = (type: SimVarDefinition['type']): number => {
    if (type === 'string256') return 256;
    if (type === 'int32') return 4;
    return 8;
  };
  const take = () => {
    const def = DEFINITION[index];
    if (!def) throw new Error('read past definition');
    const size = sizeOf(def.type);
    if (offset + size > limit) {
      throw new RangeError(`Illegal offset: 0 <= ${offset} (+${size}) <= ${limit}`);
    }
    offset += size;
    index += 1;
    return def;
  };
  const base: SimVarReader = {
    readFloat64: () => VALUES[take().field] ?? Number.NaN,
    readInt32: () => VALUES[take().field] ?? 0,
    readString256: () => STRINGS[take().field] ?? '',
  };
  return exposeRemaining ? { ...base, remaining: () => limit - offset } : base;
}

describe('SIMVAR_DEFINITION layout', () => {
  it('ожидаемый размер известного набора — 940 байт (17×f64 + 9×i32 + 3×string256)', () => {
    const floats = DEFINITION.filter((def) => def.type === 'float64').length;
    const ints = DEFINITION.filter((def) => def.type === 'int32').length;
    const strings = DEFINITION.filter((def) => def.type === 'string256').length;
    expect({ floats, ints, strings }).toEqual({ floats: 17, ints: 9, strings: 3 });
    expect(expectedSimVarLayoutSize(DEFINITION)).toBe(17 * 8 + 9 * 4 + 3 * 256);
    expect(expectedSimVarLayoutSize(DEFINITION)).toBe(940);
  });

  it('detectSimVarLayoutMismatch находит первое поле, не помещающееся в буфер', () => {
    expect(detectSimVarLayoutMismatch(940, DEFINITION)).toBeNull();
    expect(detectSimVarLayoutMismatch(936, DEFINITION)).toMatchObject({
      expectedBytes: 940,
      actualBytes: 936,
      truncated: true,
      fieldIndex: 28,
      simVar: 'TITLE',
    });
  });

  it('обрез на 4 байта (отвергнутый int32) даёт диагностику хвоста', () => {
    const mismatch = detectSimVarLayoutMismatch(936, DEFINITION);
    expect(mismatch?.field).toBe('title');
    expect(mismatch?.unit).toBeNull();
  });
});

describe('parseSample', () => {
  it('читает SimVars в порядке data definition и конвертирует поля', () => {
    const reader = scriptedReader(VALUES);
    const sample = parseSample(reader, TS, DEFINITION);

    expect(sample).toMatchObject({
      ts: TS,
      lat: 55.9721,
      lon: 37.4143,
      alt_ft: 1250.5,
      agl_ft: 310.25,
      gs_kt: 148.4,
      ias_kt: 141.2,
      vs_fpm: -712,
      heading_deg: 245.6,
      pitch_deg: 2.4,
      bank_deg: -1.7,
      g: 1.08,
      on_ground: false,
      gear_down: true,
      fuel_qty_gal: 182.5,
      engine_running: true,
      engines_running: 2,
      atc_model: 'Boeing 737-800',
      atc_type: 'B738',
      title: 'Boeing 737-800 Asobo',
      wind_dir_deg: 245.5,
      wind_speed_kt: 12.5,
      wind_gust_kt: null,
      temp_c: 14.2,
      qnh_hpa: 1013.2,
      precip: 4,
      visibility_m: 9000,
      in_cloud: true,
      slew: false,
    });
  });

  it('нормализует знак MSFS: набор высоты → pitch > 0, левый крен → bank < 0', () => {
    const climbingLeftTurn = { ...VALUES, pitch_deg: -8.5, bank_deg: 30 };
    const sample = parseSample(scriptedReader(climbingLeftTurn), TS, DEFINITION);
    expect(sample.pitch_deg).toBe(8.5);
    expect(sample.bank_deg).toBe(-30);
  });

  it('canonicalMsfsAttitude инвертирует только знак, не величину', () => {
    expect(canonicalMsfsAttitude(-5.645, 0.23)).toEqual({
      pitch_deg: 5.645,
      bank_deg: -0.23,
    });
  });

  it('детектит все выключенные двигатели и читает ATC MODEL/TYPE/TITLE', () => {
    const off = { ...VALUES, engine_running: 0, engine_2: 0 };
    const sample = parseSample(scriptedReader(off, undefined, {}), TS, DEFINITION);
    expect(sample.engines_running).toBe(0);
    expect(sample.engine_running).toBe(false);
    expect(sample.atc_model).toBeNull();
    expect(sample.atc_type).toBeNull();
    expect(sample.title).toBeNull();
  });

  it('использует правильный тип чтения для каждой переменной', () => {
    const reads: Array<{ field: string; type: string }> = [];
    parseSample(
      scriptedReader(VALUES, (field, type) => reads.push({ field, type })),
      TS,
      DEFINITION,
    );

    expect(reads).toEqual(DEFINITION.map((def) => ({ field: def.field, type: def.type })));
    const boolFields = DEFINITION.filter((def) => def.type === 'int32').map((d) => d.field);
    expect(boolFields).toEqual([
      'on_ground',
      'gear_down',
      'engine_running',
      'engine_2',
      'engine_3',
      'engine_4',
      'slew',
      'precip',
      'in_cloud',
    ]);
    const stringFields = DEFINITION.filter((def) => def.type === 'string256').map((d) => d.field);
    expect(stringFields).toEqual(['atc_model', 'atc_type', 'title']);
  });

  it('WAVE 3b/4 SimVars не читаются (убраны до live-валидации) → null, не 0', () => {
    const sample = parseSample(scriptedReader(VALUES), TS, DEFINITION);
    expect(sample.total_weight_lb).toBeNull();
    expect(sample.flaps_index).toBeNull();
    expect(sample.flaps_percent).toBeNull();
    expect(sample.spoilers_percent).toBeNull();
    expect(sample.spoilers_armed).toBeNull();
    expect(sample.gear_position).toEqual([null, null, null]);
    expect(sample.n1_percent).toEqual([null, null, null, null]);
    expect(sample.egt_c).toEqual([null, null, null, null]);
    expect(sample.fuel_flow_pph).toEqual([null, null, null, null]);
    expect(sample.elevator_position).toBeNull();
    expect(sample.autopilot_master).toBeNull();
    expect(sample.autothrottle_active).toBeNull();
    expect(sample.incidence_alpha_rad).toBeNull();
    expect(sample.surface_condition).toBeNull();
    expect(sample.radio_height_ft).toBeNull();
    expect(sample.cg_percent).toBeNull();
    expect(sample.atc_runway_heading_deg).toBeNull();
  });

  it('преобразует не-конечные опциональные значения в null', () => {
    const nan = {
      ...VALUES,
      agl_ft: Number.NaN,
      ias_kt: Number.NaN,
      vs_fpm: Number.NaN,
    };
    const sample = parseSample(scriptedReader(nan), TS, DEFINITION);
    expect(sample.agl_ft).toBeNull();
    expect(sample.ias_kt).toBeNull();
    expect(sample.vs_fpm).toBeNull();
    expect(sample.total_weight_lb).toBeNull();
  });

  it('нормализует погодные SimVars и не отдаёт отрицательные', () => {
    const weather = {
      ...VALUES,
      wind_dir_deg: 370,
      wind_speed_kt: -3,
      visibility_m: Number.NaN,
      in_cloud: 0,
    };
    const sample = parseSample(scriptedReader(weather), TS, DEFINITION);
    expect(sample.wind_dir_deg).toBe(10);
    expect(sample.wind_speed_kt).toBeNull();
    expect(sample.visibility_m).toBeNull();
    expect(sample.in_cloud).toBe(false);
    expect(sample.wind_gust_kt).toBeNull();
  });

  it('не отдаёт отрицательные скорости/перегрузку', () => {
    const negative = { ...VALUES, gs_kt: -5, g: -0.4 };
    const sample = parseSample(scriptedReader(negative), TS, DEFINITION);
    expect(sample.gs_kt).toBe(0);
    expect(sample.g).toBe(0);
  });

  it('SIM ON GROUND = 1 трактуется как на земле', () => {
    const sample = parseSample(scriptedReader({ ...VALUES, on_ground: 1 }), TS, DEFINITION);
    expect(sample.on_ground).toBe(true);
  });
});

describe('resilience to short/truncated buffers', () => {
  it('parseSample не бросает на обрезанном буфере и деградирует в null', () => {
    expect(() => parseSample(truncatedReader(104), TS, DEFINITION)).not.toThrow();

    const { sample, layoutMismatch } = parseSampleWithMeta(truncatedReader(104), TS, DEFINITION);
    expect(sample.lat).toBe(55.9721);
    expect(sample.on_ground).toBe(false);
    expect(sample.fuel_qty_gal).toBe(182.5);
    expect(sample.wind_dir_deg).toBeNull();
    expect(sample.temp_c).toBeNull();
    expect(sample.title).toBeNull();
    expect(sample.engines_running).toBe(0);
    expect(layoutMismatch).toMatchObject({
      expectedBytes: 940,
      actualBytes: 104,
      truncated: true,
      fieldIndex: 14,
      simVar: 'GENERAL ENG COMBUSTION:1',
    });
  });

  it('без remaining() чтение за границей перехватывается (try/catch) и не бросает', () => {
    const { sample, layoutMismatch } = parseSampleWithMeta(
      truncatedReader(104, false),
      TS,
      DEFINITION,
    );
    expect(sample.lat).toBe(55.9721);
    expect(sample.fuel_qty_gal).toBe(182.5);
    expect(sample.wind_dir_deg).toBeNull();
    expect(sample.title).toBeNull();
    expect(layoutMismatch?.truncated).toBe(true);
  });

  it('createResilientReader отдаёт undefined для полей за границей', () => {
    // 104 байта = 11 float64 + 2 int32 + fuel (float64); дальше — обрез.
    const { reader, layoutMismatch } = createResilientReader(truncatedReader(104), DEFINITION);
    for (let i = 0; i < 11; i += 1) expect(reader.readFloat64()).toBeTypeOf('number');
    expect(reader.readInt32()).toBe(0); // SIM ON GROUND
    expect(reader.readInt32()).toBe(1); // GEAR HANDLE POSITION
    expect(reader.readFloat64()).toBe(182.5); // FUEL TOTAL QUANTITY
    expect(reader.readInt32()).toBeUndefined(); // GENERAL ENG COMBUSTION:1 за границей
    expect(reader.readFloat64()).toBeUndefined();
    expect(layoutMismatch()).not.toBeNull();
  });

  it('полный буфер деградации не даёт', () => {
    const { sample, layoutMismatch } = parseSampleWithMeta(truncatedReader(940), TS, DEFINITION);
    expect(layoutMismatch).toBeNull();
    expect(sample.title).toBe('Boeing 737-800 Asobo');
  });
});

describe('MockSimConnectAdapter', () => {
  it('публикует open/sample и перестаёт публиковать после disconnect', async () => {
    const adapter = new MockSimConnectAdapter();
    const onOpen = vi.fn();
    const onSample = vi.fn();
    const onDisconnect = vi.fn();
    adapter.on('open', onOpen);
    adapter.on('sample', onSample);
    adapter.on('disconnect', onDisconnect);

    expect(adapter.connected).toBe(false);
    const info = await adapter.connect();
    expect(adapter.connected).toBe(true);
    expect(info.applicationName).toContain('mock');
    expect(onOpen).toHaveBeenCalledTimes(1);

    adapter.pushSample(makeSample(TS));
    expect(onSample).toHaveBeenCalledTimes(1);

    await adapter.disconnect();
    expect(adapter.connected).toBe(false);
    expect(onDisconnect).toHaveBeenCalledWith('mock disconnect');

    adapter.pushSample(makeSample(TS));
    expect(onSample).toHaveBeenCalledTimes(1);
  });

  it('эмулирует разрыв и ошибку', async () => {
    const adapter = new MockSimConnectAdapter();
    const onDisconnect = vi.fn();
    const onError = vi.fn();
    adapter.on('disconnect', onDisconnect);
    adapter.on('error', onError);
    await adapter.connect();

    adapter.simulateError(new Error('boom'));
    adapter.simulateDisconnect('lost');
    expect(onError).toHaveBeenCalledWith(new Error('boom'));
    expect(onDisconnect).toHaveBeenCalledWith('lost');
    expect(adapter.connected).toBe(false);
  });
});

describe('герметичность к ambient FLIGHTLOG_FOQA_SIMVARS', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /**
   * Регресс-гард класса бага: module-level `SIMVAR_DEFINITION` вычисляется из
   * ambient env при импорте, поэтому тесты, которые на него полагаются, краснеют
   * у любого оператора с включённым FOQA opt-in и «прячут» реальные поломки.
   *
   * Тест воспроизводит failure mode детерминированно (на любой машине): ставит
   * `FLIGHTLOG_FOQA_SIMVARS=all`, сбрасывает модульный кеш и импортирует модуль
   * заново — свежий runtime-набор обязан стать полным (90 полей / 1380 Б). При этом
   * тестовый `DEFINITION` остаётся базой (29 / 940), и парсер по нему не видит
   * FOQA-полей. Если кто-то снова завяжет тесты на ambient env вместо
   * инжектированной базы, этот инвариант сломается.
   */
  it('инжектированная база (29/940) не зависит от env, хотя runtime-набор модуля — зависит', async () => {
    vi.stubEnv('FLIGHTLOG_FOQA_SIMVARS', 'all');
    vi.resetModules();
    const mod = await import('./node-simconnect-adapter.js');

    // ambient env реально управляет runtime-набором модуля (корень бага)…
    expect(mod.ENABLED_FOQA_GROUPS).toEqual(mod.FOQA_GROUP_ORDER);
    expect(mod.SIMVAR_DEFINITION.length).toBeGreaterThan(DEFINITION.length);
    expect(mod.SIMVAR_DEFINITION).toHaveLength(90);
    expect(mod.expectedSimVarLayoutSize()).toBe(1380);

    // …но тесты пришпилены к базе и ambient env не читают.
    expect(DEFINITION).toBe(BASE_SIMVAR_DEFINITION);
    expect(DEFINITION).toHaveLength(29);
    expect(expectedSimVarLayoutSize(DEFINITION)).toBe(940);
    expect(detectSimVarLayoutMismatch(940, DEFINITION)).toBeNull();

    const sample = parseSample(scriptedReader(VALUES), TS, DEFINITION);
    expect(sample.total_weight_lb).toBeNull();
    expect(sample.flaps_index).toBeNull();
    expect(sample.egt_c).toEqual([null, null, null, null]);
  });
});
