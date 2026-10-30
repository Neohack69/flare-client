import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({ setApplicationMenu: vi.fn() }));

vi.mock('electron', () => ({
  Menu: { setApplicationMenu: electronState.setApplicationMenu },
}));

import { removeApplicationMenu } from './menu';

describe('T-CLIENT3: меню приложения отключено', () => {
  it('removeApplicationMenu ставит Menu.setApplicationMenu(null)', () => {
    removeApplicationMenu();
    expect(electronState.setApplicationMenu).toHaveBeenCalledTimes(1);
    expect(electronState.setApplicationMenu).toHaveBeenCalledWith(null);
  });

  it('окна не возвращают строку меню (нет autoHideMenuBar/setMenuBarVisibility(true))', () => {
    for (const file of ['status-window.ts', 'about-window.ts']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/autoHideMenuBar/);
      expect(source).not.toMatch(/setMenuBarVisibility\s*\(\s*true/);
    }
  });
});
