import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

const AGENT_SUBPATHS = [
  '@flightlog/agent',
  '@flightlog/agent/host',
  '@flightlog/agent/logging',
  '@flightlog/agent/memory-buffer',
  '@flightlog/agent/token-store',
] as const;

describe('@flightlog/agent exports', () => {
  it.each(AGENT_SUBPATHS)('resolves CJS and emits a file: %s', (subpath) => {
    const resolved = require.resolve(subpath);
    expect(existsSync(resolved)).toBe(true);
  });

  it('resolves ESM subpath used by the agent-host', async () => {
    const mod = await import('@flightlog/agent/logging');
    expect(typeof mod.createConsoleLogger).toBe('function');
  });
});
