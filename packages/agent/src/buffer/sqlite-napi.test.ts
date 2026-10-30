import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

/**
 * Регресс-гвард для Electron-dev: `better-sqlite3` обязан быть Node-API-сборкой
 * (ABI-стабильной) с prebuild'ом в npm-тарболе. Если кто-то вернёт не-N-API
 * версию (12.x), agent-host под Electron снова начнёт падать на несовпадении ABI.
 * Полная проверка загрузки в Electron — `pnpm --filter @flightlog/desktop verify:native`.
 */
describe('better-sqlite3 native build', () => {
  it('is a Node-API build with a prebuilt binary for the current platform', () => {
    const manifest = require('better-sqlite3/package.json') as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.['node-addon-api']).toBeDefined();

    const packageDir = dirname(require.resolve('better-sqlite3/package.json'));
    const prebuilds = readdirSync(join(packageDir, 'prebuilds'));
    const target = `${process.platform}-${process.arch}.node`;
    const candidates = [target, `linuxmusl-${process.arch}.node`];
    expect(prebuilds.some((file) => candidates.includes(file))).toBe(true);
  });
});
