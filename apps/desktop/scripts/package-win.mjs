// ---------------------------------------------------------------------------
// package-win.mjs — обёртка над electron-builder для Windows NSIS (T110).
//
// Задача обёртки:
//   1. Явно определить, доступен ли Authenticode-сертификат (env).
//   2. Без сертификата — НЕ падать, собрать неподписанный инсталлятор и
//      напечатать заметное предупреждение (fallback до покупки сертификата).
//   3. С сертификатом — прокинуть CSC_LINK / CSC_KEY_PASSWORD в electron-builder.
//   4. Не оставлять секреты в логах: печатается только признак наличия, не значения.
//
// Переопределение env (поддерживаются оба набора имён):
//   CSC_LINK / WIN_CSC_LINK                         — base64 `.pfx` (или путь/URL);
//   CSC_KEY_PASSWORD / WIN_CSC_KEY_PASSWORD         — пароль `.pfx`;
//   WIN_CERTIFICATE_FILE / WIN_CERTIFICATE_PASSWORD — алиасы (совместимость).
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateIcons } from './generate-icons.mjs';
import {
  DEP_STAMP_RELATIVE,
  collectWorkspaceDeps,
  verifyDepSnapshot,
} from './lib/build-freshness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..');

// --- Guard: свежесть workspace-зависимостей (P0 «stale-build trap») ----------
// `apps/desktop` бандлит `@flightlog/agent`/`contracts`/`scoring`/`i18n` из их
// `dist`; устаревший `dist` один раз уже ушёл в поставку. `build:deps` пишет
// штамп с контентными хэшами `src`/`dist`; здесь сверяем его с текущим деревом и
// НЕ даём electron-builder упаковать расходящуюся сборку. Запуск без
// `build:deps`/`build` невозможен (штамп отсутствует) — упаковка «на глазок» запрещена.
function assertDepsFresh() {
  const deps = collectWorkspaceDeps(appRoot, repoRoot).filter((dep) => dep.hasBuild);
  const stampPath = join(appRoot, DEP_STAMP_RELATIVE);
  const result = verifyDepSnapshot({ stampPath, deps });
  if (result.missingStamp) {
    console.error('[freshness] ПРОВАЛ: нет штампа сборки зависимостей.');
    console.error('[freshness] Соберите зависимости: pnpm --filter @flightlog/desktop build:deps');
    console.error('[freshness] Штамп: ' + stampPath);
    process.exit(1);
  }
  if (!result.ok) {
    console.error('[freshness] ПРОВАЛ: workspace-зависимости изменились после build:deps.');
    for (const m of result.mismatches) {
      console.error(`[freshness]   ${m.name}.${m.field}: штамп ${m.stamped}, сейчас ${m.current}`);
    }
    console.error('[freshness] Пересоберите: pnpm --filter @flightlog/desktop build:deps');
    process.exit(1);
  }
  console.log(`[freshness] зависимости свежи (${deps.map((d) => d.name).join(', ')}) — ок`);
}

assertDepsFresh();

// Бандл agent-host должен существовать ДО упаковки (его строит `pnpm build`).
if (!existsSync(join(appRoot, 'out', 'main', 'agent-host.js'))) {
  console.error('[freshness] ПРОВАЛ: нет out/main/agent-host.js — сначала `pnpm build`.');
  process.exit(1);
}

// `build/` в .gitignore → в CI его нет. Генерируем иконки здесь, чтобы
// `extraResources: build/icon.ico|icon.png` (иконка окна) и `.exe`-иконка всегда были.
const icons = generateIcons({
  buildDir: resolve(appRoot, 'build'),
  trayDir: resolve(appRoot, 'resources', 'tray'),
});
console.log(`[icons] icon.png ${icons.pngSize}px + icon.ico [${icons.icoSizes.join('/')}]`);

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

const cscLink = firstNonEmpty(
  process.env.WIN_CSC_LINK,
  process.env.CSC_LINK,
  process.env.WIN_CERTIFICATE_FILE,
);
const cscPassword = firstNonEmpty(
  process.env.WIN_CSC_KEY_PASSWORD,
  process.env.CSC_KEY_PASSWORD,
  process.env.WIN_CERTIFICATE_PASSWORD,
);

