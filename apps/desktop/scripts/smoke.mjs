import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';
import { _electron as electron } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const releaseDir = join(appRoot, 'release');
const outPng = process.env.SMOKE_OUT ?? join(releaseDir, 'smoke-window.png');
const outHiddenPng = process.env.SMOKE_HIDDEN_OUT ?? join(releaseDir, 'smoke-hidden-start.png');
const statusOutDir =
  process.env.SMOKE_STATUS_DIR ?? resolve(appRoot, '../../docs/design/assets/desktop');
mkdirSync(statusOutDir, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'flightlog-smoke-'));

mkdirSync(releaseDir, { recursive: true });

const failures = [];
const consoleErrors = [];
const diagnosticsLog = {};

function launchApp(extraEnv = {}) {
  return electron.launch({
    executablePath: electronPath,
    // `--user-data-dir` изолирует Chromium-кэш/профиль smoke от работающего
    // установленного клиента (иначе общий `%APPDATA%/Flare` лочится → launch падает).
    args: [appRoot, `--user-data-dir=${userData}`],
    cwd: appRoot,
    timeout: 90_000,
    env: {
      ...process.env,
      FLIGHTLOG_WEB_URL: process.env.FLIGHTLOG_WEB_URL ?? 'http://127.0.0.1:9',
      FLIGHTLOG_API_URL: process.env.FLIGHTLOG_API_URL ?? 'http://127.0.0.1:9',
      FLIGHTLOG_AGENT_AUTOSTART: '0',
      FLIGHTLOG_AGENT_MEMORY_BUFFER: '1',
      FLIGHTLOG_DATA_DIR: userData,
      ...extraEnv,
    },
  });
}

async function readDiagnostics(app) {
  return app.evaluate(() => ({
    trayCreated: globalThis.__flightlogTrayCreated === true,
    trayState: globalThis.__flightlogTrayState ?? null,
    trayTooltip: globalThis.__flightlogTrayTooltip ?? null,
    trayIconBytes: globalThis.__flightlogTrayIconBytes ?? 0,
    startHidden: globalThis.__flightlogStartHidden === true,
    windowVisible: globalThis.__flightlogWindowVisible === true,
    autostart: globalThis.__flightlogAutostart === true,
    onboardingShown: globalThis.__flightlogOnboardingShown === true,
    statusCount: globalThis.__flightlogStatusCount ?? 0,
    agentRunning: globalThis.__flightlogAgentRunning === true,
    statusWindowCreated: globalThis.__flightlogStatusWindowCreated === true,
    trayVariant: globalThis.__flightlogTrayVariant ?? null,
    hotkey: globalThis.__flightlogHotkey ?? null,
    commands: globalThis.__flightlogCommands ?? {},
  }));
}

async function windowVisible(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win ? win.isVisible() : null;
  });
}

