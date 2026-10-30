import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({
  template: [] as Array<Record<string, unknown>>,
  popup: vi.fn(),
}));

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: Array<Record<string, unknown>>) => {
      electronState.template = template;
      return { popup: electronState.popup };
    },
  },
  BrowserWindow: { fromWebContents: () => null },
}));

import { attachEditContextMenu } from './edit-context-menu';

function makeWebContents() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on(event: string, listener: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

function contextParams(overrides: Record<string, unknown> = {}) {
  return {
    isEditable: true,
    selectionText: '',
    editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
    ...overrides,
  };
}

beforeEach(() => {
  electronState.template = [];
  electronState.popup.mockClear();
  (globalThis as { __flightlogContextMenuShown?: number }).__flightlogContextMenuShown = 0;
});

describe('T-CLIENT3: контекстное меню редактирования', () => {
  it('для редактируемого поля предлагает вырезать/копировать/вставить/выделить всё', () => {
    const webContents = makeWebContents();
    attachEditContextMenu(webContents as never, () => 'ru');
    webContents.emit('context-menu', {}, contextParams());

    const roles = electronState.template.map((item) => item.role ?? item.type);
    expect(roles).toEqual(['cut', 'copy', 'paste', 'separator', 'selectAll']);
    expect(electronState.template[0]?.label).toBe('Вырезать');
    expect(electronState.template[2]?.label).toBe('Вставить');
    expect(electronState.popup).toHaveBeenCalledTimes(1);
    expect((globalThis as { __flightlogContextMenuShown?: number }).__flightlogContextMenuShown).toBe(1);
  });

  it('локализует пункты по текущему языку', () => {
    const webContents = makeWebContents();
    attachEditContextMenu(webContents as never, () => 'en');
    webContents.emit('context-menu', {}, contextParams());
    expect(electronState.template[1]?.label).toBe('Copy');
    expect(electronState.template[4]?.label).toBe('Select all');
  });

  it('вне редактируемого поля и без выделения меню не показывается', () => {
    const webContents = makeWebContents();
    attachEditContextMenu(webContents as never, () => 'ru');
    webContents.emit('context-menu', {}, contextParams({ isEditable: false }));
    expect(electronState.popup).not.toHaveBeenCalled();
    expect((globalThis as { __flightlogContextMenuShown?: number }).__flightlogContextMenuShown).toBe(0);
  });

  it('для выделенного нередактируемого текста доступно «Копировать»', () => {
    const webContents = makeWebContents();
    attachEditContextMenu(webContents as never, () => 'ru');
    webContents.emit(
      'context-menu',
      {},
      contextParams({ isEditable: false, selectionText: 'WXYZ-1234' }),
    );
    expect(electronState.template).toHaveLength(1);
    expect(electronState.template[0]?.role).toBe('copy');
    expect(electronState.popup).toHaveBeenCalledTimes(1);
  });
});
