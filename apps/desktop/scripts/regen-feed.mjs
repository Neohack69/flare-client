// ---------------------------------------------------------------------------
// regen-feed.mjs — пересборка update-фида electron-updater ПОСЛЕ внешней подписи.
//
// Почему это обязательно: `electron-builder` пишет `latest.yml`/`beta.yml` ДО
// того, как SignPath добавит Authenticode-таблицу в exe. Подпись меняет байты,
// поэтому `sha512` и `size` в фиде становятся неверными — `electron-updater`
// отклонит обновление. Здесь метаданные пересчитываются от ПОДПИСАННОГО файла.
//
// Записывает:
//   <release>/<channel>.yml   version, files[{url,sha512,size}], path, sha512, releaseDate
//   <release>/SHA256SUMS.txt  SHA-256 установщика и фида (и blockmap, если оставлен)
//
// Устаревший `.blockmap` (посчитан от неподписанных байтов) по умолчанию
// удаляется: дифференциальное обновление по нему сломается, публиковать его
// нельзя. Обновления идут полным скачиванием. `--keep-blockmap` — только для
// отладки, в релиз такой blockmap не идёт.
//
// Использование:
//   node apps/desktop/scripts/regen-feed.mjs --channel latest
//   node apps/desktop/scripts/regen-feed.mjs --channel beta --release-dir release
//   node apps/desktop/scripts/regen-feed.mjs --channel latest --verify
//   node apps/desktop/scripts/regen-feed.mjs --exe path/to/Flare-Setup-1.2.3.exe
//
// Флаги:
//   --channel <latest|beta>  канал (по умолчанию latest)
//   --release-dir <dir>      каталог релиза (по умолчанию apps/desktop/release)
//   --exe <file>             установщик (по умолчанию Flare-Setup-<version>.exe)
//   --version <x.y.z>        ожидаемая версия (сверяется с package.json)
//   --date <ISO>             releaseDate (по умолчанию текущее время UTC)
//   --verify                 только проверить существующий фид против exe
//   --keep-blockmap          не удалять устаревший .blockmap
//   --help                   справка
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-.+][0-9A-Za-z.-]+)?$/;
const EXE_RE = /^[A-Za-z0-9._-]+\.exe$/;

export function sha512Base64File(filePath) {
  return createHash('sha512').update(readFileSync(filePath)).digest('base64');
}

