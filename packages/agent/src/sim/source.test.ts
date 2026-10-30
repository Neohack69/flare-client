import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockSimConnectAdapter } from './mock-adapter.js';
import {
  createSimSourceResolver,
  listRegisteredSimSources,
  parseSimSourcePreference,
  registerSimSource,
  registerXPlaneSimSource,
  resolveSimSourceId,
  unregisterSimSource,
} from './registry.js';
import { SIM_SOURCE_ENV } from './source.js';

function capturingLogger() {
  const entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  return {
    entries,
    debug: (message: string, meta?: Record<string, unknown>) =>
      entries.push({ level: 'debug', message, meta }),
    info: (message: string, meta?: Record<string, unknown>) =>
      entries.push({ level: 'info', message, meta }),
    warn: (message: string, meta?: Record<string, unknown>) =>
      entries.push({ level: 'warn', message, meta }),
    error: (message: string, meta?: Record<string, unknown>) =>
      entries.push({ level: 'error', message, meta }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  // Восстанавливаем встроенную XP-регистрацию: тесты могут её снимать/подменять.
  registerXPlaneSimSource();
});

describe('SimSource registry (ADR-0023 §3)', () => {
  it('MSFS и X-Plane 12 зарегистрированы; `auto` резолвится в MSFS при незаданном env', () => {
    expect(listRegisteredSimSources()).toEqual(['msfs2024', 'xplane12']);

    const parsed = parseSimSourcePreference(undefined);
    expect(parsed).toEqual({ preference: 'auto', unknown: null });

    const id = resolveSimSourceId({ preference: parsed.preference });
    expect(id).toBe('msfs2024');

    const source = createSimSourceResolver({ envRaw: null, context: {} }).resolve();
    expect(source.id).toBe('msfs2024');
    expect(source.readOnly).toBe(true);
    expect(source.capabilities).toMatchObject({
      sim: 'msfs2024',
      pauseDetection: 'gap',
      adapter: 'simconnect-sunrise',
    });
  });

  it('AGENT_SIM_SOURCE=msfs2024 явно выбирает MSFS', () => {
    const parsed = parseSimSourcePreference('msfs2024');
    expect(parsed).toEqual({ preference: 'msfs2024', unknown: null });

    const logger = capturingLogger();
    const source = createSimSourceResolver({ envRaw: 'msfs2024', logger, context: {} }).resolve();
    expect(source.id).toBe('msfs2024');
    expect(logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(0);
  });

  it('неизвестное значение AGENT_SIM_SOURCE → warning + фолбэк на дефолт (не падает)', () => {
    const logger = capturingLogger();
    const parsed = parseSimSourcePreference('bogus-sim');
    expect(parsed).toEqual({ preference: 'auto', unknown: 'bogus-sim' });

    const source = createSimSourceResolver({ envRaw: 'bogus-sim', logger, context: {} }).resolve();
    expect(source.id).toBe('msfs2024');

    const warnings = logger.entries.filter((entry) => entry.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      `${SIM_SOURCE_ENV}: unknown value 'bogus-sim' ` +
        `(known: auto, msfs2024, xplane12); falling back to 'auto' -> 'msfs2024'`,
    );
    expect(warnings[0]?.meta).toMatchObject({ requested: 'bogus-sim', fallback: 'msfs2024' });
  });

  it('известный, но незарегистрированный источник (xplane12) → warning + фолбэк', () => {
    unregisterSimSource('xplane12');
    const logger = capturingLogger();
    const id = resolveSimSourceId({ preference: 'xplane12', logger });
    expect(id).toBe('msfs2024');

    const warnings = logger.entries.filter((entry) => entry.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      `${SIM_SOURCE_ENV}: source 'xplane12' is not registered yet ` +
        `(registered: msfs2024); falling back to 'msfs2024'`,
    );
  });

  it('инвариант: ровно один инстанс источника на резолвер, даже при повторном resolve()', () => {
    const create = vi.fn(() => new MockSimConnectAdapter());
    registerSimSource({ id: 'xplane12', label: 'test xp', create });

    const resolver = createSimSourceResolver({ preference: 'xplane12', context: {} });
    const first = resolver.resolve();
    const second = resolver.resolve();

    expect(second).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('parseSimSourcePreference: пусто/пробелы → auto; case-insensitive', () => {
    expect(parseSimSourcePreference('')).toEqual({ preference: 'auto', unknown: null });
    expect(parseSimSourcePreference('   ')).toEqual({ preference: 'auto', unknown: null });
    expect(parseSimSourcePreference(null)).toEqual({ preference: 'auto', unknown: null });
    expect(parseSimSourcePreference('MSFS2024')).toEqual({
      preference: 'msfs2024',
      unknown: null,
    });
  });
});
