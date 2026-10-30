import type { HotkeyPreferences } from './config.js';

/** Минимальный контракт Electron `globalShortcut` — для тестов без Electron. */
export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface HotkeyRegistration {
  /** Настроенный акселератор (даже если регистрация не удалась), иначе `null`. */
  accelerator: string | null;
  registered: boolean;
}

export type HotkeyWarn = (message: string, meta?: Record<string, unknown>) => void;

/**
 * T118: регистрирует глобальный hotkey окна «Состояние агента».
 * Конфликт/ошибка регистрации — тихая деградация: приложение продолжает
 * работать, в лог уходит `warn`; hotkey можно отключить в `settings.json`
 * (`hotkey.enabled = false`).
 */
export function registerStatusHotkey(
  shortcut: GlobalShortcutLike,
  prefs: HotkeyPreferences,
  onTrigger: () => void,
  warn?: HotkeyWarn,
): HotkeyRegistration {
  const accelerator = prefs.accelerator?.trim();
  if (!prefs.enabled || !accelerator) {
    return { accelerator: null, registered: false };
  }
  try {
    if (shortcut.register(accelerator, onTrigger)) {
      return { accelerator, registered: true };
    }
    warn?.('status hotkey is already taken; continuing without it', { accelerator });
    return { accelerator, registered: false };
  } catch (error) {
    warn?.('failed to register status hotkey', {
      accelerator,
      error: error instanceof Error ? error.message : String(error),
    });
    return { accelerator, registered: false };
  }
}

/** Снимает hotkey при выходе (идемпотентно). */
export function unregisterStatusHotkey(
  shortcut: GlobalShortcutLike,
  registration: HotkeyRegistration | null,
): void {
  if (!registration?.registered || !registration.accelerator) return;
  try {
    shortcut.unregister(registration.accelerator);
  } catch {
    // Выход: молча игнорируем — приложение уже завершается.
  }
}
