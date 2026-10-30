#!/usr/bin/env node
/**
 * Supply-chain (T76): запрет сильного copyleft в зависимостях.
 *
 * Читает `pnpm licenses list --json` и валит сборку, если найдены токены
 * семейства GPL / AGPL / SSPL. Слабый copyleft (LGPL, MPL) осознанно НЕ запрещён —
 * он отмечен в docs/security/licensing.md и требует атрибуции, не заражения.
 *
 * Запуск: node scripts/check-licenses.mjs
 *
 * ВАЖНО (T23/T76):
 *   `pnpm licenses list` читает УЖЕ УСТАНОВЛЕННОЕ дерево. В CI ставить зависимости
 *   для этого чека нужно с `--ignore-scripts` (нативные сборки не нужны) и на Node,
 *   удовлетворяющем `engines` всех зависимостей из lockfile (сейчас >=22.20 из-за
 *   транзитивной `@napi-rs/lzma-linux-x64-gnu@1.5.1`). Иначе pnpm может вернуть
 *   структурную ошибку `ERR_PNPM_MISSING_PACKAGE_INDEX_FILE`; она разбирается ниже
 *   и печатается понятным текстом. Политика проверки при этом НЕ ослабляется:
 *   любая ошибка pnpm — это падение job'а, а не «проходим мимо».
 */
import { spawnSync } from 'node:child_process';

/** Токен лицензии начинается с GPL/AGPL/SSPL → сильный copyleft. LGPL/MPL не матчатся. */
const DENY_TOKEN = /^(A?GPL|SSPL)(-|$)/i;

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

const result = spawnSync('pnpm', ['licenses', 'list', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  // На Windows `pnpm` — это pnpm.cmd, поэтому нужен shell.
  shell: process.platform === 'win32',
});

const stdout = (result.stdout ?? '').trim();

// pnpm 9.15.9 при пропущенной опциональной зависимости (несовпадение engines/os/cpu)
// пишет в stdout валидный JSON `{ "error": { "code", "message" } }` и завершается с
// ненулевым кодом, оставляя stderr ПУСТЫМ. Разбираем этот случай до проверки статуса.
const parsed = stdout ? parseJson(stdout) : { ok: false };
const pnpmError =
  parsed.ok &&
  parsed.value !== null &&
  typeof parsed.value === 'object' &&
  !Array.isArray(parsed.value) &&
  parsed.value.error &&
  typeof parsed.value.error === 'object'
    ? parsed.value.error
    : null;

if (pnpmError) {
  console.error(`pnpm licenses list завершился ошибкой: ${pnpmError.code ?? 'UNKNOWN'}`);
  if (pnpmError.message) console.error(`  ${pnpmError.message}`);
  if (pnpmError.code === 'ERR_PNPM_MISSING_PACKAGE_INDEX_FILE') {
    console.error(
      'Причина: опциональная зависимость из lockfile не установлена (несовпадение ' +
        'engines/os/cpu для текущего Node). Переустановите дерево на Node, ' +
        'удовлетворяющем engines: `pnpm install --frozen-lockfile --ignore-scripts`. ' +
        'См. docs/security/licensing.md.',
    );
  } else {
    console.error('Прогоните `pnpm install --frozen-lockfile` и повторите проверку.');
  }
  process.exit(1);
}

if (result.error || !parsed.ok) {
  console.error('Не удалось получить список лицензий через `pnpm licenses list --json`.');
  console.error(result.error?.message || result.stderr?.trim() || `exit=${result.status}`);
  process.exit(1);
}

if (result.status !== 0) {
  // Валидный license-map при ненулевом exit — pnpm вывел предупреждения в stderr.
  // Скан корректен, но фиксируем это в логе, чтобы не терять контекст.
  console.warn(
    `pnpm licenses list завершился с кодом ${result.status}, но JSON получен — продолжаю.`,
  );
  if (result.stderr?.trim()) console.warn(result.stderr.trim());
}

const data = parsed.value;

const denied = [];
for (const [license, packages] of Object.entries(data)) {
  const tokens = license
    .toString()
    .split(/[\s()]+/)
    .filter(Boolean);
  if (!tokens.some((token) => DENY_TOKEN.test(token))) continue;
  for (const pkg of packages) {
    denied.push(`  - ${pkg.name}@${(pkg.versions ?? []).join(',')} — ${license}`);
  }
}

if (denied.length > 0) {
  console.error('Найдены зависимости с сильным copyleft (GPL/AGPL/SSPL):');
  console.error(denied.join('\n'));
  console.error('См. docs/security/licensing.md.');
  process.exit(1);
}

const licenseCount = Object.keys(data).length;
console.log(
  `Лицензии ок: сильный copyleft (GPL/AGPL/SSPL) не обнаружен (${licenseCount} вариантов лицензий).`,
);
