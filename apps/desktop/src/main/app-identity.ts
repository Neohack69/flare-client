import { execFile } from 'node:child_process';
import { join } from 'node:path';

import { app } from 'electron';

/**
 * Единая идентичность клиента. Без этого ОС показывает имя рантайма «Electron»
 * (уведомления, taskbar, single-instance), а не «Flare».
 */
export const APP_NAME = 'Flare';

/** Совпадает с `appId` в `electron-builder.yml` — OS-уведомления и taskbar. */
export const APP_USER_MODEL_ID = 'dev.flightlog.desktop';

/**
 * Имя файла иконки окна/таскбара. Windows должен получать `.ico`:
 * Electron для Windows рекомендует ICO («you can also leave it undefined so the
 * executable's icon will be used»); PNG в `BrowserWindow.icon` может не дать
 * нужный таскбар-образ и откатиться на иконку процесса (в dev — `electron.exe`,
 * т.е. логотип Electron).
 */
export function appIconFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'icon.ico' : 'icon.png';
}

export interface IdentityTarget {
  setName(name: string): void;
  setAppUserModelId?(id: string): void;
}

/**
 * Задаёт имя приложения и Windows AppUserModelId. Вызывать до `app.whenReady()`:
 * identity влияет на userData/single-instance и на то, как ОС подписывает
 * уведомления и ярлык в taskbar.
 */
export function applyAppIdentity(
  target: IdentityTarget = app,
  platform: NodeJS.Platform = process.platform,
): void {
  target.setName(APP_NAME);
  if (platform === 'win32') target.setAppUserModelId?.(APP_USER_MODEL_ID);
}

export interface AppIconPathInput {
  isPackaged: boolean;
  /** `process.resourcesPath` — packaged: `build/icon.ico|png` копируется в extraResources. */
  resourcesPath: string;
  /** Корень приложения (dev): `<appRoot>/build/icon.ico|png`. */
  appRoot: string;
  platform: NodeJS.Platform;
}

/**
 * Путь к иконке окна/таскбара: Windows — `icon.ico`, прочие — `icon.png`
 * (dev — `build/`, packaged — `resources/`). macOS иконку окна не использует.
 */
export function resolveAppIconPath(input: AppIconPathInput): string | undefined {
  if (input.platform === 'darwin') return undefined;
  const fileName = appIconFileName(input.platform);
  return input.isPackaged
    ? join(input.resourcesPath, fileName)
    : join(input.appRoot, 'build', fileName);
}

/**
 * Windows-путь → `file:`-URI (`C:\a\b` → `file:///C:/a/b`).
 * AppUserModelId `IconUri` ожидает URI, а не «сырой» Windows-путь.
 */
export function toFileUri(path: string): string {
  const forwardSlashed = path.replace(/\\/g, '/');
  // UNC `\\server\share` → `file://server/share`.
  if (forwardSlashed.startsWith('//')) return `file:${forwardSlashed}`;
  return `file:///${forwardSlashed.replace(/^\/+/, '')}`;
}

export interface RegisterAumidOptions {
  aumid?: string;
  displayName?: string;
  /** Иконка окна/таскбара (`.ico` на Windows); без неё регистрируется только имя. */
  iconPath?: string | undefined;
  /**
   * Полный путь к `.exe` для `RelaunchCommand`. Без него relaunch-значения
   * (`RelaunchCommand`/`RelaunchDisplayNameResource`/`RelaunchIconResource`)
   * не пишутся — они задаются только вместе.
   */
  executablePath?: string | undefined;
  platform?: NodeJS.Platform;
  /** Инъекция запуска процесса (unit-тесты). */
  execute?: (file: string, args: string[]) => Promise<void>;
}

function runReg(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Windows показывает в тостах и таскбаре имя/иконку, зарегистрированные для
 * AppUserModelId. Установленный билд берёт их из ярлыка (electron-builder:
 * `WinShell::SetLnkAUMI` = `appId`), а запуск без установки (dev/portable) —
 * без ярлыка, поэтому Windows откатывается на описание `electron.exe`
 * («Electron»/его иконку). Регистрируем
 * `HKCU\Software\Classes\AppUserModelId\<aumid>` — способ для unpackaged
 * Win32-приложений (Chromium/Electron-приложения используют тот же ключ).
 *
 * `IconUri` — URI, а не путь: «сырой» `C:\...\icon.ico` shell не резолвит.
 * `Relaunch*` соответствуют свойствам `System.AppUserModel.*`
 * (https://learn.microsoft.com/windows/win32/properties/props-system-appusermodel-relaunchiconresource);
 * `RelaunchCommand` и `RelaunchDisplayNameResource` обязаны задаваться вместе,
 * иначе не применяются, а `RelaunchIconResource` для прямого `.ico` требует
 * resource id (`"<path>,0"`).
 *
 * Идемпотентно (`/f`) и best-effort: любая ошибка реестра игнорируется —
 * приложение не должно падать из-за политики/прав на HKCU.
 */
export async function registerAppUserModelId(
  options: RegisterAumidOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return;
  const aumid = options.aumid ?? APP_USER_MODEL_ID;
  const displayName = options.displayName ?? APP_NAME;
  const execute = options.execute ?? runReg;
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${aumid}`;

  const write = async (value: string, data: string): Promise<void> => {
    try {
      await execute('reg.exe', [
        'add',
        key,
        '/v',
        value,
        '/t',
        'REG_SZ',
        '/d',
        data,
        '/f',
      ]);
    } catch {
      // best-effort: без прав/политики реестра тост/таскбар останутся с fallback
    }
  };

  await write('DisplayName', displayName);
  if (!options.iconPath) return;
  await write('IconUri', toFileUri(options.iconPath));
  if (!options.executablePath) return;
  await write('RelaunchCommand', `"${options.executablePath}"`);
  await write('RelaunchDisplayNameResource', displayName);
  await write('RelaunchIconResource', `${options.iconPath},0`);
}

export interface IconWindow {
  setIcon(icon: string): void;
}

/**
 * Дублирует иконку окна через `win.setIcon`. Конструктор `BrowserWindow.icon`
 * на Windows не всегда надёжен для таскбара (особенно с PNG) — явный вызов
 * с ICO-путём страхует. Best-effort: сбой иконки не должен ронять окно.
 */
export function applyWindowIcon(win: IconWindow, iconPath?: string): void {
  if (!iconPath) return;
  try {
    win.setIcon(iconPath);
  } catch {
    // иконка не критична для работы окна
  }
}
