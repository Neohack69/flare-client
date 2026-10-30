import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { getDesktopMessages } from '@flightlog/i18n';
import type { AgentMePlan } from '@flightlog/contracts';

import {
  applyPlanChip,
  planChipView,
  planTrayPrefix,
  type PlanChipTargets,
  type PlanChipView,
} from '../shared/plan';

const statusHtml = readFileSync(new URL('./status.html', import.meta.url), 'utf8');
const aboutHtml = readFileSync(new URL('./about.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./desktop.css', import.meta.url), 'utf8');
const statusRenderer = readFileSync(new URL('./status.ts', import.meta.url), 'utf8');
const aboutRenderer = readFileSync(new URL('./about.ts', import.meta.url), 'utf8');

const pro: AgentMePlan = { code: 'pro', name: 'Pro' };
const lifetime: AgentMePlan = { code: 'lifetime', name: 'Lifetime' };
const free: AgentMePlan = { code: 'free', name: 'Free' };
const trial: AgentMePlan = {
  code: 'pro',
  name: 'Pro',
  trial: {
    active: true,
    ends_at: '2026-10-25T12:00:00.000Z',
    days_left: 3,
    ai_reports_remaining: 10,
  },
};

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] ?? '';
}

/** В CSS два блока `:root` (базовые токены + Pro-скин). */
const rootTokens = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((match) => match[1]).join('\n');

