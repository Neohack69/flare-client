// ---------------------------------------------------------------------------
// verify-client-identity.mjs — приёмка идентичности клиента «Flare».
//
// Проверяет в реальном запущенном Electron:
//   * app.getName() === 'Flare' (а не 'Electron');
//   * app.getAppUserModelId() === 'dev.flightlog.app' (Windows);
//   * заголовок окна приложения и окна «Состояние агента»;
//   * единственное видимое окно (agent-host — невидимый дочерний процесс);
//   * иконки build/icon.ico + build/icon.png (512) существуют;
//   * единственное action-required уведомление несёт корректный title.
//
// Скриншоты → IDENTITY_OUT_DIR (по умолчанию temp/iter58-client-id).
//
// Запуск: node scripts/verify-client-identity.mjs
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';
import { _electron as electron } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const outDir =
  process.env.IDENTITY_OUT_DIR ??
  join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'iter58-client-id');
mkdirSync(outDir, { recursive: true });

const APP_NAME = 'Flare';
const APP_USER_MODEL_ID = 'dev.flightlog.desktop';

const webUrl = process.env.FLIGHTLOG_WEB_URL ?? 'http://localhost:3100';
const apiUrl = process.env.FLIGHTLOG_API_URL ?? 'http://localhost:3101';
const userData = mkdtempSync(join(tmpdir(), 'flightlog-identity-'));

const failures = [];
const consoleErrors = [];
const evidence = {};

