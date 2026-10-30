import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

import { shell } from 'electron';

import { isAllowedUrl, openSameOriginExternal, type SecurityContext } from './security';

const context: SecurityContext = {
  webOrigin: 'https://app.flightlog.app',
  localFiles: ['H:/app/out/renderer/status.html'],
  isDev: false,
};

describe('security — navigation allowlist (ADR-0011 §7)', () => {
  it('разрешает только локальные страницы клиента', () => {
    expect(isAllowedUrl(context, 'file:///H:/app/out/renderer/status.html')).toBe(true);
    expect(isAllowedUrl(context, 'file:///C:/Windows/System32/calc.exe')).toBe(false);
    // Сайт в окне клиента больше не грузится: его origin — только для внешних ссылок.
    expect(isAllowedUrl(context, 'https://app.flightlog.app/dashboard')).toBe(false);
  });

  it('запрещает чужие origin и небезопасные схемы', () => {
    expect(isAllowedUrl(context, 'https://evil.example/')).toBe(false);
    expect(isAllowedUrl(context, 'javascript:alert(1)')).toBe(false);
    expect(isAllowedUrl(context, '')).toBe(false);
  });

  it('dev: разрешает дополнительный vite-origin', () => {
    const devContext: SecurityContext = {
      ...context,
      isDev: true,
      extraOrigins: ['http://localhost:5173'],
    };
    expect(isAllowedUrl(devContext, 'http://localhost:5173/status.html')).toBe(true);
  });
});

describe('openSameOriginExternal (F-107)', () => {
  beforeEach(() => {
    vi.mocked(shell.openExternal).mockClear();
  });

  it('открывает URL только origin сайта', () => {
    expect(openSameOriginExternal(context, 'https://app.flightlog.app/ru/device')).toBe(true);
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
  });

  it('чужой origin не открывается', () => {
    expect(openSameOriginExternal(context, 'https://evil.example/device')).toBe(false);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('небезопасные схемы/невалидный URL отвергаются', () => {
    expect(openSameOriginExternal(context, 'javascript:alert(1)')).toBe(false);
    expect(openSameOriginExternal(context, 'file:///C:/Windows/System32/calc.exe')).toBe(false);
    expect(openSameOriginExternal(context, 'not-a-url')).toBe(false);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});