// ── Фаза 1: первый запуск — онбординг видим, автозапуск включён по умолчанию ──
try {
  const app = await launchApp();
  const mainLogs = [];
  app.process().stdout?.on('data', (chunk) => mainLogs.push(chunk.toString('utf8')));
  app.process().stderr?.on('data', (chunk) => mainLogs.push(chunk.toString('utf8')));
  try {
    const page = await app.firstWindow({ timeout: 60_000 });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await page.waitForTimeout(6_000);

    const diag = await readDiagnostics(app);
    diagnosticsLog.phase1 = diag;
    if (!diag.trayCreated) failures.push('phase1: tray was not created');
    if (diag.trayIconBytes <= 50) failures.push(`phase1: tray icon looks empty (${diag.trayIconBytes} bytes)`);
    if (!diag.autostart) failures.push('phase1: autostart default flag is not enabled');
    if (!diag.onboardingShown) failures.push('phase1: onboarding was not shown on first run');
    if (!diag.windowVisible) failures.push('phase1: onboarding window is not visible');

    const hasBridge = await page.evaluate(() => typeof window.flightlog !== 'undefined');
    if (!hasBridge) failures.push('phase1: window.flightlog bridge missing');
    const requireUndefined = await page.evaluate(() => typeof window.require === 'undefined');
    if (!requireUndefined) failures.push('phase1: window.require is exposed in renderer');

    await page.evaluate(async () => {
      await window.flightlog?.startAgent();
    });
    await page.waitForTimeout(5_000);
    const status = await page.evaluate(async () => (await window.flightlog?.getStatus()) ?? null);
    if (!status || typeof status.state !== 'string') {
      failures.push('phase1: no AgentStatusEvent received');
    }
    const afterStart = await readDiagnostics(app);
    if (afterStart.statusCount < 1) failures.push('phase1: no status events received');
    if (!afterStart.agentRunning) failures.push('phase1: agent did not start');

    await page.evaluate(async () => {
      await window.flightlog?.stopAgent();
    });
    await page.waitForTimeout(1_500);
    const afterStop = await readDiagnostics(app);
    if (afterStop.agentRunning) failures.push('phase1: agent did not stop');

    await page.screenshot({ path: outPng, fullPage: false }).catch((error) => {
      console.error('[smoke] phase1 screenshot skipped:', error instanceof Error ? error.message : error);
    });

    // Онбординг сохранил флаг → следующий запуск стартует скрыто (фаза 2).
    const settingsRaw = readFileSync(join(userData, 'settings.json'), 'utf8');
    const savedSettings = JSON.parse(settingsRaw);
    if (savedSettings.onboardingDone !== true) {
      failures.push('phase1: onboardingDone was not persisted');
    }

    if (process.env.SMOKE_VERBOSE === '1') {
      console.error('[smoke] phase1 main logs:\n' + mainLogs.join(''));
      console.error('[smoke] phase1 diag=' + JSON.stringify(afterStart));
    }

    const badConsole = consoleErrors.filter((line) =>
      /Uncaught|TypeError|ReferenceError|Worker failed/.test(line),
    );
    if (badConsole.length > 0) {
      failures.push(`phase1: renderer console errors: ${badConsole.join(' | ')}`);
    }
  } finally {
    await app.close().catch(() => undefined);
  }
} catch (error) {
  failures.push(`phase1 crashed: ${error instanceof Error ? error.message : String(error)}`);
}

// ── Фаза 2: повторный запуск — окно НЕ открывается, старт только в трее ──
try {
  const app = await launchApp();
  try {
    const page = await app.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await page.waitForTimeout(6_000);

    const diag = await readDiagnostics(app);
    diagnosticsLog.phase2 = diag;
    if (!diag.trayCreated) failures.push('phase2: tray was not created');
    if (!diag.startHidden) failures.push('phase2: startHidden flag is not set');
    if (!diag.autostart) failures.push('phase2: autostart flag is not enabled');
    if (diag.onboardingShown) failures.push('phase2: onboarding was shown again');

    const visible = await windowVisible(app);
    if (visible !== false) failures.push(`phase2: window is visible on start (${String(visible)})`);

    // Для скриншота «трей/окно» показываем окно после проверки скрытого старта.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    await page.waitForTimeout(500);
    await page
      .screenshot({ path: outHiddenPng, fullPage: false })
      .catch((error) => {
        console.error('[smoke] phase2 screenshot skipped:', error instanceof Error ? error.message : error);
      });
  } finally {
    await app.close().catch(() => undefined);
  }
} catch (error) {
  failures.push(`phase2 crashed: ${error instanceof Error ? error.message : String(error)}`);
}

