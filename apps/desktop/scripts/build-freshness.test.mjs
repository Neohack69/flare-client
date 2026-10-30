// ---------------------------------------------------------------------------
// build-freshness.test.mjs — тесты guard'а «сборка соответствует дереву» (P0).
//
// Без electron-builder: проверяем чистые функции определения свежести, штамп
// `build:deps` и минимальный reader `app.asar` (asar собирается прямо в тесте).
// ---------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  asarHasFile,
  collectWorkspaceDeps,
  createPackagedDistFilter,
  FLIGHTLOG_PACKAGING_EXCLUDES,
  hashAsarDir,
  hashDir,
  listFiles,
  readAsarFile,
  snapshotDeps,
  verifyDepSnapshot,
  walkAsar,
  writeDepStamp,
} from './lib/build-freshness.mjs';

const tempDirs = [];

function makeTemp(prefix = 'flightlog-freshness-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function write(file, content) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function uint32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

/** Собирает валидный `app.asar` (pickle + JSON header) из `{ 'rel/path': content }`. */
function buildAsar(files) {
  const dataChunks = [];
  let offset = 0;
  const tree = { files: {} };
  for (const [rel, content] of Object.entries(files)) {
    const parts = rel.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} };
      node = node.files[part];
    }
    const buf = Buffer.from(content, 'utf8');
    node.files[parts.at(-1)] = { size: buf.length, offset: String(offset) };
    dataChunks.push(buf);
    offset += buf.length;
  }
  const jsonBuf = Buffer.from(JSON.stringify(tree), 'utf8');
  const padding = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4);
  const payload = Buffer.concat([uint32(jsonBuf.length), jsonBuf, padding]);
  const headerBuf = Buffer.concat([uint32(payload.length), payload]);
  const sizeBuf = Buffer.concat([uint32(4), uint32(headerBuf.length)]);
  return Buffer.concat([sizeBuf, headerBuf, ...dataChunks]);
}

describe('hashDir / listFiles', () => {
  it('детерминирован и не зависит от порядка создания файлов', () => {
    const a = makeTemp();
    write(join(a, 'src', 'one.ts'), 'export const one = 1;\n');
    write(join(a, 'src', 'nested', 'two.ts'), 'export const two = 2;\n');
    const b = makeTemp();
    write(join(b, 'src', 'nested', 'two.ts'), 'export const two = 2;\n');
    write(join(b, 'src', 'one.ts'), 'export const one = 1;\n');
    expect(hashDir(join(a, 'src'))).toBe(hashDir(join(b, 'src')));
  });

  it('меняется при изменении содержимого', () => {
    const dir = makeTemp();
    write(join(dir, 'src', 'one.ts'), 'a');
    const before = hashDir(join(dir, 'src'));
    write(join(dir, 'src', 'one.ts'), 'b');
    expect(hashDir(join(dir, 'src'))).not.toBe(before);
  });

  it('учитывает фильтр (например, только .js)', () => {
    const dir = makeTemp();
    write(join(dir, 'dist', 'index.js'), 'js');
    write(join(dir, 'dist', 'index.js.map'), 'map');
    expect(listFiles(join(dir, 'dist'), { filter: (p) => p.endsWith('.js') })).toEqual([
      'index.js',
    ]);
  });
});

