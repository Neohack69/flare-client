// ---------------------------------------------------------------------------
// build-freshness.mjs — детерминированные проверки «сборка соответствует дереву».
//
// P0-инцидент: `package:win` упаковал устаревший `packages/agent/dist` (workspace-
// зависимость, собранная из `src` задолго до), поэтому исправленный агент ушёл
// в поставку НЕисправленным. Здесь — «клей», которым это ловится:
//
//   * `hashDir` / `snapshotDeps` — контентные (не mtime!) хэши `src`/`dist`
//     workspace-зависимостей. Хэш контента, а не mtime, потому что turbo-кэш
//     восстанавливает `dist` БЕЗ обновления mtime — mtime-эвристика даёт ложные
//     срабатывания.
//   * `read/writeDepStamp`, `diffDepStamp` — «штамп» сборки зависимостей
//     (`pnpm build:deps`) и его сверка на шаге упаковки/верификации.
//   * `readAsarFile` / `walkAsar` — минимальный чтение `app.asar` (без внешней
//     зависимости), чтобы сверить уже УПАКОВАННЫЙ бандл с текущим деревом.
//
// Модуль чистый (I/O только через fs по переданным путям) и тестируется
// (`build-freshness.test.mjs`).
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const WORKSPACE_SCOPE = '@flightlog/';

/**
 * Паттерны `files`, которыми `apps/desktop/electron-builder.yml` исключает
 * ненужное из `node_modules/@flightlog/*` (исходники, тесты, sourcemap'ы,
 * turbo-кэш, tsconfig/tsbuildinfo). **Единый источник правды для guard'а
 * свежести**: сравнивать с asar нужно ровно то, что реально упаковывается,
 * иначе `*.test.js` даёт ложный «stale-build trap» (0.3.3).
 *
 * Пути — относительно каталога сравнения (напр. `.../@flightlog/<pkg>/dist`).
 * Синхронность с YAML проверяет `apps/desktop/scripts/asar-hygiene.test.mjs`.
 */
export const FLIGHTLOG_PACKAGING_EXCLUDES = [
  'src/**',
  '**/*.test.js',
  '**/*.map',
  '.turbo/**',
  'tsconfig.json',
  '**/*.tsbuildinfo',
];

/** Минимальный glob→RegExp для паттернов `files` (поддерживает `**`, `*`, `?`). */
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return new RegExp(`^(?:${re})$`);
}

/**
 * Фильтр файлов, которые `electron-builder` реально кладёт в asar из
 * `@flightlog/<pkg>/dist`: только runtime-`.js` (встроенный `excludedExts`
 * отбрасывает `.d.ts`, `*.map`/`*.test.js` — `files` в yml), кроме паттернов
 * `FLIGHTLOG_PACKAGING_EXCLUDES`. Один и тот же фильтр применяется к
 * упакованному asar и к локальному `dist`, поэтому сравнение честное.
 */
export function createPackagedDistFilter(patterns = FLIGHTLOG_PACKAGING_EXCLUDES) {
  const excludes = patterns.map(globToRegExp);
  return (relPath) => relPath.endsWith('.js') && !excludes.some((re) => re.test(relPath));
}

/** sha256 содержимого файла → hex. */
export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** sha256 произвольного буфера → hex. */
export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Рекурсивный список файлов (относительные POSIX-пути, отсортированы). */
export function listFiles(dir, { filter } = {}) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (!filter || filter(rel)) out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * Детерминированный контентный хэш каталога: sha256 от сортированного набора
 * `<relpath>\0<sha256 файла>`. Порядок обхода и mtime не влияют на результат.
 */
export function hashDir(dir, { filter } = {}) {
  const hash = createHash('sha256');
  for (const rel of listFiles(dir, { filter })) {
    hash.update(rel);
    hash.update('\0');
    hash.update(sha256File(join(dir, rel)));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/** Карта `name -> каталог пакета` по `packages/*` и `apps/*` монорепо. */
export function workspacePackageDirs(repoRoot) {
  const map = new Map();
  for (const group of ['packages', 'apps']) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgJson = join(groupDir, entry.name, 'package.json');
      if (!existsSync(pkgJson)) continue;
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
      if (typeof pkg.name === 'string') map.set(pkg.name, join(groupDir, entry.name));
    }
  }
  return map;
}

/** Имена `@flightlog/*`-зависимостей пакета (runtime `dependencies`). */
function flightlogDeps(pkgDir) {
  const pkgJson = join(pkgDir, 'package.json');
  if (!existsSync(pkgJson)) return [];
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
  return Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith(WORKSPACE_SCOPE));
}

/**
 * Транзитивное замыкание workspace-зависимостей пакета (без самого пакета).
 * Возвращает отсортированный список `{ name, dir, hasBuild }`.
 */
