import { describe, expect, it } from 'vitest';

import {
  createSimSourceResolver,
  discoverSimSourceId,
  registerXPlaneSimSource,
  resolveSimSourceId,
} from '../registry.js';

describe('auto selection with both sources registered (ADR-0023 Решение 3)', () => {
  it('статический auto: оба зарегистрированы → MSFS (приоритет)', () => {
    registerXPlaneSimSource();
    expect(resolveSimSourceId({ preference: 'auto' })).toBe('msfs2024');
  });

  it('статический auto: доступен только XP → XP', () => {
    expect(resolveSimSourceId({ preference: 'auto', available: ['xplane12'] })).toBe('xplane12');
  });

  it('discoverSimSourceId: оба запущены → MSFS', async () => {
    const id = await discoverSimSourceId({
      available: ['msfs2024', 'xplane12'],
      probe: async () => true,
    });
    expect(id).toBe('msfs2024');
  });

  it('discoverSimSourceId: запущен только XP → XP', async () => {
    const id = await discoverSimSourceId({
      available: ['msfs2024', 'xplane12'],
      probe: async (candidate) => candidate === 'xplane12',
    });
    expect(id).toBe('xplane12');
  });

  it('discoverSimSourceId: запущен только MSFS → MSFS', async () => {
    const id = await discoverSimSourceId({
      available: ['msfs2024', 'xplane12'],
      probe: async (candidate) => candidate === 'msfs2024',
    });
    expect(id).toBe('msfs2024');
  });

  it('discoverSimSourceId: XP пробуется первым; при его недоступности MSFS не пробуется', async () => {
    const calls: string[] = [];
    const id = await discoverSimSourceId({
      available: ['msfs2024', 'xplane12'],
      probe: async (candidate) => {
        calls.push(candidate);
        return false;
      },
    });
    expect(id).toBe('msfs2024');
    expect(calls).toEqual(['xplane12']);
  });

  it('discoverSimSourceId: ошибка пробы = недоступно', async () => {
    const id = await discoverSimSourceId({
      available: ['msfs2024', 'xplane12'],
      probe: async (candidate) => {
        if (candidate === 'xplane12') throw new Error('boom');
        return true;
      },
    });
    expect(id).toBe('msfs2024');
  });

  it('явное предпочтение в resolveAsync не запускает дискавери', async () => {
    registerXPlaneSimSource();
    const source = await createSimSourceResolver({
      preference: 'xplane12',
      context: {},
    }).resolveAsync();
    expect(source.id).toBe('xplane12');
    expect(source.readOnly).toBe(true);
    expect(source.capabilities).toMatchObject({ sim: 'xplane12', pauseDetection: 'direct' });
  });
});