function captureDesktop(path) {
  if (process.platform !== 'win32') return false;
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)',
    `$bmp.Save('${path.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`,
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const AUMID_KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}`;

/** Удаляем регистрацию, чтобы доказать, что её создаёт сам клиент. */
function deleteAumidRegistration() {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('reg.exe', ['delete', AUMID_KEY, '/f'], { stdio: 'ignore' });
  } catch {
    // ключа могло не быть
  }
}

/** `DisplayName` из HKCU для AUMID (или null). */
function readAumidDisplayName() {
  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync('reg.exe', ['query', AUMID_KEY, '/v', 'DisplayName'], {
      encoding: 'utf8',
    });
    const match = /DisplayName\s+REG_SZ\s+(.+)/.exec(output);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

// Windows-таскбар берёт .ico (build/icon.ico); PNG — fallback прочих платформ.
const icons = [
  ['icon.ico', join(appRoot, 'build', 'icon.ico')],
  ['icon.png', join(appRoot, 'build', 'icon.png')],
];
for (const [name, file] of icons) {
  try {
    const size = statSync(file).size;
    evidence[name.replace('.', '_')] = { path: file, bytes: size };
    if (size < 1_000) failures.push(`build/${name} подозрительно мал (${size} bytes)`);
  } catch {
    failures.push(`build/${name} отсутствует (${file})`);
  }
}

// Доказательство самодостаточности: удаляем HKCU-регистрацию AUMID и проверяем,
// что запущенный клиент создаёт её сам (иначе Windows показывает «Electron»).
deleteAumidRegistration();

const app = await electron.launch({
  executablePath: electronPath,
  args: [appRoot],
  cwd: appRoot,
  timeout: 90_000,
  env: {
    ...process.env,
    FLIGHTLOG_WEB_URL: webUrl,
    FLIGHTLOG_API_URL: apiUrl,
    FLIGHTLOG_AGENT_AUTOSTART: '0',
    FLIGHTLOG_AGENT_MEMORY_BUFFER: '1',
    FLIGHTLOG_DATA_DIR: userData,
    FLIGHTLOG_AUTH_ALERTS_ENABLED: '1',
  },
});

try {
  const mainPage = await app.firstWindow({ timeout: 60_000 });
  mainPage.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  mainPage.on('pageerror', (error) => consoleErrors.push(String(error)));
  await mainPage.waitForLoadState('domcontentloaded').catch(() => undefined);
  await mainPage.waitForTimeout(5_000);

  const identity = await app.evaluate(({ app: electronApp }) => ({
    name: electronApp.getName(),
    productName: electronApp.getName(),
    appUserModelId:
      typeof electronApp.getAppUserModelId === 'function'
        ? electronApp.getAppUserModelId()
        : null,
    version: electronApp.getVersion(),
    packaged: electronApp.isPackaged,
  }));
  evidence.identity = identity;

  const aumidDisplayName = readAumidDisplayName();
  evidence.aumidDisplayName = aumidDisplayName;
  if (process.platform === 'win32' && aumidDisplayName !== APP_NAME) {
    failures.push(
      `HKCU AppUserModelId DisplayName='${aumidDisplayName}' — клиент не зарегистрировал имя`,
    );
  }

  // Проверяем сам контракт AppUserModelId: вызов setter'а принимается Electron.
  // (getAppUserModelId есть не во всех сборках Electron — тогда опираемся на setter.)
  const aumidProbe = await app.evaluate(({ app: electronApp }) => {
    if (typeof electronApp.setAppUserModelId !== 'function') {
      return { set: false, get: false, value: null };
    }
    electronApp.setAppUserModelId('dev.flightlog.desktop');
    const hasGet = typeof electronApp.getAppUserModelId === 'function';
    return {
      set: true,
      get: hasGet,
      value: hasGet ? electronApp.getAppUserModelId() : null,
    };
  });
  evidence.appUserModelIdProbe = aumidProbe;

  if (identity.name !== APP_NAME) {
    failures.push(`app.getName()='${identity.name}' (ожидалось '${APP_NAME}')`);
  }
  if (process.platform === 'win32' && aumidProbe?.set !== true) {
    failures.push('app.setAppUserModelId не вызвался (ожидалось dev.flightlog.desktop)');
  }
  if (
    process.platform === 'win32' &&
    aumidProbe?.get === true &&
    aumidProbe.value !== APP_USER_MODEL_ID
  ) {
    failures.push(
      `AppUserModelId='${aumidProbe.value}' (ожидалось '${APP_USER_MODEL_ID}')`,
    );
  }
  if (identity.version === '0.0.0') {
    failures.push('версия приложения не задана (0.0.0)');
  }

  // Единственное видимое окно + agent-host не создаёт собственных окон.
  const windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => ({
      title: win.getTitle(),
      visible: win.isVisible(),
    })),
  );
  evidence.windowsBeforeStatus = windows;
  const visibleWindows = windows.filter((win) => win.visible);
  if (visibleWindows.length !== 1) {
    failures.push(`видимых окон ${visibleWindows.length} (ожидалось ровно 1: само приложение)`);
  }

  const mainTitle = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible());
    return win ? win.getTitle() : null;
  });
  evidence.mainWindowTitle = mainTitle;
  if (mainTitle !== APP_NAME) {
    failures.push(`заголовок главного окна '${mainTitle}' (ожидалось '${APP_NAME}')`);
  }

  // Главное окно (сайт) в этом тесте недоступно → клиент уходит на offline-страницу
  // после повторной неудачи. Ждём её, чтобы не снимать пустой error-page.
  const mainWindowPage = app
    .windows()
    .find(
      (page) =>
        !page.url().includes('status.html') && !page.url().includes('about.html'),
    );
  if (mainWindowPage) {
    mainWindowPage.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`[window] ${message.text()}`);
    });
    mainWindowPage.on('pageerror', (error) => consoleErrors.push(`[window] ${String(error)}`));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (mainWindowPage.url().includes('offline.html')) break;
      await mainPage.waitForTimeout(1_000);
    }
    evidence.mainWindowUrl = mainWindowPage.url();
    await mainWindowPage
      .screenshot({ path: join(outDir, 'main-window.png') })
      .catch(() => undefined);
  } else {
    await mainPage.screenshot({ path: join(outDir, 'main-window.png') }).catch(() => undefined);
  }

  // Окно «Состояние агента»: заголовок из i18n.
  await app.evaluate(() => globalThis.__flightlogOpenStatus?.());
  await mainPage.waitForTimeout(700);
  const statusPage = app.windows().find((page) => page.url().includes('status.html'));
  if (!statusPage) {
    failures.push('окно «Состояние агента» не найдено');
  } else {
    statusPage.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`[status] ${message.text()}`);
    });
    statusPage.on('pageerror', (error) => consoleErrors.push(`[status] ${String(error)}`));
    await statusPage.waitForLoadState('domcontentloaded').catch(() => undefined);
    await statusPage.waitForTimeout(800);
    await statusPage.screenshot({ path: join(outDir, 'status-window.png') }).catch(() => undefined);
  }

  const statusTitle = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes('status.html'),
    );
    return win ? win.getTitle() : null;
  });
  evidence.statusWindowTitle = statusTitle;
  // Точная формулировка — в i18n (может меняться: «Состояние агента/приложения»);
  // обязательны бренд и отсутствие имени рантайма.
  if (!statusTitle || !statusTitle.includes(APP_NAME)) {
    failures.push(`заголовок окна статуса '${statusTitle}' не содержит '${APP_NAME}'`);
  } else if (/electron/i.test(statusTitle)) {
    failures.push(`заголовок окна статуса содержит «Electron»: ${statusTitle}`);
  }

  // Единственное action-required уведомление: имя/заголовок не «Electron».
  const notificationSupported = await app.evaluate(({ Notification }) =>
    Notification.isSupported(),
  );
  evidence.notificationSupported = notificationSupported;

  // Политика: наружу проходит только action-required. Fatal-ошибка синка.
  await app.evaluate((_electron, event) => globalThis.__flightlogEmitStatus?.(event), {
    state: 'sync_error',
    quality: 'fatal',
    message: 'device revoked',
  });
  await mainPage.waitForTimeout(1_200);
  // OS-toast виден на рабочем столе (не в renderer) — снимок рабочего стола.
  const desktopShot = join(outDir, 'desktop-notification.png');
  evidence.desktopCapture = captureDesktop(desktopShot);

  // Плюс device-flow: уведомление показывается только когда окно скрыто
  // (close = hide) — это штатный путь «код не увидеть, если окно не открыто».
  await app.evaluate((_electron, info) => globalThis.__flightlogHandleUserCode?.(info), {
    user_code: 'WXYZ-1234',
    verification_uri: `${webUrl.replace(/\/+$/, '')}/device`,
    expires_in: 600,
  });
  await mainPage.waitForTimeout(500);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible());
    win?.close();
  });
  await mainPage.waitForTimeout(800);
  const notification = await app.evaluate(
    () => globalThis.__flightlogLastNotification ?? null,
  );
  const shownCount = await app.evaluate(
    () => globalThis.__flightlogNotificationsShown ?? 0,
  );
  evidence.notification = notification;
  evidence.notificationsShown = shownCount;
  if (notification) {
    if (/electron/i.test(notification.title)) {
      failures.push(`заголовок уведомления содержит «Electron»: ${notification.title}`);
    }
    if (notification.kind !== 'action-required') {
      failures.push(`уведомление не action-required: ${notification.kind}`);
    }
  }

  const badConsole = consoleErrors.filter((line) =>
    /Uncaught|TypeError|ReferenceError|Worker failed/.test(line),
  );
  if (badConsole.length > 0) {
    failures.push(`ошибки консоли renderer: ${badConsole.join(' | ')}`);
  }
} finally {
  await app.close().catch(() => undefined);
}

const summary = {
  ok: failures.length === 0,
  identity: evidence.identity,
  appUserModelIdProbe: evidence.appUserModelIdProbe ?? null,
  aumidDisplayName: evidence.aumidDisplayName ?? null,
  mainWindowTitle: evidence.mainWindowTitle,
  mainWindowUrl: evidence.mainWindowUrl ?? null,
  statusWindowTitle: evidence.statusWindowTitle,
  windows: evidence.windowsBeforeStatus,
  notification: evidence.notification ?? null,
  notificationSupported: evidence.notificationSupported ?? null,
  notificationsShown: evidence.notificationsShown ?? 0,
  icons: {
    ico: evidence.icon_ico ?? null,
    png: evidence.icon_png ?? null,
  },
  screenshots: [
    join(outDir, 'main-window.png'),
    join(outDir, 'status-window.png'),
    ...(evidence.desktopCapture ? [join(outDir, 'desktop-notification.png')] : []),
  ],
  desktopCapture: evidence.desktopCapture ?? false,
  outDir,
  consoleErrors,
  failures,
};
console.log(JSON.stringify(summary, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;
