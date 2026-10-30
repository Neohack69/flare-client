import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('./about.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./desktop.css', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('./about.ts', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] ?? '';
}

describe('About layout: версия в тайтлбаре', () => {
  it('версия стоит в titlebar__brand сразу после названия', () => {
    const brand = /<span class="titlebar__brand">([\s\S]*?)<\/span>\s*<span class="titlebar__controls">/.exec(
      html,
    )?.[1] ?? '';
    expect(brand).toMatch(/class="titlebar__name"[^>]*>\s*Flare\s*</);
    expect(brand).toMatch(/class="titlebar__version[^"]*"[^>]*id="app-version"/);
    expect(brand.indexOf('titlebar__name')).toBeLessThan(brand.indexOf('id="app-version"'));
  });

  it('в блоке логотипа версии больше нет', () => {
    const header = /<header class="about__logo">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? '';
    expect(header).toMatch(/id="brand"/);
    expect(header).toMatch(/class="t-h3"[^>]*>\s*Flare\s*</);
    expect(header).not.toContain('app-version');
  });

  it('titlebar__version — mono, 11px, muted', () => {
    const rule = ruleBody('.titlebar__version');
    expect(rule).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(rule).toMatch(/font-size:\s*11px/);
    expect(rule).toMatch(/color:\s*var\(--text-muted\)/);
  });

  it('renderer показывает короткую версию и не дублирует её', () => {
    expect(renderer).toContain('`v${info.appVersion}`');
    expect(renderer.match(/setText\('app-version'/g)).toHaveLength(1);
  });

  it('auto-height: контент не растягивается, scroll остаётся fallback', () => {
    const bodyRule = ruleBody('body.about-page');
    expect(bodyRule).toMatch(/height:\s*auto/);
    const aboutRule = ruleBody('.about');
    expect(aboutRule).toMatch(/flex:\s*0 0 auto/);
    expect(aboutRule).toMatch(/max-height:\s*calc\(100vh - 36px\)/);
    expect(aboutRule).toMatch(/overflow:\s*auto/);
  });

  it('renderer перезамеряет контент через ResizeObserver и шлёт высоту в main', () => {
    expect(renderer).toMatch(/new ResizeObserver\(scheduleFit\)\.observe\(aboutContent\)/);
    expect(renderer).toContain('bridge.fitAboutWindow(height)');
    expect(renderer).toMatch(/\},\s*120\)/);
  });
});
