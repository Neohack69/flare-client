import { describe, expect, it } from 'vitest';

import {
  nextSimConnected,
  readSimSourcePreference,
  resolveSimSourceKind,
  simSourceLabel,
} from './sim-source-status';

describe('resolveSimSourceKind (ADR-0023, решение 3)', () => {
  it('явный MSFS + подключение → msfs2024', () => {
    expect(resolveSimSourceKind({ preference: 'msfs2024', connected: true })).toBe('msfs2024');
  });

  it('явный X-Plane + подключение → xplane12', () => {
    expect(resolveSimSourceKind({ preference: 'xplane12', connected: true })).toBe('xplane12');
  });

  it('нет подключения: явный источник → ждём именно его; auto → обобщённое waiting', () => {
    expect(resolveSimSourceKind({ preference: 'msfs2024', connected: false })).toBe(
      'waiting_msfs2024',
    );
    expect(resolveSimSourceKind({ preference: 'xplane12', connected: false })).toBe(
      'waiting_xplane12',
    );
    // auto без подключения — бренд НЕ угадываем.
    expect(resolveSimSourceKind({ preference: 'auto', connected: false })).toBe('waiting');
  });

  it('auto + подключение → обобщённый sim_connected (бренд не угадываем)', () => {
    expect(resolveSimSourceKind({ preference: 'auto', connected: true })).toBe('sim_connected');
  });

  it('SIM-STATUS-1: auto + подключён + status.sim → конкретный сим', () => {
    expect(resolveSimSourceKind({ preference: 'auto', connected: true, source: 'xplane12' })).toBe(
      'xplane12',
    );
    expect(resolveSimSourceKind({ preference: 'auto', connected: true, source: 'msfs2024' })).toBe(
      'msfs2024',
    );
  });
});

describe('simSourceLabel (RU/EN)', () => {
  it('msfs active', () => {
    expect(simSourceLabel('ru', 'msfs2024')).toBe('MSFS 2024 (только чтение)');
    expect(simSourceLabel('en', 'msfs2024')).toBe('MSFS 2024 (read-only)');
  });

  it('xplane active', () => {
    expect(simSourceLabel('ru', 'xplane12')).toBe('X-Plane 12 (только чтение)');
    expect(simSourceLabel('en', 'xplane12')).toBe('X-Plane 12 (read-only)');
  });

  it('no sim connected', () => {
    expect(simSourceLabel('ru', 'waiting')).toBe('ждём сим');
    expect(simSourceLabel('en', 'waiting')).toBe('waiting for sim');
  });

  it('ждём конкретный сим, только если источник задан явно (RU/EN)', () => {
    expect(simSourceLabel('ru', 'waiting_msfs2024')).toBe('ждём MSFS 2024');
    expect(simSourceLabel('en', 'waiting_msfs2024')).toBe('waiting for MSFS 2024');
    expect(simSourceLabel('ru', 'waiting_xplane12')).toBe('ждём X-Plane 12');
    expect(simSourceLabel('en', 'waiting_xplane12')).toBe('waiting for X-Plane 12');
  });

  it('XC-SIM-AGNOSTIC-REGRESSION: generic waiting (auto) не называет MSFS', () => {
    const msfs = /MSFS|Microsoft Flight Simulator|FlightSimulator/i;
    for (const locale of ['ru', 'en'] as const) {
      expect(simSourceLabel(locale, 'waiting')).not.toMatch(msfs);
      expect(simSourceLabel(locale, 'sim_connected')).not.toMatch(msfs);
    }
  });

  it('auto + connected', () => {
    expect(simSourceLabel('ru', 'sim_connected')).toBe('Сим подключён (только чтение)');
    expect(simSourceLabel('en', 'sim_connected')).toBe('Sim connected (read-only)');
  });
});

describe('readSimSourcePreference', () => {
  it('распознаёт известные значения, иначе auto', () => {
    expect(readSimSourcePreference('xplane12')).toBe('xplane12');
    expect(readSimSourcePreference('MSFS2024')).toBe('msfs2024');
    expect(readSimSourcePreference('auto')).toBe('auto');
    expect(readSimSourcePreference(undefined)).toBe('auto');
    expect(readSimSourcePreference('p3d')).toBe('auto');
  });
});

describe('nextSimConnected', () => {
  it('sim-события меняют флаг, синк/authorized — сохраняют', () => {
    expect(nextSimConnected(false, 'connected_idle')).toBe(true);
    expect(nextSimConnected(true, 'recording')).toBe(true);
    expect(nextSimConnected(false, 'touchdown')).toBe(true);
    expect(nextSimConnected(true, 'sim_waiting')).toBe(false);
    expect(nextSimConnected(false, 'auth_required')).toBe(false);
    // Синк не про сим: не сбрасывает подключение.
    expect(nextSimConnected(true, 'sync_ok')).toBe(true);
    expect(nextSimConnected(true, 'syncing')).toBe(true);
    expect(nextSimConnected(true, 'sync_error')).toBe(true);
    expect(nextSimConnected(false, 'authorized')).toBe(false);
    expect(nextSimConnected(true, null)).toBe(true);
  });
});
