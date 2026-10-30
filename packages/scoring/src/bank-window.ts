/**
 * A2 (data honesty): bank deviations over the final descent window.
 *
 * The window is the final descent from the last downward crossing of 1000 ft AGL
 * to the last downward crossing of 500 ft AGL (airborne samples only). An
 * excursion is an episode where |bank| enters above 10° and exits at or below 8°
 * (hysteresis), lasting at least 1 s. This replaces the old per-sample frame
 * count, which measured departure + approach at 10 Hz and produced meaningless
 * values (e.g. 316 for a single approach).
 *
 * Pure and deterministic: no I/O, `Date.now` or `Math.random`.
 */

export const BANK_WINDOW = {
  startAglFt: 1000,
  endAglFt: 500,
  enterDeg: 10,
  exitDeg: 8,
  minDurationS: 1,
} as const;

export interface BankWindowSample {
  ts: string;
  agl_ft?: number | null;
  bank_deg?: number | null;
  on_ground?: boolean;
}

export interface BankWindowStats {
  episodes: number;
  maxAbsDeg: number;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function epochMs(ts: string): number | null {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * `null` — нет финального окна 1000→500 ft AGL (нет пересечений, нет высоты,
 * либо после последнего пересечения 500 ft снова был набор выше 1000 ft).
 * `maxAbsDeg` — максимум |bank| в окне; если в окне нет ни одного измерения
 * крена, вернуть `null` (измерения нет — не подставляем 0).
 */
export function bankWindowStats(
  samples: readonly BankWindowSample[],
): BankWindowStats | null {
  const sorted = samples
    .slice()
    .sort((a, b) => (epochMs(a.ts) ?? Number.POSITIVE_INFINITY) - (epochMs(b.ts) ?? Number.POSITIVE_INFINITY));

  let prevAgl: number | null = null;
  let startIndex = -1;
  let endIndex = -1;
  for (let index = 0; index < sorted.length; index += 1) {
    const agl = finite(sorted[index]?.agl_ft);
    if (agl === null) continue;
    if (prevAgl !== null) {
      if (prevAgl > BANK_WINDOW.startAglFt && agl <= BANK_WINDOW.startAglFt) {
        startIndex = index;
      }
      if (prevAgl > BANK_WINDOW.endAglFt && agl <= BANK_WINDOW.endAglFt) {
        endIndex = index;
      }
    }
    prevAgl = agl;
  }
  if (startIndex < 0 || endIndex < 0 || startIndex >= endIndex) return null;

  let maxAbsDeg: number | null = null;
  let episodes = 0;
  let episodeStartMs: number | null = null;
  let lastBankMs: number | null = null;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const sample = sorted[index];
    if (!sample || sample.on_ground === true) continue;
    const bank = finite(sample.bank_deg);
    if (bank === null) continue;
    const absBank = Math.abs(bank);
    const ms = epochMs(sample.ts);

    maxAbsDeg = maxAbsDeg === null ? absBank : Math.max(maxAbsDeg, absBank);
    if (ms !== null) lastBankMs = ms;

    if (episodeStartMs === null) {
      if (absBank > BANK_WINDOW.enterDeg && ms !== null) episodeStartMs = ms;
      continue;
    }
    if (absBank <= BANK_WINDOW.exitDeg) {
      if (ms !== null && ms - episodeStartMs >= BANK_WINDOW.minDurationS * 1000) episodes += 1;
      episodeStartMs = null;
    }
  }

  if (
    episodeStartMs !== null &&
    lastBankMs !== null &&
    lastBankMs - episodeStartMs >= BANK_WINDOW.minDurationS * 1000
  ) {
    episodes += 1;
  }

  if (maxAbsDeg === null) return null;
  return { episodes, maxAbsDeg };
}