const signingEnabled = Boolean(cscLink);

const env = { ...process.env };
if (signingEnabled) {
  // electron-builder: getCscLink("WIN_CSC_LINK") → WIN_CSC_LINK ?? CSC_LINK.
  env.WIN_CSC_LINK = cscLink;
  if (cscPassword) env.WIN_CSC_KEY_PASSWORD = cscPassword;
} else {
  // Не подписываем и НЕ ищем сертификат в хранилище Windows (репродуцируемость).
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

const line = '='.repeat(72);
console.log(line);
if (signingEnabled) {
  console.log('[signing] Authenticode: включена (найден CSC_LINK/WIN_CSC_LINK).');
  console.log('[signing] Пароль сертификата передан: ' + (cscPassword ? 'да' : 'нет'));
} else {
  console.log('[signing] Authenticode: ВЫКЛЮЧЕНА — сертификат не найден.');
  console.log('[signing] Инсталлятор будет собран БЕЗ подписи (forceCodeSigning=false).');
  console.log('[signing] SmartScreen может показать предупреждение при установке.');
  console.log('[signing] Требуется обязательная публикация SHA-256 (verify-release.mjs).');
  console.log('[signing] Runbook: docs/devops/release.md (Authenticode).');
  // GitHub Actions аннотация (не влияет на локальный запуск).
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(
      '::warning title=Authenticode disabled::Сертификат не задан — сборка без подписи; опубликуйте SHA-256.',
    );
  }
}
console.log(line);

const requireFromApp = createRequire(resolve(appRoot, 'package.json'));
const cli = requireFromApp.resolve('electron-builder/cli.js');

// --- electron-builder: pnpm `catalog:` → конкретная версия (T-DEP4) ----------
// electron-builder читает RAW `apps/desktop/package.json` и валидирует
// `dependencies["electron-updater"]` как semver. В монорепо там `catalog:`
// (pnpm-синтаксис) → сборка падает с «Received "catalog:"» (латентный баг
// релизного пайплайна). Подменяем значение на фактически установленную версию
// ТОЛЬКО на время запуска electron-builder и восстанавливаем исходный файл в
// finally — в git/рабочем дереве ничего не меняется.
const packageJsonPath = resolve(appRoot, 'package.json');
const packageJsonOriginal = readFileSync(packageJsonPath, 'utf8');

function resolveElectronUpdaterVersion() {
  let entry;
  try {
    entry = requireFromApp.resolve('electron-updater');
  } catch {
    return undefined;
  }
  // Ближайший package.json вверх по дереву от точки входа пакета.
  let dir = dirname(entry);
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, 'utf8')).version;
      } catch {
        return undefined;
      }
    }
    dir = dirname(dir);
  }
  return undefined;
}

const updaterVersion = resolveElectronUpdaterVersion();
let packageJsonPatched = false;
if (updaterVersion) {
  const patched = packageJsonOriginal.replace(
    /("electron-updater"\s*:\s*")([^"]*)(")/,
    (match, prefix, value, suffix) =>
      /^\d+\.\d+\.\d+/.test(value) ? match : `${prefix}${updaterVersion}${suffix}`,
  );
  if (patched !== packageJsonOriginal) {
    writeFileSync(packageJsonPath, patched, 'utf8');
    packageJsonPatched = true;
    console.log(`[builder] electron-updater "catalog:" → ${updaterVersion} на время сборки.`);
  }
}

const passthrough = process.argv.slice(2);
const args = [cli, '--win', 'nsis', '--publish', 'never', ...passthrough];

let result;
try {
  result = spawnSync(process.execPath, args, {
    cwd: appRoot,
    stdio: 'inherit',
    env,
  });
} finally {
  if (packageJsonPatched) {
    writeFileSync(packageJsonPath, packageJsonOriginal, 'utf8');
    console.log('[builder] apps/desktop/package.json восстановлен.');
  }
}

if (result.error) {
  console.error('[signing] Не удалось запустить electron-builder:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
