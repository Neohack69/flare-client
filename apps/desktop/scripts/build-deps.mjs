// ---------------------------------------------------------------------------
// build-deps.mjs — сборка workspace-зависимостей ПЕРЕД сборкой `apps/desktop`.
//
// Зачем: `apps/desktop` резолвит `@flightlog/agent` (и `@flightlog/contracts`,
// `@flightlog/scoring`, `@flightlog/i18n`) в их `dist/`. Если `dist` устарел
// относительно `src`, `electron-vite build`/`build-host.mjs` вшивают в бандл
// устаревший код агента — именно так исправленный агент однажды ушёл в поставку
// НЕисправленным (P0 «stale-build trap»).
//
// Здесь:
//   1. Топологически собираем все workspace-зависимости desktop
//      (`pnpm --filter <dep> ... run build`), падаем ГРОМКО при ошибке сборки.
//   2. Пишем «штамп» `build/.dep-freshness.json` с КОНТЕНТНЫМИ хэшами `src`/`dist`
//      каждой зависимости. `package-win.mjs` и `verify-release.mjs` сверяют штамп
//      с текущим деревом и не дают упаковать расходящуюся сборку.
//
// Запуск: `pnpm --filter @flightlog/desktop build:deps`
//         (вызывается из `package:win` и из CI-шага сборки).
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEP_STAMP_RELATIVE,
  collectWorkspaceDeps,
  listFiles,
  snapshotDeps,
  writeDepStamp,
} from './lib/build-freshness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..');

const deps = collectWorkspaceDeps(appRoot, repoRoot);
const buildable = deps.filter((dep) => dep.hasBuild);

if (buildable.length === 0) {
  console.error('[build-deps] не найдено workspace-зависимостей с build-скриптом');
  process.exit(1);
}

console.log(
  `[build-deps] сборка ${buildable.length} workspace-зависимостей: ${buildable
    .map((dep) => dep.name)
    .join(', ')}`,
);

// Явные `--filter <name>` (без `^`, чтобы не ломаться на экранировании в cmd.exe);
// pnpm исполняет их в топологическом порядке (contracts → scoring → agent).
const args = ['run'];
for (const dep of buildable) args.push('--filter', dep.name);
args.push('build');

const result = spawnSync('pnpm', args, {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`[build-deps] не удалось запустить pnpm: ${result.error.message}`);
  process.exit(1);
}
if ((result.status ?? 1) !== 0) {
  console.error(`[build-deps] ПРОВАЛ: сборка зависимостей вернула код ${result.status}.`);
  process.exit(result.status ?? 1);
}

// Пустой `dist` — не «свежий»: упаковывать нечего (например, tsc не запустился).
for (const dep of buildable) {
  if (listFiles(join(dep.dir, 'dist')).length === 0) {
    console.error(`[build-deps] ПРОВАЛ: dist пуст после сборки — ${dep.name}`);
    process.exit(1);
  }
}

const stampPath = resolve(appRoot, DEP_STAMP_RELATIVE);
writeDepStamp(stampPath, { deps: snapshotDeps(buildable) });
console.log(`[build-deps] штамп свежести записан: ${stampPath}`);