// ── Фаза 3: окно «Состояние агента» — статус, состояния, кнопки ──
const statusScreenshots = [];
try {
  const app = await launchApp();
  try {
    const sitePage = await app.firstWindow({ timeout: 60_000 });
    await sitePage.waitForLoadState('domcontentloaded').catch(() => undefined);
    await sitePage.waitForTimeout(4_000);

    const diag = await readDiagnostics(app);
    diagnosticsLog.phase3 = diag;
    if (!diag.statusWindowCreated) failures.push('phase3: status window was not created');

    await app.evaluate(() => globalThis.__flightlogOpenStatus?.());
    await sitePage.waitForTimeout(500);

    const statusPage = app
      .windows()
      .find((candidate) => candidate.url().includes('status.html'));
    if (!statusPage) {
      failures.push('phase3: status page not found');
    } else {
      statusPage.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(`[status] ${message.text()}`);
      });
      statusPage.on('pageerror', (error) => consoleErrors.push(`[status] ${String(error)}`));
      await statusPage.waitForLoadState('domcontentloaded').catch(() => undefined);
      await statusPage.waitForTimeout(1_000);

      const hasBridge = await statusPage.evaluate(() => typeof window.flightlog !== 'undefined');
      if (!hasBridge) failures.push('phase3: window.flightlog bridge missing on status page');
      const requireUndefined = await statusPage.evaluate(() => typeof window.require === 'undefined');
      if (!requireUndefined) failures.push('phase3: window.require is exposed on status page');

      // Агент вкл → recording/очередь рендерятся как доминирующее состояние.
      await statusPage.evaluate(async () => {
        await window.flightlog?.startAgent();
      });
      await statusPage.waitForTimeout(1_000);
      const runningAfterStart = await readDiagnostics(app);
      if (!runningAfterStart.agentRunning) failures.push('phase3: agent did not start');

      const counts = {
        flights: 2,
        points: 12_480,
        events: 47,
        pendingFlights: 2,
        pendingPoints: 12_480,
        pendingEvents: 47,
      };

      await app.evaluate((_electron, event) => globalThis.__flightlogEmitStatus?.(event), {
        state: 'recording',
        aircraftIcao: 'B738',
        pendingCounts: counts,
        lastSyncAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      });
      await statusPage.waitForTimeout(400);
      const recordingTitle = await statusPage.textContent('#state-title');
      if (!/Запись/.test(recordingTitle ?? '')) {
        failures.push(`phase3: unexpected recording title: ${recordingTitle}`);
      }
      const flightRoute = await statusPage.textContent('#flight-route');
      if (flightRoute?.trim() !== 'B738') failures.push(`phase3: flight not rendered (${flightRoute})`);
      // DESKTOP-UX-POLISH: кастомный тайтлбар вместо нативной рамки.
      if (!(await statusPage.isVisible('#titlebar'))) {
        failures.push('phase3: custom titlebar is missing');
      }
      const recordingShot = join(statusOutDir, 'app-status-recording.png');
      await statusPage.screenshot({ path: recordingShot });
      statusScreenshots.push(recordingShot);

      await app.evaluate((_electron, event) => globalThis.__flightlogEmitStatus?.(event), {
        state: 'connected_idle',
      });
      await statusPage.waitForTimeout(200);
      await app.evaluate((_electron, event) => globalThis.__flightlogEmitStatus?.(event), {
        state: 'sync_error',
        quality: 'retryable',
        message: 'нет сети',
        pendingCounts: counts,
      });
      await statusPage.waitForTimeout(400);
      const syncErrorTitle = await statusPage.textContent('#state-title');
      if (!/сети/.test(syncErrorTitle ?? '')) {
        failures.push(`phase3: unexpected sync_error title: ${syncErrorTitle}`);
      }
      if (!(await statusPage.isVisible('#error'))) {
        failures.push('phase3: sync_error detail row is not visible');
      }
      const syncErrorShot = join(statusOutDir, 'app-status-sync-error.png');
      await statusPage.screenshot({ path: syncErrorShot });
      statusScreenshots.push(syncErrorShot);

      await app.evaluate((_electron, event) => globalThis.__flightlogEmitStatus?.(event), {
        state: 'auth_required',
        message: 'Введите код WXYZ-1234 на сайте',
      });
      await statusPage.waitForTimeout(400);
      const authShot = join(statusOutDir, 'app-status-auth-required.png');
      await statusPage.screenshot({ path: authShot });
      statusScreenshots.push(authShot);

      // Кнопки шлют корректные команды.
      await app.evaluate((_electron, event) => globalThis.__flightlogEmitStatus?.(event), {
        state: 'connected_idle',
      });
      await statusPage.waitForTimeout(300);
      await statusPage.click('#button-sync');
      await statusPage.waitForTimeout(300);
      await statusPage.click('#button-about');
      await statusPage.waitForTimeout(400);

      const afterCommands = await readDiagnostics(app);
      if ((afterCommands.commands?.['sync-now'] ?? 0) < 1) {
        failures.push('phase3: sync-now command was not received from the window');
      }
      if ((afterCommands.commands?.['open-about'] ?? 0) < 1) {
        failures.push('phase3: open-about command was not received from the window');
      }

      // About (§6.5): локальная страница, лицензии, диагностика.
      await statusPage.waitForTimeout(800);
      const aboutPage = app
        .windows()
        .find((candidate) => candidate.url().includes('about.html'));
      if (!aboutPage) {
        failures.push('phase3: about page not found');
      } else {
        aboutPage.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(`[about] ${message.text()}`);
        });
        aboutPage.on('pageerror', (error) => consoleErrors.push(`[about] ${String(error)}`));
        await aboutPage.waitForLoadState('domcontentloaded').catch(() => undefined);
        await aboutPage.waitForTimeout(600);
        const licensesHref = await aboutPage.getAttribute('#link-licenses', 'href');
        if (licensesHref !== 'https://flyflare.ru/licenses') {
          failures.push(`phase3: about licenses link is wrong (${licensesHref})`);
        }
        if (!(await aboutPage.isVisible('#titlebar'))) {
          failures.push('phase3: about custom titlebar is missing');
        }
        const aboutShot = join(statusOutDir, 'app-about.png');
        await aboutPage.screenshot({ path: aboutShot });
        statusScreenshots.push(aboutShot);

        // W1b: диагностика отправляется только после согласия.
        if (!(await aboutPage.isDisabled('#button-diagnostics'))) {
          failures.push('phase3: send-diagnostics is enabled without consent');
        }

        // FIX-UPDATE-CHECK-FEEDBACK: ручная проверка обновлений даёт видимый итог.
        await aboutPage.click('#button-updates');
        await aboutPage.waitForTimeout(800);
        const aboutUpdateStatus = (await aboutPage.textContent('#update-status'))?.trim() ?? '';
        if (aboutUpdateStatus.length === 0) {
          failures.push('phase3: About update check produced no visible result');
        }
        const afterUpdateCheck = await readDiagnostics(app);
        if ((afterUpdateCheck.commands?.['check-updates'] ?? 0) < 1) {
          failures.push('phase3: check-updates command was not received from About');
        }
      }

      // FIX-UPDATE-CHECK-FEEDBACK: та же обратная связь в окне «Состояние агента»
      // (в unpackaged-сборке проверка недоступна → нейтральная ошибка, не молчание).
      await statusPage.click('#button-check-updates');
      await statusPage.waitForTimeout(800);
      const statusUpdateVisible = await statusPage.isVisible('#update');
      const statusUpdateText = (await statusPage.textContent('#update-text'))?.trim() ?? '';
      if (!statusUpdateVisible) {
        failures.push('phase3: status update check row did not appear');
      }
      if (!/Не удалось проверить обновления/.test(statusUpdateText)) {
        failures.push(`phase3: unexpected status update result: "${statusUpdateText}"`);
      }

      await statusPage.evaluate(async () => {
        await window.flightlog?.stopAgent();
      });
      await statusPage.waitForTimeout(500);
    }
  } finally {
    await app.close().catch(() => undefined);
  }
} catch (error) {
  failures.push(`phase3 crashed: ${error instanceof Error ? error.message : String(error)}`);
}

