// ---------------------------------------------------------------------------
// verify-release.mjs — пост-сборочная проверка Windows-релиза (T110).
//
// Проверяет:
//   * наличие NSIS-инсталлятора, `latest*.yml` и `*.blockmap` (нужны updater'у);
//   * LGPL `node-simconnect` лежит вне asar (`app.asar.unpacked`) — ADR-0011 §9;
//   * `THIRD_PARTY_NOTICES.txt` присутствует в поставке;
//   * sourcemap'ы не попали в поставку (supply-chain/размер);
//   * Authenticode-подпись (на Windows): `Valid` / явное предупреждение;
//   * считает SHA-256 и пишет `SHA256SUMS.txt` (обязателен для неподписанных
//     сборок, ADR-0011 §8.2).
//
// Запуск: `pnpm --filter @flightlog/desktop verify:release`
// Полезные env:
//   FLIGHTLOG_REQUIRE_SIGNATURE=1 — падать, если подписи нет (релиз с сертификатом).
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEP_STAMP_RELATIVE,
  asarHasFile,
  collectWorkspaceDeps,
  createPackagedDistFilter,
  hashAsarDir,
  hashDir,
  readAsarFile,
  sha256Buffer,
  sha256File,
  verifyDepSnapshot,
} from './lib/build-freshness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseDir = join(appRoot, 'release');

const problems = [];
const warnings = [];

function fail(message) {
  problems.push(message);
  console.error(`  ✗ ${message}`);
}
function warn(message) {
  warnings.push(message);
  console.warn(`  ! ${message}`);
}

if (!existsSync(releaseDir)) {
  console.error(`[verify-release] Каталог релиза не найден: ${releaseDir}`);
  console.error('[verify-release] Сначала выполните сборку: node scripts/package-win.mjs');
  process.exit(1);
}

const entries = readdirSync(releaseDir);
const installers = entries.filter((name) => /\.exe$/i.test(name));
// Ищем именно update-метаданные канала (latest.yml / beta.yml), а не
// `builder-effective-config.yaml`, который electron-builder кладёт в release/.
const ymlFiles = entries.filter((name) => /^(latest|beta)(-[\w.]+)?\.ya?ml$/i.test(name));
const blockmaps = entries.filter((name) => /\.blockmap$/i.test(name));
const sha256sums = join(releaseDir, 'SHA256SUMS.txt');

console.log(`[verify-release] release: ${releaseDir}`);
console.log(`[verify-release] installers: ${installers.length ? installers.join(', ') : 'нет'}`);
console.log(`[verify-release] update metadata: ${ymlFiles.length ? ymlFiles.join(', ') : 'нет'}`);
console.log(`[verify-release] blockmaps: ${blockmaps.length ? blockmaps.join(', ') : 'нет'}`);

// --- 1. Обязательные артефакты -------------------------------------------------
if (installers.length === 0) fail('NSIS-инсталлятор (*.exe) не найден');
if (ymlFiles.length === 0) fail('update-feed метаданные (latest*.yml) не найдены');
if (blockmaps.length === 0) warn('*.blockmap не найден — differential-обновления не будут работать');

// --- 2. Supply-chain: asarUnpack + NOTICE + отсутствие sourcemap ---------------
const unpacked = join(releaseDir, 'win-unpacked', 'resources', 'app.asar.unpacked');
const simconnect = join(unpacked, 'node_modules', 'node-simconnect');
const notices = join(releaseDir, 'win-unpacked', 'resources', 'THIRD_PARTY_NOTICES.txt');

if (!existsSync(simconnect)) {
  fail('node-simconnect не найден в app.asar.unpacked (нарушение LGPL «возможности подмены»)');
} else {
  console.log('[verify-release] LGPL node-simconnect: распакован (asarUnpack) — ок');
}
if (!existsSync(notices)) {
  fail('THIRD_PARTY_NOTICES.txt отсутствует в resources поставки');
} else {
  console.log('[verify-release] THIRD_PARTY_NOTICES.txt: присутствует — ок');
}

// Sourcemap'ы исключены конфигом `files: !out/**\/*.map`. Дёшево проверяем, что
// их нет среди распакованных ресурсов (asar целиком в память не читаем).
function findFiles(dir, predicate, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findFiles(full, predicate, acc);
    else if (predicate(entry.name)) acc.push(full);
  }
  return acc;
}
const strayMaps = findFiles(unpacked, (name) => name.endsWith('.map'));
if (strayMaps.length) {
  warn(`в app.asar.unpacked найдены sourcemap'ы (${strayMaps.length}) — проверьте files`);
}

// --- 2b. Свежесть: штамп build:deps + контент упакованного бандла --------------
// P0 «stale-build trap»: релиз мог упаковать устаревший `packages/agent/dist`.
// Сверяем (а) штамп сборки зависимостей с текущим деревом и (б) содержимое
// упакованного `app.asar` (агентский `dist` + бандлы `out/main`) с текущей сборкой.
const appAsar = join(releaseDir, 'win-unpacked', 'resources', 'app.asar');
const deps = collectWorkspaceDeps(appRoot, repoRoot).filter((dep) => dep.hasBuild);

