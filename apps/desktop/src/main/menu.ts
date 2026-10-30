import { Menu } from 'electron';

/**
 * T-CLIENT3: у клиента нет строки меню приложения. `Menu.setApplicationMenu(null)`
 * убирает её из всех окон (Windows), поэтому `Alt` больше ничего не открывает.
 * Контекстное меню правого клика (редактирование) настраивается отдельно —
 * `edit-context-menu.ts`, строку меню оно не возвращает.
 */
export function removeApplicationMenu(): void {
  Menu.setApplicationMenu(null);
}
