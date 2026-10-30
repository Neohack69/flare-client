import { afterEach, describe, expect, it } from 'vitest';

import { resolveAircraftIcao, setAircraftDictionary } from './aircraft-icao.js';
import {
  buildAircraftDictionary,
  loadAircraftDictionary,
} from './aircraft-dictionary.js';

afterEach(() => {
  setAircraftDictionary(null);
});

describe('buildAircraftDictionary (T-D §6.4)', () => {
  it('сливает seed и artifact-пары, нормализуя ключи', () => {
    const merged = buildAircraftDictionary({ ' some custom plane ': 'B738' });
    expect(merged['SOME CUSTOM PLANE']).toBe('B738');
    expect(merged['BOEING 737-800']).toBe('B738');
  });
});

describe('loadAircraftDictionary — best-effort (T-D §6.4)', () => {
  it('успешная загрузка применяет learned-пары', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        version: '2026.10.12.1',
        generated_at: '2026-10-12T10:00:00Z',
        pairs: { 'SOME CUSTOM PLANE': 'A320' },
      }),
    })) as unknown as typeof fetch;

    const result = await loadAircraftDictionary({ url: 'https://x/dict.json', fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.source).toBe('remote');
    expect(result.version).toBe('2026.10.12.1');
    expect(resolveAircraftIcao({ title: 'Some Custom Plane' })).toEqual({
      icao: 'A320',
      source: 'title',
    });
  });

  it('HTTP-ошибка → встроенный словарь, без исключения', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    const result = await loadAircraftDictionary({ url: 'https://x/dict.json', fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.source).toBe('embedded');
    expect(resolveAircraftIcao({ title: 'Boeing 737-800' })).toEqual({
      icao: 'B738',
      source: 'title',
    });
  });

  it('невалидный артефакт → встроенный словарь', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) })) as unknown as typeof fetch;
    const result = await loadAircraftDictionary({ url: 'https://x/dict.json', fetchImpl });
    expect(result.ok).toBe(false);
  });

  it('таймаут (abort) → встроенный словарь, без исключения', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const result = await loadAircraftDictionary({ url: 'https://x/dict.json', fetchImpl, timeoutMs: 5 });
    expect(result.ok).toBe(false);
    expect(result.source).toBe('embedded');
  });
});