export function sha256HexFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Формат `latest.yml`, который пишет electron-builder (generic provider). */
export function buildFeedYaml({ version, fileName, sha512, size, releaseDate }) {
  if (!VERSION_RE.test(version)) throw new Error(`Некорректная версия: ${version}`);
  if (!EXE_RE.test(fileName)) throw new Error(`Некорректное имя установщика: ${fileName}`);
  if (typeof sha512 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(sha512)) {
    throw new Error('sha512 должен быть base64');
  }
  if (!Number.isInteger(size) || size <= 0) throw new Error(`Некорректный size: ${size}`);
  if (Number.isNaN(Date.parse(releaseDate))) throw new Error(`Некорректная releaseDate: ${releaseDate}`);
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${fileName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/** Минимальный парсер собственного вывода (без YAML-зависимости). */
export function parseFeedYaml(text) {
  const top = (key) => {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return match ? unquote(match[1]) : undefined;
  };
  const fileBlock = text.match(
    /files:\s*\n\s*-\s*url:\s*(.+)\n\s*sha512:\s*(.+)\n\s*size:\s*(\d+)/,
  );
  return {
    version: top('version'),
    path: top('path'),
    sha512: top('sha512'),
    releaseDate: top('releaseDate'),
    files: fileBlock
      ? [
          {
            url: unquote(fileBlock[1]),
            sha512: unquote(fileBlock[2]),
            size: Number(fileBlock[3]),
          },
        ]
      : [],
  };
}

export function verifyFeed({ feedPath, exePath, expectedVersion }) {
  const errors = [];
  if (!existsSync(feedPath)) return [`фид не найден: ${feedPath}`];
  if (!existsSync(exePath)) return [`установщик не найден: ${exePath}`];

  const feed = parseFeedYaml(readFileSync(feedPath, 'utf8'));
  const actualSha512 = sha512Base64File(exePath);
  const actualSize = statSync(exePath).size;
  const fileName = basename(exePath);

  if (expectedVersion && feed.version !== expectedVersion) {
    errors.push(`version в фиде ${feed.version ?? '<none>'} != ожидаемой ${expectedVersion}`);
  }
  if (feed.path !== fileName) errors.push(`path "${feed.path ?? '<none>'}" != "${fileName}"`);
  if (feed.sha512 !== actualSha512) {
    errors.push('top-level sha512 в фиде != base64(SHA-512(exe))');
  }
  if (feed.files.length !== 1) {
    errors.push(`в files[] ожидался 1 элемент, найдено ${feed.files.length}`);
  } else {
    const file = feed.files[0];
    if (file.url !== fileName) errors.push(`files[0].url "${file.url}" != "${fileName}"`);
    if (file.sha512 !== actualSha512) {
      errors.push('files[0].sha512 != base64(SHA-512(exe))');
    }
    if (file.size !== actualSize) {
      errors.push(`files[0].size ${file.size} != ${actualSize}`);
    }
  }
  if (!feed.releaseDate || Number.isNaN(Date.parse(feed.releaseDate))) {
    errors.push('releaseDate отсутствует или некорректна');
  }

  return errors;
}

function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
  return pkg.version;
}

function parseArgs(argv) {
  const options = {
    channel: 'latest',
    releaseDir: join(appRoot, 'release'),
    exe: undefined,
    version: undefined,
    date: undefined,
    verify: false,
    keepBlockmap: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--channel') options.channel = argv[++i];
    else if (arg === '--release-dir') options.releaseDir = resolve(argv[++i] ?? '');
    else if (arg === '--exe') options.exe = resolve(argv[++i] ?? '');
    else if (arg === '--version') options.version = argv[++i];
    else if (arg === '--date') options.date = argv[++i];
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--keep-blockmap') options.keepBlockmap = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Неизвестный аргумент: ${arg} (см. --help)`);
  }
  if (!['latest', 'beta'].includes(options.channel)) {
    throw new Error(`--channel должен быть latest или beta (получено "${options.channel}")`);
  }
  return options;
}

function usage() {
  console.log(`regen-feed — пересборка update-фида из подписанного установщика

  node apps/desktop/scripts/regen-feed.mjs [--channel latest|beta] [--verify]

  --release-dir <dir>  каталог с exe (по умолчанию apps/desktop/release)
  --exe <file>         конкретный установщик
  --version <x.y.z>    ожидаемая версия (сверка с package.json)
  --date <ISO>         releaseDate (для тестов/воспроизводимости)
  --verify             проверить фид: sha512 == base64(SHA-512(exe))
  --keep-blockmap      не удалять устаревший .blockmap (не для релиза)`);
}

function resolveExe(options, version) {
  if (options.exe) {
    if (!existsSync(options.exe)) throw new Error(`Установщик не найден: ${options.exe}`);
    return options.exe;
  }
  const exact = join(options.releaseDir, `Flare-Setup-${version}.exe`);
  if (existsSync(exact)) return exact;

  const candidates = existsSync(options.releaseDir)
    ? readdirSync(options.releaseDir).filter((name) => /^Flare-Setup-.*\.exe$/i.test(name))
    : [];
  const matching = candidates.filter((name) => name.includes(`-${version}.exe`));
  if (matching.length === 1) return join(options.releaseDir, matching[0]);
  if (matching.length === 0) {
    throw new Error(
      `Установщик Flare-Setup-${version}.exe не найден в ${options.releaseDir}. ` +
        'Соберите его (package:win) или укажите --exe.',
    );
  }
  throw new Error(`Найдено несколько установщиков версии ${version}: ${matching.join(', ')}`);
}

function writeSha256Sums(releaseDir, files) {
  const lines = [];
  for (const name of files.sort()) {
    const full = join(releaseDir, name);
    if (!existsSync(full)) continue;
    lines.push(`${sha256HexFile(full)}  ${name}`);
  }
  const sumsPath = join(releaseDir, 'SHA256SUMS.txt');
  writeFileSync(sumsPath, `${lines.join('\n')}\n`, 'utf8');
  return { sumsPath, lines };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const packageVersion = readPackageVersion();
  const version = options.version ?? packageVersion;
  if (!VERSION_RE.test(version)) throw new Error(`Некорректная версия: ${version}`);
  if (version !== packageVersion) {
    throw new Error(
      `Версия ${version} не совпадает с apps/desktop/package.json (${packageVersion})`,
    );
  }

  const exePath = resolveExe(options, version);
  const fileName = basename(exePath);
  const feedPath = join(options.releaseDir, `${options.channel}.yml`);

  if (options.verify) {
    const errors = verifyFeed({ feedPath, exePath, expectedVersion: version });
    if (errors.length > 0) {
      console.error(`[regen-feed] ПРОВАЛ: ${feedPath}`);
      for (const error of errors) console.error(`  - ${error}`);
      process.exit(1);
    }
    console.log(`[regen-feed] OK: ${options.channel}.yml sha512 == base64(SHA-512(${fileName}))`);
    console.log(`[regen-feed] size: ${statSync(exePath).size} bytes`);
    return;
  }

  const sha512 = sha512Base64File(exePath);
  const size = statSync(exePath).size;
  const releaseDate = options.date ?? new Date().toISOString();
  const yaml = buildFeedYaml({ version, fileName, sha512, size, releaseDate });
  writeFileSync(feedPath, yaml, 'utf8');
  console.log(`[regen-feed] записан ${feedPath}`);
  console.log(`[regen-feed] version: ${version}, size: ${size}, sha512: ${sha512.slice(0, 16)}…`);

  // Подпись изменила байты — blockmap от неподписанного exe непригоден.
  const blockmap = `${exePath}.blockmap`;
  const sumsFiles = [fileName, `${options.channel}.yml`];
  if (existsSync(blockmap)) {
    if (options.keepBlockmap) {
      console.warn(
        `[regen-feed] ВНИМАНИЕ: оставлен устаревший ${basename(blockmap)} — не публикуйте его.`,
      );
      sumsFiles.push(basename(blockmap));
    } else {
      rmSync(blockmap, { force: true });
      console.log('[regen-feed] удалён устаревший .blockmap (посчитан от неподписанного exe)');
    }
  }

  const { sumsPath, lines } = writeSha256Sums(options.releaseDir, sumsFiles);
  console.log(`[regen-feed] ${sumsPath}:`);
  for (const line of lines) console.log(`  ${line}`);

  const errors = verifyFeed({ feedPath, exePath, expectedVersion: version });
  if (errors.length > 0) {
    console.error('[regen-feed] ПРОВАЛ самопроверки:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('[regen-feed] самопроверка OK: sha512 в фиде == base64(SHA-512(exe))');
}

const isMain =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();

if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`[regen-feed] ОШИБКА: ${error.message}`);
    process.exit(1);
  }
}