interface FakeElement {
  hidden: boolean;
  textContent: string;
  attributes: Record<string, string>;
  style: { values: Record<string, string>; setProperty(name: string, value: string): void };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function fakeElement(): FakeElement {
  const element: FakeElement = {
    hidden: false,
    textContent: '',
    attributes: {},
    style: {
      values: {},
      setProperty(name: string, value: string) {
        element.style.values[name] = value;
      },
    },
    setAttribute(name: string, value: string) {
      element.attributes[name] = value;
    },
    removeAttribute(name: string) {
      delete element.attributes[name];
    },
  };
  return element;
}

function targets(): {
  fake: Record<'chip' | 'text' | 'icon' | 'bar', FakeElement>;
  real: PlanChipTargets;
} {
  const fake = {
    chip: fakeElement(),
    text: fakeElement(),
    icon: fakeElement(),
    bar: fakeElement(),
  };
  return {
    fake,
    real: {
      chip: fake.chip as unknown as HTMLElement,
      text: fake.text as unknown as HTMLElement,
      icon: fake.icon as unknown as HTMLElement,
      bar: fake.bar as unknown as HTMLElement,
    },
  };
}

/** Доска бюджета ширины (см. §2.4): консервативная оценка 7px/символ при 11px. */
const CHAR_PX = 7;
const CHIP_CHROME_PX = 14;

function chipWidthPx(view: PlanChipView): number {
  const clock = view.showClock ? 16 : 0;
  return view.label.length * CHAR_PX + CHIP_CHROME_PX + clock;
}

describe('F2: план-чип (Pro / Trial / Free)', () => {
  it.each(['ru', 'en'] as const)('Pro: чип «Pro», aria из chipAria (%s)', (locale) => {
    const messages = getDesktopMessages(locale);
    const chip = planChipView(pro, messages);
    expect(chip).toMatchObject({
      visible: true,
      label: 'Pro',
      ariaLabel: messages.status.plan.chipAria.replace('{plan}', 'Pro'),
      trial: false,
      showClock: false,
    });
  });

  it.each(['ru', 'en'] as const)('Trial: дни + AI, полоса и Clock по правилам (%s)', (locale) => {
    const messages = getDesktopMessages(locale);
    const chip = planChipView(trial, messages);
    expect(chip.visible).toBe(true);
    expect(chip.trial).toBe(true);
    expect(chip.label).toBe(
      messages.status.plan.trial.replace('{days}', '3').replace('{reports}', '10'),
    );
    expect(chip.ariaLabel).toBe(
      messages.status.plan.trialAria.replace('{days}', '3').replace('{reports}', '10'),
    );
    expect(chip.trialRatio).toBe(1);
    expect(chip.showClock).toBe(false);

    const lastDay = planChipView({ ...trial, trial: { ...trial.trial!, days_left: 1 } }, messages);
    expect(lastDay.showClock).toBe(true);
    expect(lastDay.trialRatio).toBeCloseTo(1 / 3);
  });

  it.each(['ru', 'en'] as const)(
    'Lifetime: короткий чип в шапке, полный в About (%s)',
    (locale) => {
      const messages = getDesktopMessages(locale);
      expect(planChipView(lifetime, messages).label).toBe(messages.status.plan.lifetimeShort);
      expect(planChipView(lifetime, messages, { about: true }).label).toBe(
        messages.status.plan.lifetime,
      );
    },
  );

  it.each(['ru', 'en'] as const)('Free: чипа нет, в About текст «Бесплатно» (%s)', (locale) => {
    const messages = getDesktopMessages(locale);
    expect(planChipView(free, messages)).toMatchObject({
      visible: false,
      label: '',
      freeText: null,
    });
    expect(planChipView(free, messages, { about: true })).toMatchObject({
      visible: false,
      freeText: messages.status.plan.free,
    });
  });

  it('unknown/error: никакого «полускина» и скрытая строка About', () => {
    const messages = getDesktopMessages('ru');
    expect(planChipView(null, messages, { about: true })).toMatchObject({
      visible: false,
      freeText: null,
    });
  });

  it('трей: префикс Pro/Trial/Lifetime, Free без префикса', () => {
    const messages = getDesktopMessages('ru');
    expect(planTrayPrefix(pro, messages)).toBe('Pro');
    expect(planTrayPrefix(trial, messages)).toBe('Trial');
    expect(planTrayPrefix(lifetime, messages)).toBe('Lifetime');
    expect(planTrayPrefix(free, messages)).toBeNull();
    expect(planTrayPrefix(null, messages)).toBeNull();
  });

  it('applyPlanChip пишет текст/aria/hidden и --pro-trial (DOM-стаб)', () => {
    const messages = getDesktopMessages('ru');
    const { fake, real } = targets();
    applyPlanChip(planChipView(trial, messages), real);
    expect(fake.chip.hidden).toBe(false);
    expect(fake.chip.style.values['--pro-trial']).toBe('1');
    expect(fake.chip.attributes['aria-label']).toBe(
      messages.status.plan.trialAria.replace('{days}', '3').replace('{reports}', '10'),
    );
    expect(fake.text.textContent).toBe('Trial · 3 дн · 10 AI');
    expect(fake.icon.hidden).toBe(true);
    expect(fake.bar.hidden).toBe(false);

    const freeTargets = targets();
    applyPlanChip(planChipView(free, messages), freeTargets.real);
    expect(freeTargets.fake.chip.hidden).toBe(true);
    expect(freeTargets.fake.chip.attributes['aria-label']).toBeUndefined();
    expect(freeTargets.fake.bar.hidden).toBe(true);
  });

  it.each(['ru', 'en'] as const)('чип влезает в шапку на 420 и 480 без обрезки (%s)', (locale) => {
    const messages = getDesktopMessages(locale);
    const trialLabel = planChipView(trial, messages);
    const lastDay = planChipView({ ...trial, trial: { ...trial.trial!, days_left: 1 } }, messages);
    // Бюджет §2.4: brand (~68), langswitch (~64), gap 12 + 8, padding 32.
    for (const width of [420, 480]) {
      const available = width - 32 - 68 - 64 - 12 - 8;
      expect(chipWidthPx(trialLabel)).toBeLessThan(available);
      expect(chipWidthPx(lastDay)).toBeLessThan(available);
    }
    // About 480: kv label 112 + gap 12 + padding 40.
    const aboutAvailable = 480 - 40 - 112 - 12;
    expect(
      planChipView(lifetime, messages, { about: true }).label.length * CHAR_PX + CHIP_CHROME_PX,
    ).toBeLessThan(aboutAvailable);
  });
});

describe('F2: разметка и материал (без скриншота)', () => {
  it('chip живёт в .swin__head сразу за брендом; план-строки #planline нет', () => {
    const head = /<header class="swin__head">([\s\S]*?)<\/header>/.exec(statusHtml)?.[1] ?? '';
    expect(head).toContain('class="brandline"');
    expect(head).toContain('id="plan-chip"');
    expect(head.indexOf('brandline')).toBeLessThan(head.indexOf('id="plan-chip"'));
    expect(head.indexOf('id="plan-chip"')).toBeLessThan(head.indexOf('lang-switch'));
    expect(statusHtml).not.toContain('id="planline"');
    expect(statusHtml).not.toContain('class="planline"');
  });

  it('карточка статуса оборачивает чип и сетку, между ними 1 px шов', () => {
    const card =
      /<section class="statuscard"([\s\S]*?)<\/section>\s*<section class="flight"/.exec(
        statusHtml,
      )?.[1] ?? '';
    expect(card).toContain('id="chip"');
    expect(card).toContain('class="statuscard__seam"');
    expect(card).toContain('id="status-grid"');
    expect(card.indexOf('id="chip"')).toBeLessThan(card.indexOf('statuscard__seam'));
    expect(card.indexOf('statuscard__seam')).toBeLessThan(card.indexOf('id="status-grid"'));
  });

  it('About: план в dd — чип + Free-текст, не сырой текст', () => {
    const dd = /<dd id="plan-name"([\s\S]*?)<\/dd>/.exec(aboutHtml)?.[1] ?? '';
    expect(dd).toContain('id="plan-chip"');
    expect(dd).toContain('id="plan-free"');
    expect(dd).not.toContain('>-<');
  });

  it('2 px порт: ровно на карточке статуса и на ряде логотипа About', () => {
    expect(rootTokens).toContain('--pro-port-w: 2px');
    const cardPort = ruleBody("[data-plan='pro'] .statuscard::before");
    expect(cardPort).toContain('height: var(--pro-port-w)');
    expect(cardPort).toContain('var(--pro-gold-line)');
    expect(cardPort).toContain('animation: port-in');
    const aboutPort = ruleBody("[data-plan='pro'] .about__logo::after");
    expect(aboutPort).toContain('height: var(--pro-port-w)');
    expect(aboutPort).toContain('var(--pro-gold-line)');
    // Посадка спорит с главным портом только 1 px.
    expect(ruleBody("[data-plan='pro'] .landing")).toContain('border-top-color');
    expect(ruleBody("[data-plan='pro'] .landing")).not.toContain('--pro-port-w');
  });

  it('hairline/ring/швы: статус, тики, actions, primary ring', () => {
    expect(ruleBody("[data-plan='pro'] .statuscard")).toContain('var(--pro-gold-hair)');
    expect(ruleBody("[data-plan='pro'] .statuscard__seam")).toContain('var(--pro-gold-hair)');
    expect(ruleBody("[data-plan='pro'] .landing__head::before")).toContain('width: 12px');
    expect(ruleBody("[data-plan='pro'] .syncrow__line::before")).toContain('width: 24px');
    expect(ruleBody("[data-plan='pro'] .swin__actions::before")).toContain('var(--pro-gold-hair)');
    const ring = ruleBody("[data-plan='pro'] .dbtn--pro-key");
    expect(ring).toContain('inset 0 0 0 var(--pro-ring-w)');
    expect(ring).toContain('var(--pro-gold-hair)');
  });

  it('план-чип: 20 px, 11/14, tabular, gold-soft/text/hair', () => {
    const chip = ruleBody('.planchip');
    expect(chip).toContain('height: var(--pro-chip-h)');
    expect(rootTokens).toContain('--pro-chip-h: 20px');
    expect(chip).toContain('font-size: 11px');
    expect(chip).toContain('font-variant-numeric: tabular-nums');
    expect(chip).toContain('background: var(--pro-gold-soft)');
    expect(chip).toContain('color: var(--pro-gold-text)');
    expect(chip).toContain('border: var(--pro-hair-w) solid var(--pro-gold-hair)');
    const bar = ruleBody('.planchip__bar');
    expect(bar).toContain('width: max(4px, calc(var(--pro-trial, 0) * 100%))');
    expect(bar).toContain('height: var(--pro-hair-w)');
  });

  it('рендерер: plan-чип вместо #planline, data-plan без «полускина»', () => {
    expect(statusRenderer).toContain('applyPlanChip(');
    expect(statusRenderer).toContain("byId('plan-chip')");
    expect(statusRenderer).not.toContain('planline');
    expect(aboutRenderer).toContain('applyPlanChip(');
    expect(aboutRenderer).toContain('{ about: true }');
    expect(aboutRenderer).not.toContain('planline');
  });

  it('золота нет на заголовках/числах: старые gold-правила удалены', () => {
    expect(css).not.toContain("[data-plan='pro'] .planline");
    expect(css).not.toContain("[data-plan='pro'] #plan-name");
    expect(css).not.toContain("[data-plan='pro'] .swin__head");
  });

  it('reduced motion гасит sheen и делает порт статичным', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g;
    const blocks = [...css.matchAll(reduced)].map((match) => match[1]).join('\n');
    expect(blocks).toContain('titlebar--sheen');
    expect(blocks).toContain('animation: none');
    expect(blocks).toContain('opacity: 1');
  });
});