const stampResult = verifyDepSnapshot({
  stampPath: join(appRoot, DEP_STAMP_RELATIVE),
  deps,
});
if (stampResult.missingStamp) {
  fail(
    'нет штампа свежести зависимостей (build:deps) — релиз собран без сборки workspace-зависимостей',
  );
} else if (!stampResult.ok) {
  for (const m of stampResult.mismatches) {
    fail(
      `${m.name}.${m.field} изменился после build:deps (штамп ${m.stamped}, сейчас ${m.current})`,
    );
  }
} else {
  console.log('[verify-release] штамп build:deps: совпадает с деревом — ок');
}

if (!existsSync(appAsar)) {
  fail('app.asar не найден — нельзя сверить упакованный агент с текущим деревом');
} else {
  // Фильтр зеркалит `files` из electron-builder.yml для `@flightlog/*`
  // (см. FLIGHTLOG_PACKAGING_EXCLUDES): в asar лежит только runtime-`.js`,
  // `*.test.js`/`.map`/`.d.ts` туда не попадают. Без этого `*.test.js`
  // (30 файлов в agent/dist) давали ложный «stale-build trap».
  const packagedOnly = createPackagedDistFilter();
  const agent = deps.find((dep) => dep.name === '@flightlog/agent');
  if (agent) {
    const packagedAgent = hashAsarDir(appAsar, 'node_modules/@flightlog/agent/dist', {
      filter: packagedOnly,
    });
    const localAgent = hashDir(join(agent.dir, 'dist'), { filter: packagedOnly });
    if (packagedAgent !== localAgent) {
      fail(
        'упакованный @flightlog/agent/dist (runtime .js) != текущий dist — в asar устаревший агент (stale-build trap)',
      );
    } else {
      console.log('[verify-release] @flightlog/agent/dist в asar == текущий dist — ок');
    }
  }

  for (const bundle of ['agent-host.js', 'index.js']) {
    const inner = `out/main/${bundle}`;
    const localPath = join(appRoot, 'out', 'main', bundle);
    if (!asarHasFile(appAsar, inner)) {
      fail(`в asar нет ${inner}`);
      continue;
    }
    if (!existsSync(localPath)) {
      fail(`локальный ${inner} отсутствует — не с чем сверять`);
      continue;
    }
    if (sha256Buffer(readAsarFile(appAsar, inner)) !== sha256File(localPath)) {
      fail(`упакованный ${inner} != текущий ${inner} — релиз собран не из текущего дерева`);
    } else {
      console.log(`[verify-release] ${inner} в asar == текущий — ок`);
    }
  }
}

// --- 3. Authenticode -----------------------------------------------------------
const requireSignature = process.env.FLIGHTLOG_REQUIRE_SIGNATURE === '1';
const signingConfigured = Boolean(
  (process.env.WIN_CSC_LINK || process.env.CSC_LINK || '').trim(),
);

function authenticodeStatus(file) {
  const script =
    `$s = Get-AuthenticodeSignature -FilePath "${file}"; ` +
    `if ($s) { Write-Output $s.Status } else { Write-Output 'Unknown' }`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8' },
  );
  if (result.error || result.status !== 0) return 'Unknown';
  return (result.stdout || '').trim() || 'Unknown';
}

if (process.platform === 'win32' && installers.length) {
  for (const name of installers) {
    const status = authenticodeStatus(join(releaseDir, name));
    if (status === 'Valid') {
      console.log(`[verify-release] Authenticode: ${name} — Valid`);
    } else if (requireSignature || signingConfigured) {
      fail(`Authenticode: ${name} — ${status} (ожидалась Valid подпись)`);
    } else {
      warn(`Authenticode: ${name} — ${status} (сборка без сертификата; опубликуйте SHA-256)`);
    }
  }
} else {
  console.log('[verify-release] Authenticode: проверка подписи доступна только на Windows');
}

// --- 4. SHA-256 + SHA256SUMS.txt ----------------------------------------------
const hashes = [];
for (const name of [...installers, ...ymlFiles, ...blockmaps].sort()) {
  const filePath = join(releaseDir, name);
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  hashes.push(`${hash.digest('hex')}  ${name}`);
}
if (hashes.length === 0) {
  fail('нечего хэшировать — артефакты отсутствуют');
} else {
  writeFileSync(sha256sums, `${hashes.join('\n')}\n`, 'utf8');
  console.log('[verify-release] SHA256SUMS.txt:');
  for (const line of hashes) console.log(`  ${line}`);
  if (installers.length) {
    const size = statSync(join(releaseDir, installers[0])).size / 1024 / 1024;
    console.log(`[verify-release] Размер инсталлятора: ${size.toFixed(1)} MiB`);
  }
}

// --- Итог ----------------------------------------------------------------------
if (problems.length) {
  console.error(`\n[verify-release] ПРОВАЛ: ${problems.length} проблем(ы).`);
  process.exit(1);
}
console.log(
  `\n[verify-release] OK${warnings.length ? ` (${warnings.length} предупреждений)` : ''}.`,
);
