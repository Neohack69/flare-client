// ---------------------------------------------------------------------------
// installer-nsis.test.mjs — guard для self-heal легаси-ярлыков taskbar/AUMID.
//
// Статическая проверка без запуска electron-builder (тяжёлую сборку делает CI):
//   * `electron-builder.yml` подключает custom-скрипт через `nsis.include`;
//   * `build/installer.nsh` определяет хуки customInstall/customUnInstall и
//     удаляет легаси-ярлыки «Electron»/«Touchdown Moment», НЕ трогая Flare.lnk.
//
// WHY: застрявший dev-ярлык Electron.lnk с нашим AUMID заставлял Windows
// подписывать кнопку taskbar как «Electron» (см. build/installer.nsh).
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

const builderYml = readFileSync(resolve(appRoot, 'electron-builder.yml'), 'utf8');
const installerNsh = readFileSync(resolve(appRoot, 'build', 'installer.nsh'), 'utf8');

const LEGACY_SHORTCUTS = [
  '$SMPROGRAMS\\Electron.lnk',
  '$SMPROGRAMS\\Touchdown Moment.lnk',
  '$DESKTOP\\Electron.lnk',
  '$DESKTOP\\Touchdown Moment.lnk',
];

describe('NSIS self-heal легаси-ярлыков (AUMID/taskbar)', () => {
  it('electron-builder.yml подключает custom-include build/installer.nsh', () => {
    expect(builderYml).toMatch(/^nsis:\s*$/m);
    expect(builderYml).toMatch(/^\s+include:\s*build\/installer\.nsh\s*$/m);
  });

  it('installer.nsh определяет хуки customInstall и customUnInstall', () => {
    expect(installerNsh).toMatch(/!macro customInstall\b/);
    expect(installerNsh).toMatch(/!macro customUnInstall\b/);
  });

  it('удаляет все легаси-ярлыки Electron/Touchdown Moment (Start Menu + Desktop)', () => {
    for (const shortcut of LEGACY_SHORTCUTS) {
      expect(installerNsh).toContain(`Delete "${shortcut}"`);
    }
  });

  it('НЕ удаляет текущий ярлык Flare.lnk', () => {
    expect(installerNsh).not.toMatch(/Delete\s+"[^"]*\\Flare\.lnk"/);
  });
});
