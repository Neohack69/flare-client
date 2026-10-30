// ---------------------------------------------------------------------------
// verify-native.mjs — проверка, что agent-host сможет загрузить нативные/сим-
// зависимости внутри Electron: `better-sqlite3` (N-API) и `node-simconnect`.
//
// Контекст:
//   * `better-sqlite3` 13.x — N-API (ABI-стабильный) с prebuild'ами в npm-тарболе:
//     один `.node` грузится и в Node (agent/тесты), и в Electron — rebuild под
//     ABI Electron (`@electron/rebuild`) не нужен;
//   * `node-simconnect` — чистый JS-клиент SimConnect (нативных аддонов нет).
//
// Скрипт — регрессионный guard: реально запускает Electron
// (`ELECTRON_RUN_AS_NODE`), грузит оба модуля из `apps/desktop` и выполняет
// запрос к SQLite + проверяет `import('node-simconnect')`.
//
// Запуск: `pnpm --filter @flightlog/desktop verify:native`.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const requireFromApp = createRequire(join(appRoot, 'package.json'));

function fail(message) {
  console.error(`[verify-native] ПРОВАЛ: ${message}`);
  process.exit(1);
}

const packageJson = requireFromApp('better-sqlite3/package.json');
const version = packageJson.version;
const hasNapiDep = Boolean(packageJson.dependencies?.['node-addon-api']);

const resolvedDir = dirname(requireFromApp.resolve('better-sqlite3/package.json'));
const hasPrebuild = existsSync(
  join(resolvedDir, 'prebuilds', `${process.platform}-${process.arch}.node`),
);

if (!hasNapiDep) {
  fail(
    `better-sqlite3 ${version} не является N-API-сборкой. Для Electron нужен 13.x ` +
      '(ABI-независимый prebuild). Проверьте версию в apps/desktop/package.json.',
  );
}
if (!hasPrebuild) {
  fail(
    `нет prebuild для ${process.platform}-${process.arch} ` +
      `(${join(resolvedDir, 'prebuilds')}). Возможно, платформа не покрыта npm-тарболом.`,
  );
}

// Оба модуля должны быть объявлены в apps/desktop (иначе agent-host не зарезолвит).
for (const spec of ['better-sqlite3', 'node-simconnect']) {
  try {
    requireFromApp.resolve(`${spec}/package.json`);
  } catch {
    fail(`${spec} не резолвится из apps/desktop — объявите его в dependencies.`);
  }
}

const electronPath = requireFromApp('electron');
const probe = [
  "(async () => {",
  "  const Database = require('better-sqlite3');",
  "  const db = new Database(':memory:');",
  "  db.exec('CREATE TABLE t(x INTEGER)');",
  "  db.prepare('INSERT INTO t VALUES (?)').run(41);",
  "  const row = db.prepare('SELECT x + 1 AS y FROM t').get();",
  "  const sim = await import('node-simconnect');",
  "  if (typeof sim.open !== 'function') throw new Error('node-simconnect: missing open() export');",
  "  console.log(JSON.stringify({ y: row.y, open: typeof sim.open, modules: process.versions.modules, napi: process.versions.napi }));",
  "})().catch((error) => { console.error(error && error.message ? error.message : String(error)); process.exit(1); });",
].join('\n');

const result = spawnSync(electronPath, ['-e', probe], {
  cwd: appRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
});

if (result.error) fail(result.error.message);
if (result.status !== 0) {
  fail(
    `Electron не смог загрузить зависимости: ` +
      `${(result.stderr || '').trim() || `exit ${result.status}`}`,
  );
}

console.log(
  `[verify-native] ок: better-sqlite3 ${version} (${process.platform}-${process.arch}) ` +
    `и node-simconnect грузятся в Electron; ${result.stdout.trim()}`,
);