// ── Фаза 4: device-flow в окне клиента, без системного браузера (T116) ──
try {
  const app = await launchApp();
  try {
    // Не открываем реальный системный браузер во время smoke: подменяем
    // `shell.openExternal` заглушкой (счётчик запросов в диагностике сохраняется).
    await app.evaluate(({ shell }) => {
      shell.openExternal = async () => undefined;
    });

    const sitePage = await app.firstWindow({ timeout: 60_000 });
    await sitePage.waitForLoadState('domcontentloaded').catch(() => undefined);
    await sitePage.waitForTimeout(4_000);

    await app.evaluate(() => globalThis.__flightlogOpenStatus?.());
    await sitePage.waitForTimeout(500);

    const statusPage = app.windows().find((candidate) => candidate.url().includes('status.html'));
    if (!statusPage) {
      failures.push('phase4: status page not found');
    } else {
      statusPage.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(`[device] ${message.text()}`);
      });
      statusPage.on('pageerror', (error) => consoleErrors.push(`[device] ${String(error)}`));
      await statusPage.waitForLoadState('domcontentloaded').catch(() => undefined);
      await statusPage.waitForTimeout(500);

      await statusPage.evaluate(async () => {
        await window.flightlog?.startAgent();
      });
      await statusPage.waitForTimeout(1_000);

      // Эмулируем код от agent-host для origin сайта (T-CLIENT2: только внешний браузер).
      const smokeWebOrigin = (process.env.FLIGHTLOG_WEB_URL ?? 'http://127.0.0.1:9').replace(
        /\/+$/,
        '',
      );
      await app.evaluate((_electron, info) => globalThis.__flightlogHandleUserCode?.(info), {
        user_code: 'WXYZ-1234',
        verification_uri: `${smokeWebOrigin}/device`,
        expires_in: 600,
      });
      await statusPage.waitForTimeout(500);

      const deviceState = await app.evaluate(() => globalThis.__flightlogDeviceState?.());
      if (!deviceState?.pending) failures.push('phase4: device flow is not pending');
      if (deviceState?.userCode !== 'WXYZ-1234') {
        failures.push(`phase4: user code missing (${deviceState?.userCode})`);
      }
      if (!deviceState?.verificationUri?.includes('/device')) {
        failures.push(`phase4: verification URI missing (${deviceState?.verificationUri})`);
      }

      // Главное требование: системный браузер сам не открывается.
      const externalBefore = await app.evaluate(
        () => globalThis.__flightlogExternalOpenRequests ?? 0,
      );
      if (externalBefore !== 0) {
        failures.push('phase4: external browser was opened automatically');
      }

      const cardVisible = await statusPage.isVisible('#device-code');
      if (!cardVisible) failures.push('phase4: device code card is not visible');
      const codeText = (await statusPage.textContent('#device-code-value'))?.trim();
      if (codeText !== 'WXYZ-1234') {
        failures.push(`phase4: unexpected user code rendered (${codeText})`);
      }
      const deviceShot = join(statusOutDir, 'device-auth-required.png');
      await statusPage.screenshot({ path: deviceShot });
      statusScreenshots.push(deviceShot);

      await statusPage.click('#button-copy-code');
      await statusPage.waitForTimeout(300);
      const afterCopy = await readDiagnostics(app);
      if ((afterCopy.commands?.['copy-user-code'] ?? 0) < 1) {
        failures.push('phase4: copy-user-code command was not received');
      }

      // Подтверждение: браузер открывается только по явной кнопке (T-CLIENT2).
      await statusPage.click('#button-open-device');
      await statusPage.waitForTimeout(300);
      const externalAfter = await app.evaluate(
        () => globalThis.__flightlogExternalOpenRequests ?? 0,
      );
      if (externalAfter < 1) {
        failures.push('phase4: manual browser open did not fire');
      }

      // Истёкший код: «запросить новый» вместо действий подтверждения.
      await app.evaluate((_electron, event) => globalThis.__flightlogEmitStatus?.(event), {
        state: 'auth_required',
        userCode: 'WXYZ-1234',
        verificationUri: `${smokeWebOrigin}/device`,
        userCodeExpiresAt: new Date(Date.now() - 1_000).toISOString(),
        message: 'Код истёк — запросите новый.',
      });
      await statusPage.waitForTimeout(400);
      if (!(await statusPage.isVisible('#button-request-code'))) {
        failures.push('phase4: expired code did not offer a new code');
      }
      const expiredText = await statusPage.textContent('#device-code-timer');
      if (!expiredText?.includes('истёк')) {
        failures.push(`phase4: expired timer text missing (${expiredText})`);
      }
      const expiredShot = join(statusOutDir, 'device-auth-expired.png');
      await statusPage.screenshot({ path: expiredShot });
      statusScreenshots.push(expiredShot);

      // F-102: sim_waiting/connected_idle больше не закрывают device-flow.
      await app.evaluate((_electron, event) => globalThis.__flightlogEmitStatus?.(event), {
        state: 'sim_waiting',
      });
      await statusPage.waitForTimeout(300);
      const afterHeuristic = await app.evaluate(() => globalThis.__flightlogDeviceState?.());
      if (!afterHeuristic?.pending) {
        failures.push('phase4: sim_waiting closed device flow (F-102 regression)');
      }

      // Авторизация: pending сбрасывается только по явному authorized.
      await app.evaluate((_electron, event) => globalThis.__flightlogEmitStatus?.(event), {
        state: 'authorized',
      });
      await statusPage.waitForTimeout(400);
      const afterAuth = await app.evaluate(() => globalThis.__flightlogDeviceState?.());
      if (afterAuth?.pending) failures.push('phase4: device flow not cleared after authorization');
      const clearedShot = join(statusOutDir, 'device-auth-approved.png');
      await statusPage.screenshot({ path: clearedShot });
      statusScreenshots.push(clearedShot);

      const badConsole = consoleErrors.filter((line) =>
        /Uncaught|TypeError|ReferenceError|Worker failed/.test(line),
      );
      if (badConsole.length > 0) {
        failures.push(`phase4: renderer console errors: ${badConsole.join(' | ')}`);
      }
    }
  } finally {
    await app.close().catch(() => undefined);
  }
} catch (error) {
  failures.push(`phase4 crashed: ${error instanceof Error ? error.message : String(error)}`);
}

