import type { AgentMePlan } from '@flightlog/contracts';
import type { DesktopMessages } from '@flightlog/i18n';

import { interpolate } from './i18n.js';

/**
 * iter77: premium-скин клиента. Скин включается только по известному плану:
 * free/неизвестный/ошибка → базовый вид (никакого «полускина»).
 */
export type PlanLineKey = 'pro' | 'lifetime' | 'trial';

/** F2: длина trial-«взлётной полосы» в чипе считается от 3 дней продукта. */
export const TRIAL_DAYS = 3;

export interface PlanView {
  skin: 'pro' | null;
  line: PlanLineKey | null;
  days: number;
  reports: number;
  /** F2: 0..1 для `--pro-trial` (CSS растянет на ширину чипа, минимум 4px). */
  trialRatio: number;
  /** F2: Clock 12px только при `days <= 1`. */
  showTrialClock: boolean;
}

export function planView(plan: AgentMePlan | null | undefined): PlanView {
  if (!plan || plan.code === 'free') {
    return { skin: null, line: null, days: 0, reports: 0, trialRatio: 0, showTrialClock: false };
  }
  if (plan.trial) {
    const days = plan.trial.days_left;
    return {
      skin: 'pro',
      line: 'trial',
      days,
      reports: plan.trial.ai_reports_remaining,
      trialRatio: Math.min(1, Math.max(0, days / TRIAL_DAYS)),
      showTrialClock: days <= 1,
    };
  }
  return {
    skin: 'pro',
    line: plan.code === 'lifetime' ? 'lifetime' : 'pro',
    days: 0,
    reports: 0,
    trialRatio: 0,
    showTrialClock: false,
  };
}

export interface PlanChipView {
  visible: boolean;
  label: string;
  ariaLabel: string;
  trial: boolean;
  trialRatio: number;
  showClock: boolean;
  /** F2: About показывает «Бесплатно» текстом (в шапке status чипа нет). */
  freeText: string | null;
}

/**
 * F2: план-чип в шапке status и в строке «План» About. `{plan}` для aria —
 * видимая метка, поэтому About получает полное `Lifetime · навсегда`.
 */
export function planChipView(
  plan: AgentMePlan | null | undefined,
  messages: DesktopMessages,
  options: { about?: boolean } = {},
): PlanChipView {
  const view = planView(plan);
  if (!view.skin || view.line === null) {
    return {
      visible: false,
      label: '',
      ariaLabel: '',
      trial: false,
      trialRatio: 0,
      showClock: false,
      freeText: options.about && plan?.code === 'free' ? messages.status.plan.free : null,
    };
  }
  const trial = view.line === 'trial';
  const label = trial
    ? interpolate(messages.status.plan.trial, {
        days: String(view.days),
        reports: String(view.reports),
      })
    : view.line === 'lifetime'
      ? options.about
        ? messages.status.plan.lifetime
        : messages.status.plan.lifetimeShort
      : messages.status.plan.pro;
  return {
    visible: true,
    label,
    ariaLabel: trial
      ? interpolate(messages.status.plan.trialAria, {
          days: String(view.days),
          reports: String(view.reports),
        })
      : interpolate(messages.status.plan.chipAria, { plan: label }),
    trial,
    trialRatio: view.trialRatio,
    showClock: view.showTrialClock,
    freeText: null,
  };
}

/** F2: префикс disabled-строки меню трея; Free/unknown — без префикса. */
export function planTrayPrefix(
  plan: AgentMePlan | null | undefined,
  messages: DesktopMessages,
): string | null {
  const view = planView(plan);
  if (view.line === 'trial') return messages.status.plan.trialShort;
  if (view.line === 'lifetime') return messages.status.plan.lifetimeShort;
  if (view.line === 'pro') return messages.status.plan.pro;
  return null;
}

export interface PlanChipTargets {
  chip: HTMLElement | null;
  text: HTMLElement | null;
  icon: HTMLElement | null;
  bar: HTMLElement | null;
}

/** F2: единая запись чипа (текст, aria, hidden, `--pro-trial`) для обоих окон. */
export function applyPlanChip(view: PlanChipView, targets: PlanChipTargets): void {
  const { chip, text, icon, bar } = targets;
  if (chip) {
    chip.hidden = !view.visible;
    if (view.visible) {
      chip.style.setProperty('--pro-trial', String(view.trialRatio));
      chip.setAttribute('aria-label', view.ariaLabel);
    } else {
      chip.removeAttribute('aria-label');
    }
  }
  if (text) text.textContent = view.label;
  if (icon) icon.hidden = !(view.visible && view.showClock);
  if (bar) bar.hidden = !(view.visible && view.trial);
}
