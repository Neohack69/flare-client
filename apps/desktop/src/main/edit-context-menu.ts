import type { DesktopLocale } from '@flightlog/contracts';
import {
  BrowserWindow,
  Menu,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';

import { getDesktopMessages } from '../shared/i18n.js';

type ContextMenuDiagnostics = {
  /** Dev/smoke-хук: сколько раз показано контекстное меню (T-CLIENT3). */
  __flightlogContextMenuShown?: number;
};

/**
 * T-CLIENT3: минимальное контекстное меню для редактирования текста
 * (Вырезать/Копировать/Вставить/Выделить всё). Нужно, потому что строка меню
 * приложения отключена (`menu.ts`). Строку меню это НЕ возвращает: меню
 * показывается только по правому клику (или для выделенного текста).
 */
export function attachEditContextMenu(
  webContents: WebContents,
  locale: () => DesktopLocale,
): void {
  webContents.on('context-menu', (_event, rawParams) => {
    const params = rawParams as ContextMenuParams;
    const hasSelection = params.selectionText.trim().length > 0;
    if (!params.isEditable && !hasSelection) return;

    const labels = getDesktopMessages(locale()).editMenu;
    const template: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      template.push(
        { role: 'cut', label: labels.cut, enabled: params.editFlags.canCut },
        {
          role: 'copy',
          label: labels.copy,
          enabled: params.editFlags.canCopy || hasSelection,
        },
        { role: 'paste', label: labels.paste, enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: labels.selectAll, enabled: params.editFlags.canSelectAll },
      );
    } else {
      template.push({ role: 'copy', label: labels.copy, enabled: hasSelection });
    }

    const diagnostics = globalThis as ContextMenuDiagnostics;
    diagnostics.__flightlogContextMenuShown =
      (diagnostics.__flightlogContextMenuShown ?? 0) + 1;

    const window = BrowserWindow.fromWebContents(webContents);
    Menu.buildFromTemplate(template).popup({ window: window ?? undefined });
  });
}
