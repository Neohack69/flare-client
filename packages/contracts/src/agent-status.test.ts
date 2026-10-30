import { describe, expect, it } from 'vitest';

import {
  AGENT_STATUS_KINDS,
  agentStatusMap,
  gradeHex,
  resolveStatusKind,
  statusDescriptor,
  type AgentStatusKind,
} from './agent-status';
import type { AgentStatusEvent } from './desktop';

describe('agentStatusMap — единый источник статуса (desktop-client.md §3)', () => {
  it('покрывает все состояния', () => {
    for (const kind of AGENT_STATUS_KINDS) {
      const descriptor = agentStatusMap[kind];
      expect(descriptor.token.startsWith('--')).toBe(true);
      expect(descriptor.hex).toMatch(/^#[0-9a-f]{6}$/i);
      expect(descriptor.trayGlyph).toBe(descriptor.hex);
      expect(descriptor.i18nKey).toBe(`agent.status.${kind}`);
    }
  });

  it('токены/цвета совпадают с дизайн-таблицей (митигация расхождения трей↔сайт)', () => {
    expect(agentStatusMap.recording).toMatchObject({ token: '--accent-primary', hex: '#5b9fd4' });
    expect(agentStatusMap.auth_required).toMatchObject({ token: '--warning', hex: '#f5b942' });
    expect(agentStatusMap.not_started).toMatchObject({ token: '--text-muted', hex: '#7a88a6' });
    expect(agentStatusMap.agent_error).toMatchObject({ token: '--danger', hex: '#ff5c6c' });
  });

  it('не отдаёт FOQA-cyan #38e8ff как акцент (D20 / T176)', () => {
    for (const kind of AGENT_STATUS_KINDS) {
      const { hex, trayGlyph } = agentStatusMap[kind];
      expect(hex.toLowerCase()).not.toBe('#38e8ff');
      expect(trayGlyph.toLowerCase()).not.toBe('#38e8ff');
    }
  });

  it('grade → цвет; touchdown берёт grade-цвет', () => {
    expect(gradeHex('butter')).toBe('#ffd86b');
    expect(gradeHex(undefined)).toBe('#7a88a6');
    expect(statusDescriptor('touchdown', 'firm').hex).toBe('#a78bfa');
    expect(statusDescriptor('touchdown').hex).toBe('#56e39f');
  });
});

describe('resolveStatusKind — приоритеты состояний', () => {
  function event(state: AgentStatusEvent['state'], extra: Partial<AgentStatusEvent> = {}): AgentStatusEvent {
    return { state, ...extra };
  }

  it('agent_error > not_started > auth_required', () => {
    expect(resolveStatusKind(event('recording'), { agentRunning: true, recording: true, agentError: true })).toBe('agent_error');
    expect(resolveStatusKind(event('recording'), { agentRunning: false, recording: false })).toBe('not_started');
    expect(resolveStatusKind(event('auth_required'), { agentRunning: true, recording: false })).toBe('auth_required');
  });

  it('recording важнее sync_error/syncing; touchdown — транзиент', () => {
    expect(resolveStatusKind(event('sync_error'), { agentRunning: true, recording: true })).toBe('recording');
    expect(resolveStatusKind(event('syncing'), { agentRunning: true, recording: true })).toBe('recording');
    expect(resolveStatusKind(event('touchdown'), { agentRunning: true, recording: true })).toBe('touchdown');
  });

  it('sync_error с quality=fatal → sync_error_fatal', () => {
    expect(
      resolveStatusKind(event('sync_error', { quality: 'fatal' }), {
        agentRunning: true,
        recording: false,
      }),
    ).toBe('sync_error_fatal');
    expect(
      resolveStatusKind(event('sync_error', { quality: 'retryable' }), {
        agentRunning: true,
        recording: false,
      }),
    ).toBe('sync_error');
  });

  it('authorized транзиентно и не доминирует — маппится в connected_idle (F-102)', () => {
    expect(resolveStatusKind(event('authorized'), { agentRunning: true, recording: false })).toBe(
      'connected_idle',
    );
    // При записи на переднем плане остаётся recording.
    expect(resolveStatusKind(event('authorized'), { agentRunning: true, recording: true })).toBe(
      'recording',
    );
  });

  it('без события — sim_waiting', () => {
    expect(resolveStatusKind(null, { agentRunning: true, recording: false })).toBe('sim_waiting');
  });

  it('типы состояния покрыты картой', () => {
    const kinds: AgentStatusKind[] = [...AGENT_STATUS_KINDS];
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});
