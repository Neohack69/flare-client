import { normalize } from 'node:path';

import type { IpcMainInvokeEvent, Session, WebContents } from 'electron';
import { shell } from 'electron';

export interface SecurityContext {
  /**
   * Origin сайта — только для внешних ссылок («Открыть сайт», F-107).
   * T-CLIENT2: сайт в окне клиента не загружается, renderer — локальные страницы.
   */
  webOrigin: string;
  /** Разрешённые локальные страницы клиента (status.html, about.html). */
  localFiles: string[];
  /** Дополнительные разрешённые origins (dev: vite renderer-сервер). */
  extraOrigins?: string[];
  isDev: boolean;
}

/** Все локальные страницы, которым разрешён IPC/navigation. */
export function localFilesOf(context: SecurityContext): string[] {
  return context.localFiles;
}

function samePath(a: string, b: string): boolean {
  const left = normalize(a).replace(/\\/g, '/').toLowerCase();
  const right = normalize(b).replace(/\\/g, '/').toLowerCase();
  return left === right;
}

/** Является ли URL разрешённым (локальная страница клиента или dev-origin). */
export function isAllowedUrl(context: SecurityContext, rawUrl: string): boolean {
  if (!rawUrl) return false;
  if (rawUrl.startsWith('file:')) {
    try {
      const url = new URL(rawUrl);
      const decoded = decodeURIComponent(url.pathname).replace(/^\//, '');
      return localFilesOf(context).some((file) => samePath(decoded, file));
    } catch {
      return false;
    }
  }
  try {
    const origin = new URL(rawUrl).origin;
    return (context.extraOrigins ?? []).includes(origin);
  } catch {
    return false;
  }
}

export function validateSender(
  context: SecurityContext,
  event: Pick<IpcMainInvokeEvent, 'senderFrame'> & { sender: WebContents },
): boolean {
  const frameUrl = event.senderFrame?.url ?? event.sender.getURL();
  return isAllowedUrl(context, frameUrl);
}

/** Deny-by-default для permissions (камера/микрофон/геолокация не нужны). */
export function applySessionSecurity(session: Session): void {
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}

/** Навигация/окна: только локальные страницы; внешнее — в системный браузер. */
export function applyWebContentsSecurity(contents: WebContents, context: SecurityContext): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(context, url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isAllowedUrl(context, url)) return;
    event.preventDefault();
    openExternalIfSafe(context, url);
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

/** Внешние ссылки — в системный браузер; http разрешён только в dev. */
export function openExternalIfSafe(context: SecurityContext, rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const allowedProtocol = url.protocol === 'https:' || (context.isDev && url.protocol === 'http:');
  if (!allowedProtocol) return false;
  void shell.openExternal(url.toString());
  return true;
}

/**
 * Открывает URL во внешнем браузере только если он принадлежит origin сайта
 * (F-107). Origin-проверка живёт рядом с `shell.openExternal`, а не в
 * вызывающем коде. Для произвольных внешних ссылок остаётся `openExternalIfSafe`.
 */
export function openSameOriginExternal(context: SecurityContext, rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.origin !== context.webOrigin) return false;
  return openExternalIfSafe(context, rawUrl);
}