export function collectWorkspaceDeps(startPackageDir, repoRoot) {
  const dirs = workspacePackageDirs(repoRoot);
  const seen = new Map();
  const queue = [...flightlogDeps(startPackageDir)];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const dir = dirs.get(name);
    if (!dir) continue;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    seen.set(name, { name, dir, hasBuild: Boolean(pkg.scripts?.build) });
    queue.push(...flightlogDeps(dir));
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Контентные хэши `src`/`dist` для каждой зависимости. */
export function snapshotDeps(deps) {
  const snapshot = {};
  for (const dep of deps) {
    snapshot[dep.name] = {
      src: hashDir(join(dep.dir, 'src')),
      dist: hashDir(join(dep.dir, 'dist')),
    };
  }
  return snapshot;
}

export const DEP_STAMP_RELATIVE = join('build', '.dep-freshness.json');

export function writeDepStamp(stampPath, { deps, generatedAt = new Date().toISOString() }) {
  mkdirSync(dirname(stampPath), { recursive: true });
  writeFileSync(stampPath, `${JSON.stringify({ generatedAt, deps }, null, 2)}\n`, 'utf8');
}

export function readDepStamp(stampPath) {
  if (!existsSync(stampPath)) return null;
  try {
    return JSON.parse(readFileSync(stampPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Сверка текущего снимка `src`/`dist` со штампом.
 * Возвращает список расхождений `{ name, field, stamped, current }` (пусто — ок).
 */
export function diffDepStamp(stamp, current) {
  const mismatches = [];
  if (!stamp || typeof stamp.deps !== 'object' || stamp.deps === null) {
    return [{ name: '<stamp>', field: 'deps', stamped: null, current: null }];
  }
  for (const [name, hashes] of Object.entries(current)) {
    const stamped = stamp.deps[name];
    if (!stamped) {
      mismatches.push({ name, field: 'deps', stamped: null, current: hashes });
      continue;
    }
    for (const field of ['src', 'dist']) {
      if (stamped[field] !== hashes[field]) {
        mismatches.push({ name, field, stamped: stamped[field], current: hashes[field] });
      }
    }
  }
  return mismatches;
}

/**
 * Полная проверка штампа: читает штамп и сверяет контентные хэши `src`/`dist`.
 * `{ ok, missingStamp, mismatches }`.
 */
export function verifyDepSnapshot({ stampPath, deps }) {
  const stamp = readDepStamp(stampPath);
  if (!stamp) return { ok: false, missingStamp: true, mismatches: [] };
  const mismatches = diffDepStamp(stamp, snapshotDeps(deps));
  return { ok: mismatches.length === 0, missingStamp: false, mismatches };
}

// --- Минимальный reader `app.asar` (формат pickle + JSON header) --------------
// Повторяет чтение заголовка из `@electron/asar`, чтобы не тянуть зависимость в
// релизный скрипт (asar-модуль доступен только транзитивно через electron-builder).

const ASAR_PREFIX_BYTES = 8;

function readArchiveHeader(filePath) {
  const fd = openSync(filePath, 'r');
  try {
    const sizeBuf = Buffer.alloc(ASAR_PREFIX_BYTES);
    if (readSync(fd, sizeBuf, 0, ASAR_PREFIX_BYTES, 0) !== ASAR_PREFIX_BYTES) {
      throw new Error('asar: не удалось прочитать размер заголовка');
    }
    const headerSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerSize);
    if (readSync(fd, headerBuf, 0, headerSize, ASAR_PREFIX_BYTES) !== headerSize) {
      throw new Error('asar: не удалось прочитать заголовок');
    }
    const payloadSize = headerBuf.readUInt32LE(0);
    const stringOffset = headerBuf.length - payloadSize;
    const stringLength = headerBuf.readUInt32LE(stringOffset);
    const json = headerBuf
      .subarray(stringOffset + 4, stringOffset + 4 + stringLength)
      .toString('utf8');
    return { header: JSON.parse(json), headerSize };
  } finally {
    closeSync(fd);
  }
}

function asarNode(header, innerPath) {
  let node = { files: header.files };
  for (const part of innerPath.split('/').filter(Boolean)) {
    node = node?.files?.[part];
    if (!node) return null;
  }
  return node;
}

/** Список файлов под `innerDir` в asar: `{ relPath, size, offset, unpacked }`. */
export function walkAsar(asarPath, innerDir) {
  const { header } = readArchiveHeader(asarPath);
  const base = asarNode(header, innerDir);
  if (!base?.files) return [];
  const out = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, rel);
      else
        out.push({
          relPath: rel,
          size: child.size ?? 0,
          offset: child.offset,
          unpacked: child.unpacked === true,
        });
    }
  };
  walk(base, '');
  return out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

/** Чтение файла из asar по внутреннему POSIX-пути. */
export function readAsarFile(asarPath, innerPath) {
  const { header, headerSize } = readArchiveHeader(asarPath);
  const info = asarNode(header, innerPath);
  if (!info || info.files) throw new Error(`asar: файл не найден — ${innerPath}`);
  if (info.unpacked) return readFileSync(join(`${asarPath}.unpacked`, ...innerPath.split('/')));
  const size = info.size ?? 0;
  if (size <= 0) return Buffer.alloc(0);
  const fd = openSync(asarPath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const offset = ASAR_PREFIX_BYTES + headerSize + parseInt(info.offset, 10);
    readSync(fd, buffer, 0, size, offset);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

/** Контентный хэш `dist`-дерева, извлечённого из asar (по префиксу пути). */
export function hashAsarDir(asarPath, innerDir, { filter } = {}) {
  const hash = createHash('sha256');
  for (const entry of walkAsar(asarPath, innerDir)) {
    if (filter && !filter(entry.relPath)) continue;
    hash.update(entry.relPath);
    hash.update('\0');
    hash.update(
      entry.unpacked
        ? '(unpacked)'
        : sha256Buffer(readAsarFile(asarPath, `${innerDir}/${entry.relPath}`)),
    );
    hash.update('\n');
  }
  return hash.digest('hex');
}

/** Есть ли файл в asar (без извлечения). */
export function asarHasFile(asarPath, innerPath) {
  try {
    const { header } = readArchiveHeader(asarPath);
    return Boolean(asarNode(header, innerPath));
  } catch {
    return false;
  }
}
