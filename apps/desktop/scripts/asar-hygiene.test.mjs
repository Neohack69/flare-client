// ---------------------------------------------------------------------------
// asar-hygiene.test.mjs — статический guard `files` в electron-builder.yml.
//
// В asar не должны попадать исходники/тесты/sourcemap'ы workspace-зависимостей
// (`@flightlog/*`): их дублирует собранный `out/**`, они раздувают инсталлятор и
// шумят в аудите/verify-release. При этом runtime-нужное (`out/**`, `package.json`,
// `dist`) остаётся.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FLIGHTLOG_PACKAGING_EXCLUDES } from './lib/build-freshness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const builderYml = readFileSync(resolve(appRoot, 'electron-builder.yml'), 'utf8');

describe('asar hygiene: workspace-зависимости', () => {
  it('исключает src/тесты/sourcemaps/.turbo @flightlog/*', () => {
    // Список — единый источник правды (`FLIGHTLOG_PACKAGING_EXCLUDES`): он же
    // используется guard'ом свежести в verify-release.mjs. Если yml и константа
    // разойдутся — здесь падаем, чтобы не вернуть ложный «stale-build trap».
    for (const pattern of FLIGHTLOG_PACKAGING_EXCLUDES) {
      expect(builderYml).toContain(`- '!node_modules/@flightlog/*/${pattern}'`);
    }
  });

  it('сохраняет runtime-нужное: out/**, package.json', () => {
    expect(builderYml).toMatch(/^\s+- out\/\*\*\/\*\s*$/m);
    expect(builderYml).toMatch(/^\s+- package\.json\s*$/m);
    // `dist` специально НЕ исключаем: резолв `main`/`exports` идёт в dist.
    expect(builderYml).not.toContain('@flightlog/*/dist');
  });
});
