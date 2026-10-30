import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { setName: vi.fn(), setAppUserModelId: vi.fn() },
}));

import {
  APP_NAME,
  APP_USER_MODEL_ID,
  appIconFileName,
  applyAppIdentity,
  applyWindowIcon,
  registerAppUserModelId,
  resolveAppIconPath,
  toFileUri,
} from './app-identity';

describe('applyAppIdentity', () => {
  it('задаёт «Flare» и AppUserModelId на Windows', () => {
    const target = { setName: vi.fn(), setAppUserModelId: vi.fn() };
    applyAppIdentity(target, 'win32');
    expect(target.setName).toHaveBeenCalledWith(APP_NAME);
    expect(target.setAppUserModelId).toHaveBeenCalledWith(APP_USER_MODEL_ID);
  });

  it('вне Windows не трогает AppUserModelId', () => {
    const target = { setName: vi.fn(), setAppUserModelId: vi.fn() };
    applyAppIdentity(target, 'linux');
    expect(target.setName).toHaveBeenCalledWith(APP_NAME);
    expect(target.setAppUserModelId).not.toHaveBeenCalled();
  });

  it('устойчив, если setAppUserModelId недоступен', () => {
    const target = { setName: vi.fn() };
    expect(() => applyAppIdentity(target, 'win32')).not.toThrow();
    expect(target.setName).toHaveBeenCalledWith(APP_NAME);
  });
});

describe('appIconFileName', () => {
  it('Windows использует .ico (таскбар)', () => {
    expect(appIconFileName('win32')).toBe('icon.ico');
  });

  it('прочие платформы используют .png', () => {
    expect(appIconFileName('linux')).toBe('icon.png');
    expect(appIconFileName('darwin')).toBe('icon.png');
  });
});

describe('resolveAppIconPath', () => {
  it('dev на Windows берёт ICO из build/', () => {
    expect(
      resolveAppIconPath({
        isPackaged: false,
        resourcesPath: 'C:/resources',
        appRoot: join('H:/app'),
        platform: 'win32',
      }),
    ).toBe(join('H:/app', 'build', 'icon.ico'));
  });

  it('packaged на Windows берёт ICO из extraResources (resources/icon.ico)', () => {
    expect(
      resolveAppIconPath({
        isPackaged: true,
        resourcesPath: join('C:/Program Files/Flare/resources'),
        appRoot: join('C:/app.asar'),
        platform: 'win32',
      }),
    ).toBe(join('C:/Program Files/Flare/resources', 'icon.ico'));
  });

  it('dev на Linux берёт PNG из build/', () => {
    expect(
      resolveAppIconPath({
        isPackaged: false,
        resourcesPath: '/resources',
        appRoot: '/app',
        platform: 'linux',
      }),
    ).toBe(join('/app', 'build', 'icon.png'));
  });

  it('macOS не задаёт иконку окна', () => {
    expect(
      resolveAppIconPath({
        isPackaged: true,
        resourcesPath: '/Applications/Flare.app/Contents/Resources',
        appRoot: '/app.asar',
        platform: 'darwin',
      }),
    ).toBeUndefined();
  });
});

describe('toFileUri', () => {
  it('Windows-путь → file:/// с прямыми слэшами', () => {
    expect(toFileUri('H:\\app\\build\\icon.ico')).toBe('file:///H:/app/build/icon.ico');
  });

  it('пробелы в пути сохраняются', () => {
    expect(toFileUri('C:\\Program Files\\Flare\\resources\\icon.ico')).toBe(
      'file:///C:/Program Files/Flare/resources/icon.ico',
    );
  });

  it('POSIX-путь → file:///', () => {
    expect(toFileUri('/usr/share/icon.png')).toBe('file:///usr/share/icon.png');
  });

  it('UNC-путь → file://server/share', () => {
    expect(toFileUri('\\\\server\\share\\icon.ico')).toBe('file://server/share/icon.ico');
  });
});

describe('registerAppUserModelId', () => {
  it('вне Windows ничего не запускает', async () => {
    const execute = vi.fn(async () => undefined);
    await registerAppUserModelId({ platform: 'linux', execute });
    expect(execute).not.toHaveBeenCalled();
  });

  it('на Windows регистрирует DisplayName + IconUri (file URI) для AUMID', async () => {
    const calls: Array<[string, string[]]> = [];
    const execute = vi.fn(async (file: string, args: string[]) => {
      calls.push([file, args]);
    });
    await registerAppUserModelId({
      platform: 'win32',
      iconPath: 'H:\\app\\build\\icon.ico',
      execute,
    });
    expect(calls).toHaveLength(2);
    const [displayCall, iconCall] = calls as [[string, string[]], [string, string[]]];
    const key = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}`;
    expect(displayCall[0]).toBe('reg.exe');
    expect(displayCall[1]).toEqual([
      'add',
      key,
      '/v',
      'DisplayName',
      '/t',
      'REG_SZ',
      '/d',
      APP_NAME,
      '/f',
    ]);
    expect(iconCall[1]).toContain('IconUri');
    expect(iconCall[1]).toContain('file:///H:/app/build/icon.ico');
    expect(iconCall[1]).not.toContain('H:\\app\\build\\icon.ico');
  });

  it('на Windows регистрирует Relaunch-значения только с executablePath', async () => {
    const calls: string[][] = [];
    const execute = vi.fn(async (_file: string, args: string[]) => {
      calls.push(args);
    });
    await registerAppUserModelId({
      platform: 'win32',
      iconPath: 'H:\\app\\build\\icon.ico',
      executablePath: 'C:\\Program Files\\Flare\\Flare.exe',
      execute,
    });
    expect(calls).toHaveLength(5);
    const values = calls.map((args) => args[args.indexOf('/v') + 1]);
    expect(values).toEqual([
      'DisplayName',
      'IconUri',
      'RelaunchCommand',
      'RelaunchDisplayNameResource',
      'RelaunchIconResource',
    ]);
    const iconResource = calls[4] ?? [];
    expect(iconResource[iconResource.indexOf('/d') + 1]).toBe(
      'H:\\app\\build\\icon.ico,0',
    );
    const relaunchCommand = calls[2] ?? [];
    expect(relaunchCommand[relaunchCommand.indexOf('/d') + 1]).toBe(
      '"C:\\Program Files\\Flare\\Flare.exe"',
    );
  });

  it('без иконки регистрирует только имя', async () => {
    const execute = vi.fn(async () => undefined);
    await registerAppUserModelId({ platform: 'win32', execute });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('best-effort: ошибка reg.exe не роняет вызов', async () => {
    const execute = vi.fn(async () => {
      throw new Error('access denied');
    });
    await expect(
      registerAppUserModelId({ platform: 'win32', iconPath: 'H:\\app\\icon.ico', execute }),
    ).resolves.toBeUndefined();
  });
});

describe('applyWindowIcon', () => {
  it('вызывает setIcon с путём', () => {
    const win = { setIcon: vi.fn() };
    applyWindowIcon(win, 'H:\\app\\build\\icon.ico');
    expect(win.setIcon).toHaveBeenCalledWith('H:\\app\\build\\icon.ico');
  });

  it('без пути ничего не делает', () => {
    const win = { setIcon: vi.fn() };
    applyWindowIcon(win, undefined);
    expect(win.setIcon).not.toHaveBeenCalled();
  });

  it('best-effort: исключение setIcon проглатывается', () => {
    const win = {
      setIcon: vi.fn(() => {
        throw new Error('bad icon');
      }),
    };
    expect(() => applyWindowIcon(win, 'H:\\app\\icon.ico')).not.toThrow();
  });
});
