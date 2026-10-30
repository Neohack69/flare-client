import { SIM_SOURCE_ENV } from '@flightlog/agent';
import { describe, expect, it } from 'vitest';

import { buildAgentEnv } from './agent-env';

const BASE = {
  machineId: 'AbCdEfGhIjKlMnOpQrStUv',
  source: 'electron',
  version: '0.3.9',
};

describe('buildAgentEnv (ADR-0023, решение 3)', () => {
  it('прокидывает machine-id/source/version', () => {
    const env = buildAgentEnv({ baseEnv: {}, ...BASE });
    expect(env.FLIGHTLOG_MACHINE_ID).toBe(BASE.machineId);
    expect(env.AGENT_SOURCE).toBe('electron');
    expect(env.AGENT_VERSION).toBe('0.3.9');
  });

  it('прокидывает AGENT_SIM_SOURCE ровно как задал оператор (имя — константа агента)', () => {
    const env = buildAgentEnv({ baseEnv: { [SIM_SOURCE_ENV]: 'xplane12' }, ...BASE });
    expect(env[SIM_SOURCE_ENV]).toBe('xplane12');
  });

  it('ничего не выдумывает, если AGENT_SIM_SOURCE не задан', () => {
    const env = buildAgentEnv({ baseEnv: {}, ...BASE });
    expect(env[SIM_SOURCE_ENV]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(env, SIM_SOURCE_ENV)).toBe(false);
  });

  it('не нормализует регистр/пробелы — значение уходит как есть', () => {
    const env = buildAgentEnv({ baseEnv: { [SIM_SOURCE_ENV]: 'XPLANE12' }, ...BASE });
    expect(env[SIM_SOURCE_ENV]).toBe('XPLANE12');
  });

  it('FOQA-флаг прокидывается только непустым', () => {
    const on = buildAgentEnv({ baseEnv: {}, ...BASE, foqaSimvars: 'config,ils' });
    expect(on.FLIGHTLOG_FOQA_SIMVARS).toBe('config,ils');
    const off = buildAgentEnv({ baseEnv: {}, ...BASE, foqaSimvars: '   ' });
    expect(off.FLIGHTLOG_FOQA_SIMVARS).toBeUndefined();
  });
});