describe('dep stamp (build:deps → guard)', () => {
  function makeDep(root, name, { src = 'v1', dist = 'v1' } = {}) {
    write(join(root, name, 'src', 'index.ts'), src);
    write(join(root, name, 'dist', 'index.js'), dist);
    writeFileSync(
      join(root, name, 'package.json'),
      JSON.stringify({ name, scripts: { build: 'tsc' } }),
      'utf8',
    );
    return { name, dir: join(root, name), hasBuild: true };
  }

  it('проходит, когда src/dist не менялись после build:deps', () => {
    const root = makeTemp();
    const deps = [makeDep(root, '@flightlog/agent')];
    const stampPath = join(root, 'build', '.dep-freshness.json');
    writeDepStamp(stampPath, { deps: snapshotDeps(deps) });
    expect(verifyDepSnapshot({ stampPath, deps })).toMatchObject({
      ok: true,
      missingStamp: false,
    });
  });

  it('падает, когда src изменился после build:deps (stale-dist)', () => {
    const root = makeTemp();
    const deps = [makeDep(root, '@flightlog/agent')];
    const stampPath = join(root, 'build', '.dep-freshness.json');
    writeDepStamp(stampPath, { deps: snapshotDeps(deps) });
    write(join(root, '@flightlog/agent', 'src', 'index.ts'), 'v2');
    const result = verifyDepSnapshot({ stampPath, deps });
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      expect.objectContaining({ name: '@flightlog/agent', field: 'src' }),
    ]);
  });

  it('падает, когда dist изменился после build:deps', () => {
    const root = makeTemp();
    const deps = [makeDep(root, '@flightlog/agent')];
    const stampPath = join(root, 'build', '.dep-freshness.json');
    writeDepStamp(stampPath, { deps: snapshotDeps(deps) });
    write(join(root, '@flightlog/agent', 'dist', 'index.js'), 'other');
    const result = verifyDepSnapshot({ stampPath, deps });
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      expect.objectContaining({ name: '@flightlog/agent', field: 'dist' }),
    ]);
  });

  it('падает, когда штампа нет (build:deps не запускался)', () => {
    const root = makeTemp();
    const deps = [makeDep(root, '@flightlog/agent')];
    expect(verifyDepSnapshot({ stampPath: join(root, 'build', 'nope.json'), deps })).toEqual({
      ok: false,
      missingStamp: true,
      mismatches: [],
    });
  });
});

describe('collectWorkspaceDeps', () => {
  it('собирает транзитивное замыкание runtime-зависимостей desktop', () => {
    const root = makeTemp('flightlog-mono-');
    const pkg = (dir, json) => {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify(json), 'utf8');
    };
    mkdirSync(join(root, 'apps', 'app'), { recursive: true });
    pkg(join('apps', 'app'), {
      name: '@flightlog/desktop',
      dependencies: { '@flightlog/agent': 'workspace:*', '@flightlog/i18n': 'workspace:*' },
      devDependencies: { '@flightlog/config': 'workspace:*' },
    });
    pkg(join('packages', 'agent'), {
      name: '@flightlog/agent',
      dependencies: { '@flightlog/contracts': 'workspace:*', '@flightlog/scoring': 'workspace:*' },
      scripts: { build: 'tsc' },
    });
    pkg(join('packages', 'contracts'), { name: '@flightlog/contracts', scripts: { build: 'tsc' } });
    pkg(join('packages', 'scoring'), { name: '@flightlog/scoring', scripts: { build: 'tsc' } });
    pkg(join('packages', 'i18n'), { name: '@flightlog/i18n', scripts: { build: 'tsc' } });
    pkg(join('packages', 'config'), { name: '@flightlog/config' });

    const deps = collectWorkspaceDeps(join(root, 'apps', 'app'), root).map((d) => d.name);
    expect(deps).toEqual([
      '@flightlog/agent',
      '@flightlog/contracts',
      '@flightlog/i18n',
      '@flightlog/scoring',
    ]);
  });
});

