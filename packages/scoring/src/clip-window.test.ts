import { describe, expect, it } from 'vitest';

import {
  CLIP_WINDOW,
  clipNeedsWatermark,
  computeTouchdownClipWindow,
} from './clip-window.js';

describe('computeTouchdownClipWindow', () => {
  it('возвращает null без scored landing', () => {
    expect(computeTouchdownClipWindow({ hasScoredLanding: false })).toBeNull();
  });

  it('дефолт без фаз: −3…+2.5 → 5.5 с (arch fallbacks), включает t=0', () => {
    const w = computeTouchdownClipWindow({ hasScoredLanding: true });
    expect(w).toEqual({
      tStartS: CLIP_WINDOW.fallbackFlareStartS,
      tEndS: CLIP_WINDOW.fallbackStableRolloutS,
      durationS: 5.5,
      hasBounce: false,
    });
  });

  it('ранний flare: start = max(flare, −4) → −4', () => {
    const w = computeTouchdownClipWindow({
      hasScoredLanding: true,
      flareStartS: -9,
      stableRolloutS: 3,
    });
    expect(w).not.toBeNull();
    expect(w!.tStartS).toBe(CLIP_WINDOW.defaultStartCapS);
    expect(w!.tEndS).toBe(3);
    expect(w!.durationS).toBe(7);
    expect(w!.hasBounce).toBe(false);
  });

  it('короткий пробег расширяется до min 3 с', () => {
    const w = computeTouchdownClipWindow({
      hasScoredLanding: true,
      flareStartS: -1,
      stableRolloutS: 0.5,
    });
    expect(w).not.toBeNull();
    expect(w!.durationS).toBeGreaterThanOrEqual(CLIP_WINDOW.minDurationS);
    expect(w!.tStartS).toBeLessThan(0);
    expect(w!.tEndS).toBeGreaterThan(0);
  });

  it('bounce включает второе касание + hold', () => {
    const w = computeTouchdownClipWindow({
      hasScoredLanding: true,
      flareStartS: -3,
      stableRolloutS: 1,
      bounceCount: 1,
      bounceSecondTouchS: 1.5,
    });
    expect(w).not.toBeNull();
    expect(w!.hasBounce).toBe(true);
    expect(w!.tEndS).toBeGreaterThanOrEqual(1.5 + CLIP_WINDOW.bounceHoldAfterS);
  });

  it('bounce без timestamp использует defaultSecondTouch', () => {
    const w = computeTouchdownClipWindow({
      hasScoredLanding: true,
      bounced: true,
      flareStartS: -3,
      stableRolloutS: 1,
    });
    expect(w).not.toBeNull();
    expect(w!.hasBounce).toBe(true);
    expect(w!.tEndS).toBeGreaterThanOrEqual(
      CLIP_WINDOW.defaultSecondTouchS + CLIP_WINDOW.bounceHoldAfterS,
    );
  });

  it('ground_contact_s ограничивает конец, если rollout неизвестен', () => {
    const w = computeTouchdownClipWindow({
      hasScoredLanding: true,
      flareStartS: -3,
      groundContactS: 2,
    });
    expect(w).toEqual({ tStartS: -3, tEndS: 2, durationS: 5, hasBounce: false });
  });

  it('длительность никогда не выходит за [3, 8]', () => {
    const cases = [
      { hasScoredLanding: true as const, flareStartS: -5, stableRolloutS: 5, bounceCount: 2 },
      { hasScoredLanding: true as const, flareStartS: -0.2, stableRolloutS: 0.2 },
      { hasScoredLanding: true as const, bounceCount: 1 },
    ];
    for (const input of cases) {
      const w = computeTouchdownClipWindow(input);
      expect(w).not.toBeNull();
      expect(w!.durationS).toBeGreaterThanOrEqual(CLIP_WINDOW.minDurationS);
      expect(w!.durationS).toBeLessThanOrEqual(CLIP_WINDOW.maxDurationS);
      expect(w!.tStartS).toBeLessThan(0);
      expect(w!.tEndS).toBeGreaterThan(0);
    }
  });

  it('детерминирован: одинаковый вход → одинаковый выход', () => {
    const input = {
      hasScoredLanding: true as const,
      bounceCount: 1,
      groundContactS: 2.4,
      flareStartS: -3.2,
    };
    expect(computeTouchdownClipWindow(input)).toEqual(computeTouchdownClipWindow(input));
  });
});

describe('clipNeedsWatermark', () => {
  it('Free — watermark', () => {
    expect(clipNeedsWatermark('free')).toBe(true);
    expect(clipNeedsWatermark('unknown')).toBe(true);
  });

  it('Pro / Lifetime / unlimited — clean', () => {
    expect(clipNeedsWatermark('pro')).toBe(false);
    expect(clipNeedsWatermark('lifetime')).toBe(false);
    expect(clipNeedsWatermark('unlimited')).toBe(false);
  });
});
