/**
 * Политика уведомлений (verify, T132): единственный OS-выход — action-required
 * «потеря авторизации устройства», включён по умолчанию.
 *
 * Проверяем: idle/авто-/ручной синк и транзиентная ошибка → 0 OS-уведомлений;
 * потеря авторизации устройства → ровно 1 action-required («Требуется вход»).
 * `FLIGHTLOG_VERIFY_AUTH_ALERTS=0` проверяет полное глушение env-флагом.
 *
 * Требует data-dir с валидным `tokens.enc` (по умолчанию — demo-профиль).
 * Запускать из apps/desktop: `node scripts/verify-sync-notifications.mjs`.
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
const idleMs = Number(process.env.FLIGHTLOG_VERIFY_IDLE_MS ?? 100_000);
const authAlertsDisabled = process.env.FLIGHTLOG_VERIFY_AUTH_ALERTS === '0';
const dataDir = mkdtempSync(join(tmpdir(), 'flightlog-verify-notify-'));

mkdirSync(join(dataDir, 'agent'), { recursive: true });
const tokenSource = join(source, 'agent', 'tokens.enc');
if (!existsSync(tokenSource)) {
  console.error(`verify-sync-notifications: no tokens.enc in ${source}`);
  process.exit(2);
}
cpSync(tokenSource, join(dataDir, 'agent', 'tokens.enc'));
if (existsSync(join(source, 'settings.json'))) {
  cpSync(join(source, 'settings.json'), join(dataDir, 'settings.json'));
}

const failures = [];

const appEnv = {
  ...process.env,
  FLIGHTLOG_WEB_URL: 'http://127.0.0.1:9',
  FLIGHTLOG_API_URL: 'http://127.0.0.1:9',
  FLIGHTLOG_AGENT_AUTOSTART: '1',
  FLIGHTLOG_AGENT_MEMORY_BUFFER: '1',
  FLIGHTLOG_DATA_DIR: dataDir,
};
// Единственное OS-уведомление включено по умолчанию; `FLIGHTLOG_VERIFY_AUTH_ALERTS=0`
// глушит его env-флагом (для проверки, что запись молчит осознанно).
if (authAlertsDisabled) appEnv.FLIGHTLOG_AUTH_ALERTS_ENABLED = '0';

let app;
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [appRoot],
    cwd: appRoot,
    timeout: 90_000,
    env: appEnv,
  });

  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(idleMs);

  const idle = await app.evaluate(() => ({
    agentRunning: globalThis.__flightlogAgentRunning === true,
    statusEvents: globalThis.__flightlogStatusCount ?? 0,
    notifications: globalThis.__flightlogNotifications ?? [],
    tooltip: globalThis.__flightlogTrayTooltip ?? '',
  }));

  if (!idle.agentRunning) failures.push('agent did not start');
  // Без симулятора агент может выдать единственный `sim_waiting` и молчать —
  // важно, что событие было (агент жив), а не их число.
  if (idle.statusEvents < 1) failures.push('no status events from agent');
  if (idle.notifications.length !== 0) {
    failures.push(`idle raised ${idle.notifications.length} notification(s)`);
  }

  const emit = (event) =>
    app.evaluate((_electron, payload) => globalThis.__flightlogEmitStatus?.(payload), event);
  const nowIso = () => new Date().toISOString();

  // Ручной синк с числами — наружу тоже молча (политика «не беспокоить»).
  await emit({
    state: 'sync_ok',
    syncReason: 'manual',
    lastSyncAt: nowIso(),
    uploadedFlights: 1,
    uploadedPoints: 5,
    uploadedEvents: 2,
  });
  await page.waitForTimeout(400);
  // Транзиентная ошибка синка — молча.
  await emit({ state: 'sync_error', quality: 'retryable', message: 'нет сети' });
  await page.waitForTimeout(400);
  // Пустой ручной синк — молча.
  await emit({ state: 'sync_ok', syncReason: 'manual', lastSyncAt: nowIso() });
  await page.waitForTimeout(400);

  const final = await app.evaluate(() => ({
    notifications: globalThis.__flightlogNotifications ?? [],
    tooltip: globalThis.__flightlogTrayTooltip ?? '',
  }));

  if (final.notifications.length !== 0) {
    failures.push(`manual/transient events raised ${final.notifications.length} notification(s)`);
  }
  if (!/синхронизировано/i.test(final.tooltip) || !/\d{2}:\d{2}/.test(final.tooltip)) {
    failures.push(`tray tooltip does not show last sync time: "${final.tooltip}"`);
  }

  // Action-required: потеря авторизации устройства (иначе запись не работает).
  // По умолчанию — ровно одно OS-уведомление; с `FLIGHTLOG_VERIFY_AUTH_ALERTS=0` — молча.
  await app.evaluate(() =>
    globalThis.__flightlogHandleUserCode?.({
      user_code: 'WXYZ-1234',
      verification_uri: 'http://127.0.0.1:9/device',
      expires_in: 600,
    }),
  );
  // Код открывает окно (in-app approve). Прячем окно — только тогда action-required
  // уведомление имеет смысл (пользователь не видит код на экране).
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.close();
  });
  await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  const afterCode = await app.evaluate(() => globalThis.__flightlogNotifications ?? []);
  const expectedActionRequired = authAlertsDisabled ? 0 : 1;
  if (afterCode.length !== expectedActionRequired) {
    failures.push(
      `device-code raised ${afterCode.length} notification(s), expected ${expectedActionRequired}`,
    );
  }
  if (!authAlertsDisabled && afterCode[0]?.title !== 'Требуется вход') {
    failures.push(`unexpected action-required title: "${afterCode[0]?.title ?? ''}"`);
  }

  console.log(
    JSON.stringify(
      {
        ok: failures.length === 0,
        dataDir,
        authAlertsDisabled,
        idleStatusEvents: idle.statusEvents,
        notifications: final.notifications.length,
        actionRequiredNotifications: afterCode.length,
        trayTooltip: final.tooltip,
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
