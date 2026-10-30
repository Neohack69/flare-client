/**
 * T132 verify: готовность обновления — неинтрузивно (без модального диалога).
 *
 * Проверяем в реальном окне «Состояние агента»:
 *   * при готовом обновлении появляется строка/кнопка «Обновление готово — установить»;
 *   * кнопка установки активна и доступна (клик не открывает диалог/фокус);
 *   * во время записи установка отложена (кнопка disabled, текст «Обновится…»);
 *   * при сбросе версии строка снова скрыта.
 *
 * Требует data-dir с валидным `tokens.enc` (по умолчанию — demo-профиль).
 * Запускать из apps/desktop: `node scripts/verify-update-ready.mjs`.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';
import { _electron as electron } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const source = process.env.FLIGHTLOG_VERIFY_SOURCE ?? join(tmpdir(), 'flightlog-client-demo');
const dataDir = mkdtempSync(join(tmpdir(), 'flightlog-verify-update-'));

mkdirSync(join(dataDir, 'agent'), { recursive: true });
const tokenSource = join(source, 'agent', 'tokens.enc');
if (!existsSync(tokenSource)) {
  console.error(`verify-update-ready: no tokens.enc in ${source}`);
  process.exit(2);
}
cpSync(tokenSource, join(dataDir, 'agent', 'tokens.enc'));
if (existsSync(join(source, 'settings.json'))) {
  cpSync(join(source, 'settings.json'), join(dataDir, 'settings.json'));
}

const failures = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let app;
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [appRoot],
    cwd: appRoot,
    timeout: 90_000,
    env: {
      ...process.env,
      FLIGHTLOG_WEB_URL: 'http://127.0.0.1:9',
      FLIGHTLOG_API_URL: 'http://127.0.0.1:9',
      FLIGHTLOG_AGENT_AUTOSTART: '1',
      FLIGHTLOG_AGENT_MEMORY_BUFFER: '1',
      FLIGHTLOG_DATA_DIR: dataDir,
    },
  });

  await app.firstWindow({ timeout: 60_000 });
  await app.evaluate(() => globalThis.__flightlogSetUpdateReady?.('9.9.9'));
  await app.evaluate(() => globalThis.__flightlogOpenStatus?.());
  await wait(800);

  const statusPage = app.windows().find((page) => page.url().includes('status.html'));
  if (!statusPage) throw new Error('status window page not found');
  await statusPage.waitForSelector('#update', { timeout: 10_000 }).catch(() => undefined);

  const ready = await statusPage.evaluate(() => ({
    hidden: document.getElementById('update')?.hidden ?? true,
    text: document.getElementById('update-text')?.textContent ?? '',
    version: document.getElementById('update-version')?.textContent ?? '',
    button: document.getElementById('label-install-update')?.textContent ?? '',
    disabled: document.getElementById('button-install-update')?.disabled ?? true,
  }));

  if (ready.hidden) failures.push('update row stays hidden when an update is ready');
  if (!ready.text.includes('Обновление готово')) failures.push(`unexpected row text: "${ready.text}"`);
  if (ready.button !== 'Установить') failures.push(`unexpected button label: "${ready.button}"`);
  if (!ready.version.includes('9.9.9')) failures.push(`version missing: "${ready.version}"`);
  if (ready.disabled) failures.push('install button is disabled while not recording');

  // Клик по кнопке не должен открывать модальный диалог/перехватывать фокус —
  // страница остаётся живой, окно не перезагружается.
  await statusPage.click('#button-install-update');
  await wait(300);
  const stillAlive = await statusPage.evaluate(() => document.body !== null);
  if (!stillAlive) failures.push('status page died after install click');

  // Во время записи установка откладывается: кнопка disabled, текст «Обновится…».
  await app.evaluate(() => globalThis.__flightlogEmitStatus?.({ state: 'recording' }));
  await wait(300);
  const recording = await statusPage.evaluate(() => ({
    disabled: document.getElementById('button-install-update')?.disabled ?? false,
    text: document.getElementById('update-text')?.textContent ?? '',
  }));
  if (!recording.disabled) failures.push('install button is enabled while recording');
  if (!recording.text.includes('завершения полёта')) {
    failures.push(`recording row text is not deferred: "${recording.text}"`);
  }

  // Сброс версии прячет строку.
  await app.evaluate(() => globalThis.__flightlogSetUpdateReady?.(null));
  await wait(300);
  const cleared = await statusPage.evaluate(() => document.getElementById('update')?.hidden ?? false);
  if (!cleared) failures.push('update row stays visible after clearing the version');

  console.log(
    JSON.stringify(
      {
        ok: failures.length === 0,
        dataDir,
        ready,
        recording,
        cleared,
        failures,
      },
      null,
      2,
    ),
  );
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
} finally {
  await app?.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
}

process.exitCode = failures.length === 0 ? 0 : 1;
