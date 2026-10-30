// ---------------------------------------------------------------------------
// regen-feed.test.mjs — фид пересчитывается от ПОДПИСАННЫХ байтов.
//
// Проверяем главный инвариант: `sha512` в <channel>.yml == base64(SHA-512(exe)),
// плюс version/path/size/releaseDate, beta-канал, SHA256SUMS и удаление
// устаревшего .blockmap. Без electron-builder и без сети.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildFeedYaml,
  parseFeedYaml,
  sha512Base64File,
  verifyFeed,
} from './regen-feed.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'regen-feed.mjs');
const appRoot = resolve(here, '..');
const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const EXE_NAME = `Flare-Setup-${VERSION}.exe`;
const DATE = '2026-01-02T03:04:05.000Z';

const tempDirs = [];

function makeRelease() {
  const dir = mkdtempSync(join(tmpdir(), 'flare-regen-feed-'));
  tempDirs.push(dir);
  const exe = join(dir, EXE_NAME);
  writeFileSync(exe, Buffer.from('unsigned-bytes-that-simulate-an-installer\n'));
  return { dir, exe };
}

function run(args) {
  return spawnSync(process.execPath, [script, '--version', VERSION, ...args], {
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('regen-feed', () => {
  it('writes latest.yml from the exe bytes (sha512, size, path, version, date)', () => {
    const { dir, exe } = makeRelease();
    const result = run(['--release-dir', dir, '--date', DATE]);
    expect(result.status, result.stderr).toBe(0);

    const feedPath = join(dir, 'latest.yml');
    expect(existsSync(feedPath)).toBe(true);
    const feed = parseFeedYaml(readFileSync(feedPath, 'utf8'));

    expect(feed.version).toBe(VERSION);
    expect(feed.path).toBe(EXE_NAME);
    expect(feed.releaseDate).toBe(DATE);
    expect(feed.files).toHaveLength(1);
    expect(feed.files[0].url).toBe(EXE_NAME);
    expect(feed.files[0].size).toBe(statSync(exe).size);

    const expected = createHash('sha512').update(readFileSync(exe)).digest('base64');
    expect(feed.sha512).toBe(expected);
    expect(feed.files[0].sha512).toBe(expected);
    expect(feed.sha512).toBe(sha512Base64File(exe));
  });

  it('--verify accepts a consistent feed and rejects a tampered sha512', () => {
    const { dir } = makeRelease();
    expect(run(['--release-dir', dir, '--date', DATE]).status).toBe(0);

    const ok = run(['--release-dir', dir, '--verify']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/sha512 == base64\(SHA-512/);

    const feedPath = join(dir, 'latest.yml');
    const original = readFileSync(feedPath, 'utf8');
    const tampered = original.replace(
      /sha512: [A-Za-z0-9+/=]+/,
      `sha512: ${Buffer.alloc(64, 7).toString('base64')}`,
    );
    writeFileSync(feedPath, tampered, 'utf8');

    const bad = run(['--release-dir', dir, '--verify']);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/sha512/);
  });

  it('supports beta channel and writes beta.yml', () => {
    const { dir } = makeRelease();
    expect(run(['--release-dir', dir, '--channel', 'beta', '--date', DATE]).status).toBe(0);
    expect(existsSync(join(dir, 'beta.yml'))).toBe(true);
    expect(existsSync(join(dir, 'latest.yml'))).toBe(false);
    expect(run(['--release-dir', dir, '--channel', 'beta', '--verify']).status).toBe(0);
  });

  it('removes the stale blockmap created before signing', () => {
    const { dir, exe } = makeRelease();
    const blockmap = `${exe}.blockmap`;
    writeFileSync(blockmap, Buffer.from('stale-blockmap'));

    expect(run(['--release-dir', dir, '--date', DATE]).status).toBe(0);
    expect(existsSync(blockmap)).toBe(false);
  });

  it('writes SHA256SUMS.txt for the exe and the feed', () => {
    const { dir, exe } = makeRelease();
    expect(run(['--release-dir', dir, '--date', DATE]).status).toBe(0);

    const sums = readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
    const exeHash = createHash('sha256').update(readFileSync(exe)).digest('hex');
    const feedHash = createHash('sha256')
      .update(readFileSync(join(dir, 'latest.yml')))
      .digest('hex');

    expect(sums).toContain(`${exeHash}  ${EXE_NAME}`);
    expect(sums).toContain(`${feedHash}  latest.yml`);
  });

  it('rejects a version that does not match package.json', () => {
    const { dir } = makeRelease();
    const result = spawnSync(
      process.execPath,
      [script, '--release-dir', dir, '--version', '9.9.9'],
      { encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/package\.json/);
  });

  it('buildFeedYaml/parseFeedYaml round-trip', () => {
    const sha512 = createHash('sha512').update('x').digest('base64');
    const yaml = buildFeedYaml({
      version: VERSION,
      fileName: EXE_NAME,
      sha512,
      size: 123,
      releaseDate: DATE,
    });
    const parsed = parseFeedYaml(yaml);
    expect(parsed).toMatchObject({
      version: VERSION,
      path: EXE_NAME,
      sha512,
      releaseDate: DATE,
      files: [{ url: EXE_NAME, sha512, size: 123 }],
    });
    expect(verifyFeed({ feedPath: '', exePath: '' }).length).toBeGreaterThan(0);
  });
});