describe('минимальный reader app.asar', () => {
  it('читает файл, перечисляет дерево и находит файл', () => {
    const root = makeTemp();
    const asarPath = join(root, 'app.asar');
    writeFileSync(
      asarPath,
      buildAsar({ 'a.txt': 'hello', 'sub/b.js': 'abc', 'sub/c.js.map': 'map' }),
    );

    expect(readAsarFile(asarPath, 'a.txt').toString('utf8')).toBe('hello');
    expect(readAsarFile(asarPath, 'sub/b.js').toString('utf8')).toBe('abc');
    expect(asarHasFile(asarPath, 'sub/b.js')).toBe(true);
    expect(asarHasFile(asarPath, 'nope.js')).toBe(false);
    expect(walkAsar(asarPath, 'sub').map((e) => e.relPath)).toEqual(['b.js', 'c.js.map']);
  });

  it('hashAsarDir совпадает с hashDir того же дерева (фильтр .js)', () => {
    const root = makeTemp();
    const asarPath = join(root, 'app.asar');
    writeFileSync(
      asarPath,
      buildAsar({ 'dist/index.js': 'code', 'dist/index.js.map': 'map', 'dist/a.js': 'a' }),
    );
    const localDir = join(root, 'dist');
    write(join(localDir, 'index.js'), 'code');
    write(join(localDir, 'index.js.map'), 'map');
    write(join(localDir, 'a.js'), 'a');

    const onlyJs = (p) => p.endsWith('.js');
    expect(hashAsarDir(asarPath, 'dist', { filter: onlyJs })).toBe(
      hashDir(localDir, { filter: onlyJs }),
    );
    expect(readAsarFile(asarPath, 'dist/a.js').toString('utf8')).toBe('a');
  });
});

describe('createPackagedDistFilter (align с files electron-builder)', () => {
  it('оставляет runtime-.js и отбрасывает то, что не упаковывается', () => {
    const filter = createPackagedDistFilter();
    for (const kept of ['index.js', 'flight/touchdown.js', 'sync/http.js']) {
      expect(filter(kept)).toBe(true);
    }
    for (const dropped of [
      'index.test.js',
      'flight/touchdown.test.js',
      'index.js.map',
      'index.d.ts',
      'index.d.ts.map',
      'src/index.ts',
      '.turbo/turbo-build.log',
      'tsconfig.json',
      'index.tsbuildinfo',
      'package.json',
    ]) {
      expect(filter(dropped)).toBe(false);
    }
    expect(FLIGHTLOG_PACKAGING_EXCLUDES).toContain('**/*.test.js');
  });

  it('различие только в *.test.js НЕ считается stale (свежая сборка проходит)', () => {
    const root = makeTemp();
    const asarPath = join(root, 'app.asar');
    // В asar — только runtime-`.js` (electron-builder выкинул тесты/map/d.ts).
    writeFileSync(
      asarPath,
      buildAsar({ 'agent/dist/index.js': 'runtime', 'agent/dist/a.js': 'a' }),
    );
    const localDir = join(root, 'dist');
    write(join(localDir, 'index.js'), 'runtime');
    write(join(localDir, 'a.js'), 'a');
    write(join(localDir, 'a.test.js'), 'test-only');
    write(join(localDir, 'index.test.js'), 'test-only');

    const filter = createPackagedDistFilter();
    expect(hashAsarDir(asarPath, 'agent/dist', { filter })).toBe(
      hashDir(localDir, { filter }),
    );
  });

  it('различие в runtime-.js СЧИТАЕТСЯ stale (guard всё ещё ловит)', () => {
    const root = makeTemp();
    const asarPath = join(root, 'app.asar');
    writeFileSync(asarPath, buildAsar({ 'agent/dist/index.js': 'old' }));
    const localDir = join(root, 'dist');
    write(join(localDir, 'index.js'), 'new');
    write(join(localDir, 'index.test.js'), 'test-only');

    const filter = createPackagedDistFilter();
    expect(hashAsarDir(asarPath, 'agent/dist', { filter })).not.toBe(
      hashDir(localDir, { filter }),
    );
  });

  it('пропавший в asar runtime-.js тоже ловится (устаревшая упаковка)', () => {
    const root = makeTemp();
    const asarPath = join(root, 'app.asar');
    writeFileSync(asarPath, buildAsar({ 'agent/dist/index.js': 'runtime' }));
    const localDir = join(root, 'dist');
    write(join(localDir, 'index.js'), 'runtime');
    write(join(localDir, 'new-module.js'), 'runtime');

    const filter = createPackagedDistFilter();
    expect(hashAsarDir(asarPath, 'agent/dist', { filter })).not.toBe(
      hashDir(localDir, { filter }),
    );
  });
});
