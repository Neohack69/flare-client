import { describe, expect, it, vi } from 'vitest';

import { registerStatusHotkey, unregisterStatusHotkey } from './hotkeys';

function makeShortcut(registerResult = true) {
  return {
    register: vi.fn((_accelerator: string, _callback: () => void) => registerResult),
    unregister: vi.fn((_accelerator: string) => {
      /* no-op */
    }),
  };
}

describe('registerStatusHotkey (T118)', () => {
  it('регистрирует настроенный акселератор и вызывает callback', () => {
    const shortcut = makeShortcut(true);
    const onTrigger = vi.fn();
    const result = registerStatusHotkey(
      shortcut,
      { enabled: true, accelerator: 'CommandOrControl+Alt+T' },
      onTrigger,
    );
    expect(result).toEqual({ accelerator: 'CommandOrControl+Alt+T', registered: true });
    expect(shortcut.register).toHaveBeenCalledWith('CommandOrControl+Alt+T', onTrigger);
    const call = shortcut.register.mock.calls[0];
    expect(call?.[0]).toBe('CommandOrControl+Alt+T');
    call?.[1]();
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('отключён в settings.json — не регистрирует', () => {
    const shortcut = makeShortcut(true);
    const result = registerStatusHotkey(
      shortcut,
      { enabled: false, accelerator: 'CommandOrControl+Alt+T' },
      vi.fn(),
    );
    expect(result).toEqual({ accelerator: null, registered: false });
    expect(shortcut.register).not.toHaveBeenCalled();
  });

  it('пустой акселератор не регистрирует', () => {
    const shortcut = makeShortcut(true);
    const result = registerStatusHotkey(shortcut, { enabled: true, accelerator: '   ' }, vi.fn());
    expect(result.registered).toBe(false);
    expect(shortcut.register).not.toHaveBeenCalled();
  });

  it('конфликт занятого hotkey — тихая деградация без падения', () => {
    const shortcut = makeShortcut(false);
    const warn = vi.fn();
    const result = registerStatusHotkey(
      shortcut,
      { enabled: true, accelerator: 'Ctrl+Alt+T' },
      vi.fn(),
      warn,
    );
    expect(result).toEqual({ accelerator: 'Ctrl+Alt+T', registered: false });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('исключение регистрации не роняет приложение', () => {
    const shortcut = makeShortcut();
    shortcut.register.mockImplementation(() => {
      throw new Error('boom');
    });
    const warn = vi.fn();
    const result = registerStatusHotkey(
      shortcut,
      { enabled: true, accelerator: 'Ctrl+Alt+T' },
      vi.fn(),
      warn,
    );
    expect(result.registered).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('unregisterStatusHotkey (T118)', () => {
  it('снимает только зарегистрированный hotkey', () => {
    const shortcut = makeShortcut();
    unregisterStatusHotkey(shortcut, { accelerator: 'Ctrl+Alt+T', registered: true });
    expect(shortcut.unregister).toHaveBeenCalledWith('Ctrl+Alt+T');
  });

  it('ничего не делает при неудачной регистрации/отсутствии настроек', () => {
    const shortcut = makeShortcut();
    unregisterStatusHotkey(shortcut, { accelerator: 'Ctrl+Alt+T', registered: false });
    unregisterStatusHotkey(shortcut, null);
    expect(shortcut.unregister).not.toHaveBeenCalled();
  });
});
