/**
 * T178 — детерминированное окно клипа касания (3–8 с, якорь t=0).
 * Без I/O, Date.now, Math.random.
 * Спека: docs/design/t178-touchdown-clip.md §1 + docs/architecture/t178-touchdown-clip.md §4.
 */

export const CLIP_WINDOW = {
  /** Не раньше −5.0 с от касания. */
  minStartS: -5,
  /** Авто-нарезка: max(flare, −4). */
  defaultStartCapS: -4,
  /** Fallback маркера flare, если фаза неизвестна (arch §4.3). */
  fallbackFlareStartS: -3,
  /** Не позже +5.0 с. */
  maxEndS: 5,
  /** Авто-нарезка: min(rollout, +4). */
  defaultEndCapS: 4,
  /** Fallback стабилизации пробега (arch §4.3). */
  fallbackStableRolloutS: 2.5,
  minDurationS: 3,
  maxDurationS: 8,
  /** Bounce в (0; +2.5] обязан войти в клип. */
  bounceHorizonS: 2.5,
  bounceHoldAfterS: 0.8,
  /** Оценка второго касания, если bounce есть, а timestamp нет. */
  defaultSecondTouchS: 1.2,
  /** Fallback short window только если трек вокруг 0 есть, но окно вырождено. */
  degenerateFallbackStartS: -2.5,
  degenerateFallbackEndS: 1.5,
} as const;

export type ClipWindowInput = {
  /** Относительно касания (обычно < 0). `null`/omit → fallbackFlareStartS. */
  flareStartS?: number | null;
  /** Относительно касания (обычно > 0). `null`/omit → fallbackStableRolloutS. */
  stableRolloutS?: number | null;
  /** Второе касание bounce (относительно t=0), если известно. */
  bounceSecondTouchS?: number | null;
  bounceCount?: number;
  bounced?: boolean;
  /**
   * Секунды контакта с землёй после TD (`landing.ground_contact_s`) —
   * мягкая граница пробега, когда stableRollout неизвестен.
   */
  groundContactS?: number | null;
  /** Есть ли scored landing; иначе клип не предлагать. */
  hasScoredLanding: boolean;
};

export type ClipWindow = {
  /** Секунды относительно касания (отрицательные — до TD). */
  tStartS: number;
  tEndS: number;
  durationS: number;
  hasBounce: boolean;
};

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Считает окно клипа. `null` — клип недоступен (нет данных касания).
 * Всегда включает t=0; длительность ∈ [3, 8].
 */
export function computeTouchdownClipWindow(input: ClipWindowInput): ClipWindow | null {
  if (!input.hasScoredLanding) return null;

  const C = CLIP_WINDOW;
  const bounced = input.bounced === true || (input.bounceCount ?? 0) > 0;

  const flareMarker = finiteOrNull(input.flareStartS) ?? C.fallbackFlareStartS;
  let tStart = Math.max(flareMarker, C.defaultStartCapS);
  tStart = Math.max(tStart, C.minStartS);

  const rolloutExplicit = finiteOrNull(input.stableRolloutS);
  const ground = finiteOrNull(input.groundContactS);
  const rolloutMarker = rolloutExplicit ?? ground ?? C.fallbackStableRolloutS;
  let tEnd = Math.min(rolloutMarker, C.defaultEndCapS);
  tEnd = Math.min(tEnd, C.maxEndS);

  let secondTouch = finiteOrNull(input.bounceSecondTouchS);
  if (bounced && secondTouch == null) {
    secondTouch = C.defaultSecondTouchS;
  }
  if (
    secondTouch != null &&
    secondTouch > 0 &&
    secondTouch <= C.bounceHorizonS
  ) {
    tEnd = Math.max(tEnd, Math.min(secondTouch + C.bounceHoldAfterS, C.maxEndS));
  }

  // Якорь t=0 всегда внутри окна.
  tStart = Math.min(tStart, -0.01);
  tEnd = Math.max(tEnd, 0.01);

  let duration = tEnd - tStart;

  if (duration < C.minDurationS) {
    const need = C.minDurationS - duration;
    tStart = Math.max(tStart - need / 2, C.minStartS);
    tEnd = Math.min(tEnd + need / 2, C.maxEndS);
    duration = tEnd - tStart;
    if (duration < C.minDurationS) {
      const still = C.minDurationS - duration;
      if (tStart - still >= C.minStartS) tStart -= still;
      else tEnd = Math.min(C.maxEndS, tEnd + still);
      duration = tEnd - tStart;
    }
  }

  if (duration > C.maxDurationS) {
    // Shrink favoring flare lead-in ≥1.5s and rollout ≥1.0s when possible.
    const preferStart = Math.min(-1.5, tEnd - C.maxDurationS);
    tStart = Math.max(tStart, preferStart);
    if (tEnd - tStart > C.maxDurationS) {
      tStart = tEnd - C.maxDurationS;
    }
    if (tStart >= 0) {
      tStart = -1.5;
      tEnd = Math.min(C.maxEndS, tStart + C.maxDurationS);
    }
    if (tEnd <= 0) {
      tEnd = 1.0;
      tStart = Math.max(C.minStartS, tEnd - C.maxDurationS);
    }
    duration = tEnd - tStart;
  }

  tStart = round2(tStart);
  tEnd = round2(tEnd);
  return {
    tStartS: tStart,
    tEndS: tEnd,
    durationS: round2(tEnd - tStart),
    hasBounce: bounced,
  };
}

/**
 * Free → watermark Flare; Pro / Lifetime / unlimited → clean.
 * Plan из БД (как waiting-room/duels), не из JWT.
 */
export function clipNeedsWatermark(planCode: string): boolean {
  return planCode !== 'pro' && planCode !== 'lifetime' && planCode !== 'unlimited';
}
