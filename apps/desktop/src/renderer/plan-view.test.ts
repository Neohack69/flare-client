import { describe, expect, it } from 'vitest';

import type { AgentMePlan } from '@flightlog/contracts';

import { planView } from '../shared/plan';

const trialPlan: AgentMePlan = {
  code: 'pro',
  name: 'Pro',
  trial: {
    active: true,
    ends_at: '2026-10-20T12:00:00.000Z',
    days_left: 3,
    ai_reports_remaining: 2,
  },
};

describe('desktop plan view (iter77)', () => {
  it.each(['pro', 'lifetime', 'unlimited'] as const)('%s → data-plan', (code) => {
    expect(planView({ code, name: 'Pro' }).skin).toBe('pro');
  });

  it('free/unknown → базовый скин без план-строки', () => {
    expect(planView({ code: 'free', name: 'Free' })).toEqual({
      skin: null,
      line: null,
      days: 0,
      reports: 0,
      trialRatio: 0,
      showTrialClock: false,
    });
    expect(planView(null).skin).toBeNull();
  });

  it('lifetime → plan line lifetime', () => {
    expect(planView({ code: 'lifetime', name: 'Lifetime' }).line).toBe('lifetime');
  });

  it('trial → план-строка с днями и остатком AI', () => {
    expect(planView(trialPlan)).toEqual({
      skin: 'pro',
      line: 'trial',
      days: 3,
      reports: 2,
      trialRatio: 1,
      showTrialClock: false,
    });
  });

  it('F2: trial-полоса = days/3 (clamp 0..1), Clock только при days <= 1', () => {
    expect(
      planView({ ...trialPlan, trial: { ...trialPlan.trial!, days_left: 1 } }).trialRatio,
    ).toBe(1 / 3);
    expect(
      planView({ ...trialPlan, trial: { ...trialPlan.trial!, days_left: 1 } }).showTrialClock,
    ).toBe(true);
    expect(
      planView({ ...trialPlan, trial: { ...trialPlan.trial!, days_left: 0 } }).trialRatio,
    ).toBe(0);
    expect(
      planView({ ...trialPlan, trial: { ...trialPlan.trial!, days_left: 0 } }).showTrialClock,
    ).toBe(true);
    expect(
      planView({ ...trialPlan, trial: { ...trialPlan.trial!, days_left: 9 } }).trialRatio,
    ).toBe(1);
  });
});
