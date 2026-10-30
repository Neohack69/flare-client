import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('./status.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./desktop.css', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('./status.ts', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] ?? '';
}

describe('Status layout: версия в тайтлбаре', () => {
  it('версия стоит в titlebar__brand сразу после названия', () => {
    const brand = /<span class="titlebar__brand">([\s\S]*?)<\/span>\s*<span class="titlebar__controls">/.exec(
      html,
    )?.[1] ?? '';
    expect(brand).toMatch(/class="titlebar__name"[^>]*>\s*Flare\s*</);
    expect(brand).toMatch(/class="titlebar__version[^"]*"[^>]*id="app-version"/);
    expect(brand.indexOf('titlebar__name')).toBeLessThan(brand.indexOf('id="app-version"'));
  });

  it('в документе ровно один #app-version и его нет во футере', () => {
    expect(html.match(/id="app-version"/g)).toHaveLength(1);
    expect(html).not.toContain('swin__foot');
  });

  it('titlebar__version — mono, 11px, muted', () => {
    const rule = ruleBody('.titlebar__version');
    expect(rule).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(rule).toMatch(/font-size:\s*11px/);
    expect(rule).toMatch(/color:\s*var\(--text-muted\)/);
  });

  it('renderer обновляет версию в единственном элементе', () => {
    expect(renderer).toContain('`v${runtime.appVersion}`');
    expect(renderer.match(/setText\('app-version'/g)).toHaveLength(1);
  });
});

describe('DESKTOP-UPDATE-CARD: карточка обновления (§3.3)', () => {
  const card = /<section class="upd" id="update"([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';

  it('2-row: head (icon + text) → reason → CTA full-width', () => {
    expect(card).toMatch(/class="upd__head"/);
    expect(card.indexOf('id="update-icon"')).toBeLessThan(card.indexOf('id="update-text"'));
    expect(card.indexOf('id="update-text"')).toBeLessThan(card.indexOf('id="update-reason"'));
    expect(card.indexOf('id="update-reason"')).toBeLessThan(
      card.indexOf('id="button-install-update"'),
    );
    expect(card).toMatch(/class="dbtn dbtn--primary upd__cta"/);
    expect(card).toContain('aria-describedby="update-reason"');
  });

  it('каждая секция карточки — своя строка (не 3-колоночный grid)', () => {
    expect(ruleBody('.upd')).not.toMatch(/grid-template-columns/);
    expect(ruleBody('.upd__head')).toMatch(/grid-template-columns:\s*16px minmax\(0,\s*1fr\)/);
  });

  it('контейнер 388 (100%), padding 10, акцентная кромка 3px, radius 6', () => {
    const rule = ruleBody('.upd');
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/padding:\s*10px/);
    expect(rule).toMatch(/border-left:\s*3px solid var\(--upd-color\)/);
    expect(rule).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    expect(rule).toMatch(/margin-top:\s*var\(--space-3\)/);
    expect(rule).toMatch(/linear-gradient\(/);
  });

  it('CTA 44px, 13px, на всю ширину', () => {
    const rule = ruleBody('.upd__cta');
    expect(rule).toMatch(/height:\s*44px/);
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/font-size:\s*var\(--fs-body-sm\)/);
    expect(css).toMatch(/\.dbtn\[disabled\]\s*\{[^}]*opacity:\s*0\.45/);
  });

  it('reason зарезервирована (min-height 16) — ready ↔ deferred не меняют высоту', () => {
    const rule = ruleBody('.upd__reason');
    expect(rule).toMatch(/min-height:\s*16px/);
    expect(rule).toMatch(/font-size:\s*var\(--fs-overline\)/);
    expect(rule).toMatch(/color:\s*var\(--text-muted\)/);
  });

  it('шесть состояний через data-state (без inline-стилей)', () => {
    expect(renderer).toContain(
      "type UpdateCardState = 'checking' | 'available' | 'latest' | 'ready' | 'deferred' | 'error'",
    );
    expect(renderer).toContain("return recording ? 'deferred' : 'ready'");
    for (const state of ['checking', 'available', 'latest', 'error']) {
      expect(renderer).toContain(`return '${state}'`);
    }
    expect(css).toContain(".upd[data-state='latest'],");
    expect(css).toContain(".upd[data-state='error']");
    expect(renderer).toContain('card.dataset.state = state');
    expect(renderer).toContain('delete card.dataset.state');
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).toContain("style-src 'self'");
  });

  it('версия — отдельный mono-фрагмент (tabular-nums)', () => {
    expect(renderer).toContain("value.className = 'mono upd__ver'");
    expect(ruleBody('.upd__ver')).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('спиннер проверки и reduced-motion', () => {
    expect(css).toMatch(/\.upd\[data-state='checking'\] \.upd__icon svg,[^}]*dt-spin/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.upd\[data-state='checking'\] \.upd__icon svg\s*\{[^}]*animation:\s*none/,
    );
  });

  it('скролл — последний рубеж, без обрезки', () => {
    const rule = ruleBody('.status-page .swin');
    expect(rule).toMatch(/overflow-y:\s*auto/);
    expect(rule).toMatch(/overflow-x:\s*hidden/);
    expect(rule).toMatch(/overscroll-behavior:\s*contain/);
  });

  it('renderer: ResizeObserver + debounce + IPC fitStatusWindow', () => {
    expect(renderer).toContain('new ResizeObserver(scheduleFit)');
    expect(renderer).toContain('observer.observe(swin)');
    expect(renderer).toContain("byId('titlebar')");
    expect(renderer).toContain('bridge?.fitStatusWindow(height)');
    expect(renderer).toContain('STATUS_FIT_DEBOUNCE_MS');
    expect(renderer).toContain('STATUS_FIT_EPSILON_PX');
  });
});