// ── Фаза 5: T117 (иконка под тему ОС) + T118 (hotkey, GlitchTip-согласие) ──
try {
  const app = await launchApp();
  try {
    const sitePage = await app.firstWindow({ timeout: 60_000 });
    await sitePage.waitForLoadState('domcontentloaded').catch(() => undefined);
    await sitePage.waitForTimeout(5_000);

    const diag = await readDiagnostics(app);
    diagnosticsLog.phase5 = diag;
    if (diag.hotkey) failures.push('phase5: legacy status hotkey must not be registered');
    if (diag.trayVariant !== 'dark' && diag.trayVariant !== 'light') {
      failures.push(`phase5: unexpected tray variant (${diag.trayVariant})`);
    }

    const trayPng = async () =>
      app.evaluate(() => globalThis.__flightlogTrayIconPng ?? null);

    // Тёмная тема → dark-вариант (светлый глиф).
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark';
    });
    await sitePage.waitForTimeout(400);
    const darkDiag = await readDiagnostics(app);
    const darkPng = await trayPng();
    if (darkDiag.trayVariant !== 'dark') {
      failures.push(`phase5: dark theme variant expected, got ${darkDiag.trayVariant}`);
    }
    if (darkPng) writeFileSync(join(releaseDir, 'tray-dark.png'), Buffer.from(darkPng, 'base64'));
    statusScreenshots.push(join(releaseDir, 'tray-dark.png'));

    // Светлая тема → инверсный light-вариант, без перезапуска.
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light';
    });
    await sitePage.waitForTimeout(500);
    const lightDiag = await readDiagnostics(app);
    const lightPng = await trayPng();
    if (lightDiag.trayVariant !== 'light') {
      failures.push(`phase5: light theme variant expected, got ${lightDiag.trayVariant}`);
    }
    if (lightPng) writeFileSync(join(releaseDir, 'tray-light.png'), Buffer.from(lightPng, 'base64'));
    statusScreenshots.push(join(releaseDir, 'tray-light.png'));
    if (darkPng && lightPng && darkPng === lightPng) {
      failures.push('phase5: tray glyph did not invert on theme change');
    }

    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'system';
    });

    // About: GlitchTip-согласие (opt-in) без legacy-hotkey.
    await app.evaluate(() => globalThis.__flightlogOpenStatus?.());
    await sitePage.waitForTimeout(500);
    const statusPage = app.windows().find((candidate) => candidate.url().includes('status.html'));
    if (!statusPage) {
      failures.push('phase5: status page not found');
    } else {
      statusPage.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(`[phase5-status] ${message.text()}`);
      });
      statusPage.on('pageerror', (error) => consoleErrors.push(`[phase5-status] ${String(error)}`));
      await statusPage.waitForLoadState('domcontentloaded').catch(() => undefined);
      await statusPage.waitForTimeout(500);
      await statusPage.click('#button-about');
      await statusPage.waitForTimeout(800);

      const aboutPage = app.windows().find((candidate) => candidate.url().includes('about.html'));
      if (!aboutPage) {
        failures.push('phase5: about page not found');
      } else {
        aboutPage.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(`[phase5-about] ${message.text()}`);
        });
        aboutPage.on('pageerror', (error) => consoleErrors.push(`[phase5-about] ${String(error)}`));
        await aboutPage.waitForLoadState('domcontentloaded').catch(() => undefined);
        await aboutPage.waitForTimeout(600);

        const hotkeyLine = await aboutPage.$('#hotkey-line');
        if (hotkeyLine) {
          failures.push('phase5: legacy hotkey line is still present');
        }
        const consentVisible = await aboutPage.isVisible('#consent-checkbox');
        if (!consentVisible) failures.push('phase5: error-reporting consent checkbox missing');
        const consentStatus = (await aboutPage.textContent('#consent-status'))?.trim() ?? '';
        if (consentStatus.length === 0) {
          failures.push('phase5: error-reporting status is empty');
        }
        if (!(await aboutPage.isDisabled('#button-diagnostics'))) {
          failures.push('phase5: send-diagnostics is enabled without consent');
        }

        await aboutPage.check('#consent-checkbox');
        await aboutPage.waitForTimeout(700);
        const saved = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'));
        if (saved.errorReportingConsent !== true) {
          failures.push('phase5: error-reporting consent was not persisted');
        }
        if ((await aboutPage.isChecked('#consent-checkbox')) !== true) {
          failures.push('phase5: consent checkbox did not stay checked');
        }
        const consentShot = join(statusOutDir, 'app-about-consent.png');
        await aboutPage.screenshot({ path: consentShot });
        statusScreenshots.push(consentShot);
      }
    }
  } finally {
    await app.close().catch(() => undefined);
  }
} catch (error) {
  failures.push(`phase5 crashed: ${error instanceof Error ? error.message : String(error)}`);
}

const summary = {
  ok: failures.length === 0,
  diagnostics: diagnosticsLog,
  screenshots: [outPng, outHiddenPng, ...statusScreenshots],
  consoleErrors,
  failures,
};
console.log(JSON.stringify(summary, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;
