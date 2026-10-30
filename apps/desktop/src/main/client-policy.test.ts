import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * T-CLIENT2 (тест-запрет): клиент — маленькое окно привязки + трей. Сайт
 * (дашборды, реплей, страницы привязки) НЕ загружается внутрь окна; он живёт
 * только во внешнем браузере (`shell.openExternal`). Здесь сканируем исходники
 * клиента и падаем, если появится загрузка удалённого сайта или встроенный
 * браузерный вьювер.
 */

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.ts$/.test(entry) || entry.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

const files = sourceFiles(srcRoot);

describe('T-CLIENT2: в клиенте нет встроенного сайта', () => {
  it('нет BrowserView / WebContentsView (никаких встраиваемых страниц)', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, relative(srcRoot, file)).not.toMatch(/\bBrowserView\b/);
      expect(text, relative(srcRoot, file)).not.toMatch(/\bWebContentsView\b/);
    }
  });

  it('loadURL/loadFile не грузят удалённый сайт (webUrl/tdmoment/flightlog.app)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/load(?:URL|File)\(([^\n)]*)\)/g)) {
        const arg = match[1] ?? '';
        if (/webUrl|tdmoment|flightlog\.app|https?:\/\//i.test(arg)) {
          offenders.push(`${relative(srcRoot, file)}: loadURL(${arg.trim()})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('main-процесс не создаёт окно, загружающее сайт (WindowController удалён)', () => {
    const index = readFileSync(join(srcRoot, 'main', 'index.ts'), 'utf8');
    expect(index).not.toMatch(/\bWindowController\b/);
    expect(index).not.toMatch(/loadURL\(/);
    // «Открыть сайт» — только во внешнем браузере.
    expect(index).toContain('openSameOriginExternal');
  });

  it('renderer не содержит встроенных ссылок на дашборды сайта', () => {
    const status = readFileSync(join(srcRoot, 'renderer', 'status.html'), 'utf8');
    expect(status).not.toMatch(/loadURL|tdmoment\.ru|flightlog\.app/);
  });
});
