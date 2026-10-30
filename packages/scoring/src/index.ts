import {
  QUALITY_BITS,
  QUALITY_VALUE_BITS,
  SLEW_ELIGIBILITY_WINDOW_S,
  hasAnyQualityBit,
  type LandingMetrics,
  type LandingMetricsResponse,
  type LandingScore,
  type ScoreComponent,
  type ScoreComponents,
  type ScoreGrade,
} from '@flightlog/contracts';

export type {
  LandingMetrics,
  LandingMetricsResponse,
  LandingScore,
  ScoreComponent,
  ScoreComponents,
  ScoreGrade,
} from '@flightlog/contracts';

export { circularMeanDeg, computeWindComponents, type WindComponents } from './wind.js';
export {
  CONDITIONS_MIN_COVERAGE,
  CONDITIONS_WEIGHTS,
  assessConditions,
  conditionsTier,
  type ConditionsInput,
  type ConditionsWindShearInput,
} from './conditions.js';
export { CONDITIONS_VERSION } from '@flightlog/contracts';
export {
  TOUCHDOWN_GEOMETRY_DEFAULTS,
  TOUCHDOWN_RECONCILE_DEFAULTS,
  buildTouchdownPoint,
  computeTouchdownGeometry,
  isTouchdownOnRunway,
  reconcileTouchdownGeometry,
  runwayTrueHeading,
  type RunwayGeometry,
  type RunwayTrueHeadingInput,
  type TouchdownFix,
  type TouchdownGeometry,
  type TouchdownGeometryReconciliation,
} from './runway-geometry.js';
export {
  CLIP_WINDOW,
  clipNeedsWatermark,
  computeTouchdownClipWindow,
  type ClipWindow,
  type ClipWindowInput,
} from './clip-window.js';
export {
  AGL_DATUM_VERSION,
  AGL_DATUM_DEFAULTS,
  measureAglDatumOffset,
  toWheelHeightFt,
  type AglDatumOptions,
  type GroundHeightSample,
} from './agl-datum.js';
export {
  BANK_WINDOW,
  bankWindowStats,
  type BankWindowSample,
  type BankWindowStats,
} from './bank-window.js';
export {
  IMPLAUSIBLE_JUMP_LIMITS,
  detectImplausibleJump,
  detectImplausibleJumpBeforeTouch,
  isImplausibleShortFlight,
  type ImplausibleJump,
  type JumpGuardPoint,
} from './implausible-jump.js';
export {
  TELEMETRY_SANITY_LIMITS,
  TRACK_SANITY_LIMITS,
  assessTrackSanity,
  checkTelemetrySample,
  isImplausibleTrack,
  isPlausibleCoordinate,
  type TelemetrySanityInput,
  type TelemetrySanityReason,
  type TelemetrySanityResult,
  type TrackCoordinatePoint,
  type TrackSanityAssessment,
} from './telemetry-sanity.js';

/**
 * Semantic version of the scoring algorithm (ADR-0004). Leaderboards filter on
 * the "current" version — keep in sync with data-model.md leaderboard query.
 */
export const SCORE_VERSION = '1.0.0';

export interface ScoringWeights {
  verticalSpeed: number;
  gForce: number;
  centreline: number;
  bounce: number;
  attitude: number;
  touchdownZone: number;
}

export interface ScoringThresholds {
  vsSoftFpm: number;
  vsHardFpm: number;
  vsMaxFpm: number;
  gFirm: number;
  gHard: number;
  gSevere: number;
  gMax: number;
  centrelineMaxM: number;
}

export interface ScoringOptions {
  weights?: Partial<ScoringWeights>;
  thresholds?: Partial<ScoringThresholds>;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  verticalSpeed: 0.35,
  gForce: 0.15,
  centreline: 0.15,
  bounce: 0.15,
  attitude: 0.1,
  touchdownZone: 0.1,
};

/** Публичные веса по умолчанию — для отображения вклада критериев (UI). */
export const DEFAULT_SCORING_WEIGHTS: Readonly<ScoringWeights> = DEFAULT_WEIGHTS;

const DEFAULT_THRESHOLDS: ScoringThresholds = {
  vsSoftFpm: 100,
  vsHardFpm: 500,
  vsMaxFpm: 1000,
  gFirm: 1.2,
  gHard: 1.5,
  gSevere: 2.0,
  gMax: 2.5,
  centrelineMaxM: 30,
};

/** Канонический порядок критериев (совпадает с ключами `components`). */
export const SCORE_CRITERIA = [
  'vertical_speed',
  'g_force',
  'centreline',
  'bounce',
  'attitude',
  'touchdown_zone',
] as const satisfies readonly ScoreComponent[];

const WEIGHT_KEY: Readonly<Record<ScoreComponent, keyof ScoringWeights>> = {
  vertical_speed: 'verticalSpeed',
  g_force: 'gForce',
  centreline: 'centreline',
  bounce: 'bounce',
  attitude: 'attitude',
  touchdown_zone: 'touchdownZone',
};

/**
 * Веса критериев, пересчитанные по **измеренным** компонентам (`components`).
 *
 * Посадка может быть без части измерений (нет геометрии ВПП, старый клиент,
 * null в телеметрии). Такие критерии честно **отсутствуют** в `components`
 * (`scoreLanding` их не выставляет), а их вес **не учитывается** в балле.
 * Функция возвращает веса только для присутствующих критериев, нормированные
 * к сумме 1: UI показывает `—`/«не измерено» и «не учитывается» для остальных.
 *
 * Чистая и детерминированная: без I/O, `Date.now`, `Math.random`.
 */
export function scoringWeightsForComponents(
  components: ScoreComponents | null | undefined,
  opts?: ScoringOptions,
): Partial<Record<ScoreComponent, number>> {
  const weights: ScoringWeights = { ...DEFAULT_WEIGHTS, ...opts?.weights };
  const present = SCORE_CRITERIA.filter((criterion) => {
    const value = components?.[criterion];
    return typeof value === 'number' && Number.isFinite(value);
  });
  const total = present.reduce((sum, criterion) => sum + weights[WEIGHT_KEY[criterion]], 0);
  const out: Partial<Record<ScoreComponent, number>> = {};
  if (!(total > 0)) return out;
  for (const criterion of present) {
    out[criterion] = weights[WEIGHT_KEY[criterion]] / total;
  }
  return out;
}

// Per-criterion component score (0..100). Index = bounce count; last = ">=4".
const BOUNCE_SCORES: readonly number[] = [100, 70, 40, 10, 0];
const ZONE_SCORES: Readonly<Record<'TDZ' | 'before' | 'after', number>> = {
  TDZ: 100,
  before: 60,
  after: 70,
};

type Point = readonly [number, number];

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Piecewise-linear interpolation over ascending (x, y) anchor points. */
function piecewiseLinear(x: number, points: readonly Point[]): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined) return 0;
  if (!Number.isFinite(x)) return first[1];
  if (x <= first[0]) return first[1];
  if (last !== undefined && x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (prev === undefined || curr === undefined) continue;
    const [x0, y0] = prev;
    const [x1, y1] = curr;
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return last !== undefined ? last[1] : 0;
}

function deriveGrade(score: number): ScoreGrade {
  if (score >= 95) return 'butter';
  if (score >= 80) return 'good';
  if (score >= 60) return 'firm';
  if (score >= 40) return 'hard';
  return 'crash';
}

/**
 * Deterministic landing scoring (ADR-0004). Pure: no I/O, no Date.now, no
 * Math.random. Non-finite/missing optional inputs never throw.
 *
 * **Unmeasured criteria are unknown, not perfect** (QA-R3-01):
 * - `centreline_offset_m` / `touchdown_zone` are `null` when runway geometry is
 *   unresolved. `null` is NOT `0 m`/`TDZ`; those criteria are **omitted** from
 *   `components` and excluded from the weighted sum, and the remaining weights
 *   are renormalised over the measured criteria.
 * - Same for `g_force`, `pitch_deg`+`bank_deg` (attitude) and `bounce_count`
 *   when they were not measured.
 * - `vs_fpm` is the eligibility anchor (`hasMeasuredTouchdownVs`): missing
 *   (`null`) or reported as `>= 0` is unmeasured, excluded from the weighted
 *   sum. It is never scored as a perfect sink rate (P2). Such a landing is not
 *   leaderboard-eligible (`vs >= 0` fails acceptance), but its remaining
 *   measured criteria are shown honestly (`components` without `vertical_speed`).
 * - `g_force < 1.0` is treated as unmeasured for scoring (excluded, never
 *   scored as a perfect 1.0 g); the stored raw value is not zeroed.
 *
 * Fully measured landings keep the exact historical arithmetic (weights sum to
 * 1, no renormalisation) — bit-identical score. The landing remains eligible
 * for leaderboards as long as a measured sink rate and `g_force >= 1.0` are
 * present: an unresolved small airfield must not ban the flight (owner rule).
 */
export function scoreLanding(metrics: LandingMetricsResponse, opts?: ScoringOptions): LandingScore {
  const weights: ScoringWeights = { ...DEFAULT_WEIGHTS, ...opts?.weights };
  const thresholds: ScoringThresholds = { ...DEFAULT_THRESHOLDS, ...opts?.thresholds };

  // Eligibility-critical inputs: `vs_fpm`/`g_force` are never allowed to look
  // like a plausible `0 fpm`/`1.0 g` when the measurement is absent.
  // P2: a reported `>= 0 fpm` at contact is a missing measurement (sim telemetry
  // often clamps it), never a perfect sink rate. It is excluded from the sum,
  // exactly like `null`; the remaining weights are renormalised.
  const vs = metrics.vs_fpm;
  const g = metrics.g_force;
  const vsMeasured = isFiniteNumber(vs) && vs < 0;
  const gMeasured = isFiniteNumber(g) && g >= 1.0;
  const vsFpm = isFiniteNumber(vs) ? vs : thresholds.vsMaxFpm;
  const gForce = isFiniteNumber(g) ? g : thresholds.gMax;

  // Optional inputs: absent/non-finite -> unknown (criterion excluded).
  const pitch = metrics.pitch_deg;
  const bank = metrics.bank_deg;
  const bounceCount = metrics.bounce_count;
  const centreline = metrics.centreline_offset_m;
  const zone = metrics.touchdown_zone;

  const vsPoints: Point[] = [
    [0, 100],
    [thresholds.vsSoftFpm, 95],
    [thresholds.vsHardFpm, 60],
    [thresholds.vsMaxFpm, 0],
  ];
  const gPoints: Point[] = [
    [1.0, 100],
    [thresholds.gFirm, 90],
    [thresholds.gHard, 60],
    [thresholds.gSevere, 20],
    [thresholds.gMax, 0],
  ];
  const centrelinePoints: Point[] = [
    [0, 100],
    [5, 90],
    [15, 60],
    [thresholds.centrelineMaxM, 0],
  ];
  const pitchPoints: Point[] = [
    [-10, 0],
    [-5, 20],
    [0, 70],
    [5, 100],
    [10, 70],
    [15, 20],
    [20, 0],
  ];
  const bankPoints: Point[] = [
    [0, 100],
    [5, 80],
    [10, 50],
    [15, 10],
    [20, 0],
  ];

  const scores: Partial<Record<ScoreComponent, number>> = {};
  if (vsMeasured) {
    scores.vertical_speed = piecewiseLinear(Math.abs(vsFpm), vsPoints);
  }
  if (gMeasured) {
    scores.g_force = piecewiseLinear(gForce, gPoints);
  }
  if (typeof bounceCount === 'number' && Number.isFinite(bounceCount)) {
    const count = Math.max(0, Math.floor(bounceCount));
    scores.bounce = BOUNCE_SCORES[Math.min(count, BOUNCE_SCORES.length - 1)] ?? 0;
  }
  if (isFiniteNumber(pitch) && isFiniteNumber(bank)) {
    const pitchScore = piecewiseLinear(pitch, pitchPoints);
    const bankScore = piecewiseLinear(Math.abs(bank), bankPoints);
    scores.attitude = 0.6 * pitchScore + 0.4 * bankScore;
  }
  if (isFiniteNumber(centreline)) {
    scores.centreline = piecewiseLinear(Math.abs(centreline), centrelinePoints);
  }
  if (zone === 'TDZ' || zone === 'before' || zone === 'after') {
    scores.touchdown_zone = ZONE_SCORES[zone];
  }

  const measured = SCORE_CRITERIA.filter((criterion) => scores[criterion] !== undefined);
  let weighted = 0;
  let totalWeight = 0;
  for (const criterion of measured) {
    const weight = weights[WEIGHT_KEY[criterion]];
    weighted += weight * scores[criterion]!;
    totalWeight += weight;
  }

  // Fully measured landing: keep the historical arithmetic bit-identical.
  const fullyMeasured = measured.length === SCORE_CRITERIA.length;
  const normalised =
    fullyMeasured || !(totalWeight > 0) ? weighted : weighted / totalWeight;
  const score = Math.round(clamp(normalised, 0, 100));
  const grade = deriveGrade(score);

  const components: ScoreComponents = {};
  for (const criterion of measured) {
    components[criterion] = round2(scores[criterion]!);
  }

  return { score, grade, components, score_version: SCORE_VERSION };
}

export interface TouchdownWindowPoint {
  client_point_id: string;
  ts: string;
  quality: number;
}

export interface WindowQualityOptions {
  /** Время касания (ISO 8601 UTC). */
  touchdownTs: string;
  /** Полуширина окна касания (с). ADR-0003: 30. */
  windowS?: number;
  /** Целевая частота окна (Гц). ADR-0003: 10. */
  targetHz?: number;
  /** Порог частоты окна; ниже — информационный `LOW_RATE_WINDOW` (не гейт). */
  minLeaderboardHz?: number;
  /**
   * Окно до касания, в котором slew гейтит лидерборд (с).
   * По умолчанию `SLEW_ELIGIBILITY_WINDOW_S` (5 минут).
   */
  slewWindowS?: number;
  /**
   * Сервер уже обнаружил slew (`analyzeTrackIntegrity`) в окне
   * `slewWindowS` до касания. Передаётся, когда точки в `points` не содержат
   * клиентского `SLEW`-бита (телепорт вычислен по геометрии).
   */
  slewInPreTouchdownWindow?: boolean;
}

export interface WindowPointQualityUpdate {
  client_point_id: string;
  quality: number;
}

/**
 * Агрегат качества окна касания (api.md §3.3.1/§3.3.2, ADR-0003/ADR-0008).
 * Детерминированная чистая функция: эффективная частота, gaps, confidence и
 * допуск в лидерборд. Используется и агентом (предпросмотр), и сервером.
 */
export interface TouchdownWindowAssessment {
  sample_count: number;
  effective_hz: number;
  confidence: number;
  gap_count: number;
  gap_in_window: boolean;
  /**
   * Обнаружен slew/телепорт в окне `slewWindowS` до касания. Только этот
   * сигнал (и `PAUSED` в окне касания) лишает допуска в лидерборд.
   */
  slew_in_eligibility_window: boolean;
  quality_flags: number;
  leaderboard_eligible: boolean;
  point_updates: WindowPointQualityUpdate[];
}

const WINDOW_DEFAULTS = {
  windowS: 30,
  targetHz: 10,
  minLeaderboardHz: 5,
} as const;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function assessTouchdownWindow(
  points: readonly TouchdownWindowPoint[],
  options: WindowQualityOptions,
): TouchdownWindowAssessment {
  const windowS = options.windowS ?? WINDOW_DEFAULTS.windowS;
  const targetHz = options.targetHz ?? WINDOW_DEFAULTS.targetHz;
  const minLeaderboardHz = options.minLeaderboardHz ?? WINDOW_DEFAULTS.minLeaderboardHz;
  const slewWindowS = options.slewWindowS ?? SLEW_ELIGIBILITY_WINDOW_S;

  const anchorMs = Date.parse(options.touchdownTs);
  const fromMs = anchorMs - windowS * 1000;
  const toMs = anchorMs + windowS * 1000;
  const slewFromMs = anchorMs - slewWindowS * 1000;

  const windowPoints = points
    .filter((point) => {
      const ts = Date.parse(point.ts);
      return Number.isFinite(ts) && ts >= fromMs && ts <= toMs;
    })
    .sort(
      (a, b) =>
        Date.parse(a.ts) - Date.parse(b.ts) || a.client_point_id.localeCompare(b.client_point_id),
    );

  // Политика владельца: slew гейтит только в последние `slewWindowS` секунд
  // ДО касания. Slew раньше (смена стоянки/репозиционирование) остаётся в
  // треке и в `quality_flags`, но не препятствует лидерборду.
  const slewInEligibilityWindow =
    options.slewInPreTouchdownWindow === true ||
    points.some((point) => {
      const ts = Date.parse(point.ts);
      return (
        Number.isFinite(ts) &&
        ts >= slewFromMs &&
        ts <= anchorMs &&
        (point.quality & QUALITY_BITS.SLEW) !== 0
      );
    });

  const sampleCount = windowPoints.length;
  if (sampleCount === 0) {
    return {
      sample_count: 0,
      effective_hz: 0,
      confidence: 0,
      gap_count: 0,
      gap_in_window: false,
      slew_in_eligibility_window: slewInEligibilityWindow,
      quality_flags: slewInEligibilityWindow ? QUALITY_BITS.SLEW : 0,
      leaderboard_eligible: false,
      point_updates: [],
    };
  }

  const first = windowPoints[0];
  const last = windowPoints[sampleCount - 1];
  const spanS = first && last ? (Date.parse(last.ts) - Date.parse(first.ts)) / 1000 : 0;
  const effectiveHz = spanS > 0 ? (sampleCount - 1) / spanS : 0;

  const targetPeriodS = targetHz > 0 ? 1 / targetHz : 0;
  const gapThresholdS = Math.max(3 * targetPeriodS, 2);

  const gapBefore = new Set<string>();
  let gapCount = 0;
  for (let i = 1; i < sampleCount; i += 1) {
    const prev = windowPoints[i - 1];
    const curr = windowPoints[i];
    if (!prev || !curr) continue;
    const deltaS = (Date.parse(curr.ts) - Date.parse(prev.ts)) / 1000;
    if (deltaS > gapThresholdS) {
      gapCount += 1;
      gapBefore.add(curr.client_point_id);
    }
  }
  const gapInWindow = gapCount > 0;

  const lowRate = effectiveHz < minLeaderboardHz;

  let qualityFlags = 0;
  const pointUpdates: WindowPointQualityUpdate[] = [];
  for (const point of windowPoints) {
    qualityFlags |= point.quality;
    let next = point.quality;
    if (gapBefore.has(point.client_point_id)) next |= QUALITY_BITS.GAP_BEFORE;
    if (lowRate) next |= QUALITY_BITS.LOW_RATE_WINDOW;
    if (next !== point.quality) {
      pointUpdates.push({ client_point_id: point.client_point_id, quality: next });
    }
  }
  if (lowRate) qualityFlags |= QUALITY_BITS.LOW_RATE_WINDOW;
  if (gapInWindow) qualityFlags |= QUALITY_BITS.GAP_BEFORE;
  if (slewInEligibilityWindow) qualityFlags |= QUALITY_BITS.SLEW;

  const density = clamp(effectiveHz / targetHz, 0, 1);
  const continuity = sampleCount > 1 ? 1 - gapCount / (sampleCount - 1) : 0;
  const confidence = round3(clamp(density * continuity, 0, 1));

  // Только пилот-зависимые сигналы: slew в окне до касания и пауза в окне.
  // LOW_RATE_WINDOW/GAP_BEFORE/CLOCK_INVALID/INTERPOLATED — заметки о качестве
  // записи (наши проблемы), они не лишают допуска.
  const pausedInWindow = hasAnyQualityBit(qualityFlags, QUALITY_BITS.PAUSED);
  const leaderboardEligible = !slewInEligibilityWindow && !pausedInWindow;

  return {
    sample_count: sampleCount,
    effective_hz: round3(effectiveHz),
    confidence,
    gap_count: gapCount,
    gap_in_window: gapInWindow,
    slew_in_eligibility_window: slewInEligibilityWindow,
    quality_flags: qualityFlags,
    leaderboard_eligible: leaderboardEligible,
    point_updates: pointUpdates,
  };
}

/**
 * Признаки достоверного отрыва. Одного «подъёма высоты» недостаточно: в первых
 * кадрах SimConnect бывает bogus `on_ground=false` с произвольными `agl`/`alt`
 * при нулевой скорости (ВС реально стоит на полосе). Отрыв подтверждается только
 * движением: полётной скоростью, значащей вертикальной динамикой при движении или
 * отделением от земли с движением. Единые пороги для агента и сервера.
 */
export const LIFTOFF_EVIDENCE = {
  /** Высота над опорной точкой, выше которой ВС отделилось (ft). */
  altitudeFt: 10,
  /** Скорость, при которой ВС определённо летит (kt). */
  flyingGsKt: 40,
  /** Порог «есть движение» на земле (kt). */
  moveGsKt: 3,
  /** Порог значащей вертикальной скорости (fpm). */
  verticalFpm: 50,
  /**
   * Минимальный AGL (ft), достигнутый за воздушную фазу, при котором отрыв
   * считается **достоверным набором высоты**, а не взлётной пробежкой/подскоком.
   * Раньше `flyingGsKt` (gs ≥ 40) в одиночку подтверждал отрыв: на разбеге
   * (`on_ground=false`, `agl ≈ 0`) следующее `on_ground=true` давало ложную
   * посадку. Пробежка никогда не набирает этот AGL → отрыва и посадки нет.
   * Синхронно агенту (`LandingTracker.credibleLiftoffAglFt`).
   *
   * FOQA-DATUM-1: порог измеряется от **опорной точки** модели, т.е. фактически
   * требует `30 − datum_offset` футов высоты колёс (у A220 ≈ 20 ft, у C172 ≈ 30 ft).
   * Поведение намеренно **не менялось** (см. `agl-datum.ts`), чтобы не сдвигать
   * существующие детекты; риск — ВС с крупным датумом может подтвердить отрыв по
   * меньшей высоте колёс. Нормализация потребует датума внутри этой функции и
   * правок сервера (см. отчёт FOQA-DATUM-1).
   */
  credibleAglFt: 30,
  /**
   * Минимальная длительность воздушной фазы (с) между отрывом и касанием.
   * Короче — подшумок/мисдетект `SIM ON GROUND`, а не посадка. Агент требует
   * её от фазы перед касанием (`LandingTracker.minAirborneS`).
   */
  minAirborneS: 10,
} as const;

export interface LiftoffSample {
  on_ground?: boolean;
  groundspeed_kt?: number | null;
  vertical_speed_fpm?: number | null;
  /** Высота над опорной точкой: AGL или `altitude_ft − высота касания`. */
  agl_ft?: number | null;
}

export interface LiftoffEvidenceOptions {
  altitudeFt?: number;
  flyingGsKt?: number;
  moveGsKt?: number;
  verticalFpm?: number;
}

/**
 * Есть ли в сэмпле/точке признаки реального полёта (не bogus-артефакт).
 * Чистая детерминированная функция: без I/O, `Date.now`, `Math.random`.
 */
export function hasFlightEvidence(
  sample: LiftoffSample,
  options: LiftoffEvidenceOptions = {},
): boolean {
  const altitudeFt = options.altitudeFt ?? LIFTOFF_EVIDENCE.altitudeFt;
  const flyingGsKt = options.flyingGsKt ?? LIFTOFF_EVIDENCE.flyingGsKt;
  const moveGsKt = options.moveGsKt ?? LIFTOFF_EVIDENCE.moveGsKt;
  const verticalFpm = options.verticalFpm ?? LIFTOFF_EVIDENCE.verticalFpm;

  const gs = sample.groundspeed_kt;
  const vs = sample.vertical_speed_fpm;
  const agl = sample.agl_ft;

  const moving = typeof gs === 'number' && Number.isFinite(gs) && gs >= moveGsKt;
  const flying = typeof gs === 'number' && Number.isFinite(gs) && gs >= flyingGsKt;
  const vertical = typeof vs === 'number' && Number.isFinite(vs) && Math.abs(vs) >= verticalFpm;
  const hasAgl = typeof agl === 'number' && Number.isFinite(agl);
  const separated = hasAgl && agl > altitudeFt;

  // Полётная скорость сама по себе — достаточный признак: bogus-старт на стоянке
  // всегда `gs≈0`. Отделение/набор высоты без скорости — только при движении.
  if (flying) return true;
  if (separated && (vertical || moving)) return true;
  // Вертикальная динамика + движение — запасной критерий, ТОЛЬКО когда AGL
  // недоступен. При известной высоте это не отрыв: подскок на рулении может дать
  // `|vs| ≥ порога` при `gs ≥ 3`, но отделения от земли нет.
  if (!hasAgl && vertical && moving) return true;
  return false;
}

export interface CredibleClimbOptions extends LiftoffEvidenceOptions {
  /**
   * Минимальный AGL (ft) для достоверного набора высоты. `0`/отрицательный —
   * требование выключено (возврат к `hasFlightEvidence`). По умолчанию
   * `LIFTOFF_EVIDENCE.credibleAglFt`.
   */
  minAglFt?: number;
}

/**
 * Достоверный **набор высоты** (отрыв), а не артефакт пробежки/подскока.
 *
 * При доступном AGL требуется реальное отделение: `agl ≥ minAglFt` **при**
 * движении или вертикальной динамике. Одной полётной скорости мало — взлётная
 * пробежка (`gs ≥ 40` при `agl ≈ 0`) раньше подтверждала отрыв и создавала
 * ложную посадку на следующем `on_ground=true`.
 *
 * Когда AGL недоступен (`null`/отсутствует) — работает прежнее доказательство
 * `hasFlightEvidence` (обратная совместимость с треками без высоты).
 * Чистая детерминированная функция; общая для агента и сервера.
 */
export function hasCredibleClimb(
  sample: LiftoffSample,
  options: CredibleClimbOptions = {},
): boolean {
  const minAglFt = options.minAglFt ?? LIFTOFF_EVIDENCE.credibleAglFt;
  const moveGsKt = options.moveGsKt ?? LIFTOFF_EVIDENCE.moveGsKt;
  const verticalFpm = options.verticalFpm ?? LIFTOFF_EVIDENCE.verticalFpm;

  const agl = sample.agl_ft;
  const hasAgl = typeof agl === 'number' && Number.isFinite(agl);
  if (hasAgl && minAglFt > 0) {
    if (agl < minAglFt) return false;
    const gs = sample.groundspeed_kt;
    const vs = sample.vertical_speed_fpm;
    const moving = typeof gs === 'number' && Number.isFinite(gs) && gs >= moveGsKt;
    const vertical = typeof vs === 'number' && Number.isFinite(vs) && Math.abs(vs) >= verticalFpm;
    return moving || vertical;
  }
  return hasFlightEvidence(sample, options);
}

/** Точка трека для проверки подтверждённого отрыва (серверное решение). */
export interface LiftoffTrackPoint extends LiftoffSample {
  ts: string;
  altitude_ft?: number | null;
  /** Quality-биты точки; value-биты (`SLEW|CLOCK_INVALID|INTERPOLATED`) исключаются. */
  quality?: number;
}

/**
 * Есть ли в треке подтверждённый **достоверный отрыв**. Хотя бы одна воздушная
 * точка должна давать credible-flight-evidence (`hasCredibleClimb`) — тем же
 * критерием агент (`LandingTracker`) и `segmentLandings` (`confirmedLiftoffBefore`)
 * отличают реальный полёт от bogus-артефактов. Сессии, где такой точки нет, не
 * являются рейсом.
 *
 * AGL берётся из записанного `agl_ft` точки (как у агента); при его отсутствии —
 * пересчитывается как `altitude_ft − последняя наземная высота` (совместимость с
 * треками без `agl`). Критерий согласован с ADR-0010 §3: при известном AGL
 * требуется реальное отделение (`agl ≥ credibleAglFt` при движении/вертикали),
 * поэтому взлётная пробежка (`gs ≥ 40`, `agl ≈ 0`) отрывом не считается и сессия
 * отбрасывается на `/complete`. Когда AGL определить нельзя — прежнее
 * `hasFlightEvidence` (обратная совместимость с треками без высоты).
 *
 * Точки с value-битами (`SLEW`/`CLOCK_INVALID`/`INTERPOLATED`) не считаются
 * доказательством: slew/телепорт-сессия не должна проходить `/complete`
 * (та же политика, что у `validLandingPoints`).
 *
 * Порядок точек восстанавливается по `ts`. Если высоты и путевой скорости нет
 * вовсе, доказательств полёта нет → `false`.
 */
export function hasConfirmedLiftoff(
  points: readonly LiftoffTrackPoint[],
  options: CredibleClimbOptions = {},
): boolean {
  const sorted = points
    .filter((point) => ((point.quality ?? 0) & QUALITY_VALUE_BITS) === 0)
    .slice()
    .sort((a, b) => a.ts.localeCompare(b.ts));
  let groundAlt: number | null = null;
  for (const point of sorted) {
    const alt =
      typeof point.altitude_ft === 'number' && Number.isFinite(point.altitude_ft)
        ? point.altitude_ft
        : null;
    if (point.on_ground) {
      if (alt !== null) groundAlt = alt;
      continue;
    }
    const recordedAgl =
      typeof point.agl_ft === 'number' && Number.isFinite(point.agl_ft) ? point.agl_ft : null;
    const agl = recordedAgl ?? (alt !== null && groundAlt !== null ? alt - groundAlt : null);
    if (
      hasCredibleClimb(
        {
          on_ground: false,
          groundspeed_kt: point.groundspeed_kt,
          vertical_speed_fpm: point.vertical_speed_fpm,
          agl_ft: agl,
        },
        options,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Точка для серверной проверки правдоподобия (F-04/DATA-1). */
export interface PlausibilityPoint {
  client_point_id: string;
  ts: string;
  quality: number;
  g_force?: number | null;
  vertical_speed_fpm?: number | null;
  altitude_ft?: number | null;
  /** Координаты/скорость нужны для локального детекта телепорта в окне. */
  latitude?: number | null;
  longitude?: number | null;
  groundspeed_kt?: number | null;
}

/** Физические пределы правдоподобия: выход за них → бит `SLEW`. */
export const PLAUSIBILITY_LIMITS = {
  maxAbsG: 5,
  maxAbsVsFpm: 6000,
  maxAbsAltitudeFt: 60000,
} as const;

/**
 * Серверные plausibility-проверки значений точки (F-04). Клиентский `quality`
 * — лишь подсказка; невозможные `g`/`vs`/`alt` помечаются битом `SLEW`, который
 * исключает точку из скоринга и лишает рейс допуска в лидерборд.
 */
export function plausibilityFlags(point: PlausibilityPoint): number {
  let flags = 0;
  const g = point.g_force;
  if (typeof g === 'number' && (!Number.isFinite(g) || g < 0 || g > PLAUSIBILITY_LIMITS.maxAbsG)) {
    flags |= QUALITY_BITS.SLEW;
  }
  const vs = point.vertical_speed_fpm;
  if (
    typeof vs === 'number' &&
    (!Number.isFinite(vs) || Math.abs(vs) > PLAUSIBILITY_LIMITS.maxAbsVsFpm)
  ) {
    flags |= QUALITY_BITS.SLEW;
  }
  const altitude = point.altitude_ft;
  if (
    typeof altitude === 'number' &&
    (!Number.isFinite(altitude) || Math.abs(altitude) > PLAUSIBILITY_LIMITS.maxAbsAltitudeFt)
  ) {
    flags |= QUALITY_BITS.SLEW;
  }
  return flags;
}

/** Точка для серверной проверки непрерывности трека (DATA-1/R-01). */
export interface IntegrityTrackPoint {
  ts: string;
  /**
   * Клиентский порядковый номер. Когда он есть у всех точек, по нему проверяется
   * монотонность `ts` (немонотонный `ts` — признак сбоя часов/подмены).
   */
  seq?: number;
  lat?: number | null;
  lon?: number | null;
  groundspeed_kt?: number | null;
  vertical_speed_fpm?: number | null;
  g_force?: number | null;
  altitude_ft?: number | null;
}

export interface TrackIntegrityAssessment {
  /** Накопленные quality-биты (SLEW/CLOCK_INVALID) для исключения рейса из лидерборда. */
  flags: number;
  /** Число скачков позиции (телепортов), несовместимых со скоростью полёта. */
  teleports: number;
  /** Число невозможных значений `groundspeed`. */
  speed_spikes: number;
  /** Число точек с невозможными `g`/`vs`/`alt` (plausibility). */
  value_violations: number;
  /**
   * Число **аномальных** откатов `ts` (R6.1): назад-блоков, не объяснимых
   * штатным backfill окна касания. Не каждый «поздний `seq` с ранним `ts`»
   * является нарушением — см. `TS_INTEGRITY_LIMITS` и api.md §3.3.
   */
  ts_inversions: number;
}

/**
 * Физические пределы непрерывности трека. Скачок позиции детектируется по
 * имплицитной скорости `distance / dt`, а не по абсолютному расстоянию: короткий
 * разрыв при 10 Гц и реальный перелёт не должны считаться телепортом.
 */
export const TRACK_INTEGRITY_LIMITS = {
  maxGroundspeedKt: 1500,
  maxImpliedSpeedKt: 1800,
  /** Игнорируем микродрожание GPS, чтобы не ловить ложные телепорты. */
  minTeleportDistanceM: 50,
  /**
   * Интервал длиннее этого — пауза/разрыв записи (бит `GAP_BEFORE`), а не
   * телепорт: за такой промежуток позиция меняется штатно (ADR-0008 §1).
   * Имплицитная скорость по таким парам не оценивается вовсе.
   */
  maxContinuityGapS: 3,
  /** Минимальный масштаб «сжатия времени», объясняющий невозможную скорость. */
  minTimeBaseRatio: 2,
  /** Допуск совпадения горизонтального/вертикального масштабов (в долях). */
  timeBaseRatioTolerance: 0.35,
  /**
   * Порог скорости (kt), ниже которого пара точек считается «без движения».
   * Стартовый артефакт SimConnect: позиция прыгает с произвольных координат, но
   * ВС стоит (`gs≈0`, `vs≈0`) — это не телепорт, а не устоявшаяся телеметрия.
   */
  stationaryKt: LIFTOFF_EVIDENCE.moveGsKt,
  /** Порог `|vs|` (fpm) для той же «без движения» пары. */
  stationaryVsFpm: LIFTOFF_EVIDENCE.verticalFpm,
} as const;

const EARTH_RADIUS_M = 6_371_000;
const METRES_PER_SECOND_TO_KNOTS = 1.943844;
const SECONDS_PER_MINUTE = 60;

/**
 * Отличает артефакт таймбазы (сжатый `dt`, сбой часов/пауза) от настоящего
 * телепорта. Телепорт сдвигает **только позицию**: горизонтальная скорость
 * невозможна, а приборные `gs`/`vs`/`alt` остаются обычными. Если же за тот же
 * интервал и горизонталь, и вертикаль «продвинулись» примерно в одно и то же
 * число раз, то дело во временной метке — истинная скорость самолёта разумна,
 * и это не slew (регрессия T97: одиночный скачок ~1.5 км за ~1 с на A350).
 * При отсутствии приборных данных (`gs`/`vs`/`alt`) считается телепортом —
 * консервативно для анти-читерских проверок.
 */
function isTimeBaseArtifact(
  prev: IntegrityTrackPoint,
  curr: IntegrityTrackPoint,
  dt: number,
  distanceM: number,
): boolean {
  if (prev.altitude_ft == null || curr.altitude_ft == null) return false;
  const gsKt = Math.max(Math.abs(prev.groundspeed_kt ?? 0), Math.abs(curr.groundspeed_kt ?? 0));
  const vsFpm = Math.max(
    Math.abs(prev.vertical_speed_fpm ?? 0),
    Math.abs(curr.vertical_speed_fpm ?? 0),
  );
  if (gsKt <= 0 || vsFpm <= 0) return false;

  const horizontalRatio = ((distanceM / dt) * METRES_PER_SECOND_TO_KNOTS) / gsKt;
  const altitudeDeltaFt = Math.abs(curr.altitude_ft - prev.altitude_ft);
  const verticalRatio = ((altitudeDeltaFt / dt) * SECONDS_PER_MINUTE) / vsFpm;

  const high = Math.max(horizontalRatio, verticalRatio);
  const low = Math.min(horizontalRatio, verticalRatio);
  return (
    horizontalRatio >= TRACK_INTEGRITY_LIMITS.minTimeBaseRatio &&
    verticalRatio >= TRACK_INTEGRITY_LIMITS.minTimeBaseRatio &&
    high - low <= TRACK_INTEGRITY_LIMITS.timeBaseRatioTolerance * high
  );
}

function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Пороги проверки немонотонности `ts` (R6.1).
 *
 * `seq ↔ ts` — **НЕ инвариант** (api.md §3.3): backfill-точки окна касания
 * материализуются в момент касания и получают `seq` **после** уже записанных
 * 1 Гц точек, имея при этом **более ранний** `ts` (ADR-0003/ADR-0007). Поэтому
 * одиночный «откат» `ts` сам по себе — норма, а не подмена часов. Проверка
 * ловит только то, что backfill-паттерном не объясняется:
 *  - откат глубже легитимного lookback окна касания (`backfillWindowS`);
 *  - «точечный» откат (очень короткий назад-блок) значимой глубины;
 *  - неупорядоченный (немонотонный) назад-блок.
 * Равный `ts` нарушением не считается (несколько сэмплов делят кадр времени).
 */
export const TS_INTEGRITY_LIMITS = {
  /**
   * Полуширина окна касания (с): предельный легитимный backfill-lookback.
   * `AdaptiveSampler.markTouchdown` отдаёт точки за `windowS` до касания,
   * поэтому больший откат backfill-паттерном объяснить нельзя.
   */
  backfillWindowS: 30,
  /** Допуск (джиттер кадров/граница окна) к `backfillWindowS` (с). */
  backfillToleranceS: 5,
  /** Назад-блок длиной ≤ этого считается «точечным» (сбой кадра/подмена). */
  spikeMaxRun: 2,
  /** Минимальная глубина точечного отката, чтобы счесть его аномалией (с). */
  spikeMinDepthS: 5,
} as const;

/**
 * Число **аномальных** откатов `ts` относительно порядка записи `seq`.
 *
 * Позже записанная точка (больший `seq`) с более ранним `ts` — это штатный
 * backfill окна касания, поэтому не каждый откат является нарушением. Откаты
 * группируются в непрерывные назад-блоки; аномальным считается блок, который
 * (а) идёт не по возрастанию `ts`, (б) является «точечным» с глубиной больше
 * `spikeMinDepthS`, либо (в) откатывается глубже `backfillWindowS + tolerance`.
 *
 * Проверка выполняется только когда у **всех** точек есть конечный уникальный
 * `seq`; иначе признак неоценим (обратная совместимость и защита от `seq`-reset
 * сессий: дубли `seq` означают смешение частей рейса, а не подмену часов).
 */
function countTsInversions(points: readonly IntegrityTrackPoint[]): number {
  if (points.length < 2) return 0;
  const withSeq = points.filter(
    (point): point is IntegrityTrackPoint & { seq: number } =>
      typeof point.seq === 'number' && Number.isFinite(point.seq),
  );
  if (withSeq.length !== points.length) return 0;
  // `seq` уникален в пределах одного рейса. Дубли → две сессии/сброс счётчика:
  // порядок записи восстановить нельзя, ложный CLOCK_INVALID недопустим.
  if (new Set(withSeq.map((point) => point.seq)).size !== withSeq.length) return 0;

  const bySeq = withSeq.slice().sort((a, b) => a.seq - b.seq || a.ts.localeCompare(b.ts));
  const maxBackfillMs =
    (TS_INTEGRITY_LIMITS.backfillWindowS + TS_INTEGRITY_LIMITS.backfillToleranceS) * 1000;
  const spikeMinMs = TS_INTEGRITY_LIMITS.spikeMinDepthS * 1000;

  let anomalies = 0;
  // Текущий непрерывный назад-блок: `depth` считается от максимума `ts`,
  // достигнутого до блока (нормального хода часов).
  let run: { anchorMaxMs: number; minMs: number; prevMs: number; len: number; ordered: boolean } | null =
    null;
  let maxMs = Number.NEGATIVE_INFINITY;

  const flush = (): void => {
    if (run === null) return;
    const depthMs = run.anchorMaxMs - run.minMs;
    const anomalous =
      !run.ordered ||
      (run.len <= TS_INTEGRITY_LIMITS.spikeMaxRun && depthMs > spikeMinMs) ||
      depthMs > maxBackfillMs;
    if (anomalous) anomalies += 1;
    run = null;
  };

  for (const point of bySeq) {
    const ts = Date.parse(point.ts);
    if (!Number.isFinite(ts)) {
      flush();
      continue;
    }
    if (run === null) {
      if (ts < maxMs) {
        run = { anchorMaxMs: maxMs, minMs: ts, prevMs: ts, len: 1, ordered: true };
      } else {
        maxMs = Math.max(maxMs, ts);
      }
      continue;
    }
    if (ts < run.prevMs) run.ordered = false;
    run.minMs = Math.min(run.minMs, ts);
    run.prevMs = ts;
    run.len += 1;
    if (ts >= maxMs) {
      maxMs = ts;
      flush();
    }
  }
  flush();
  return anomalies;
}

/**
 * Серверный анализ непрерывности трека (DATA-1/R-01): невозможные значения
 * `g`/`vs`/`alt`, `groundspeed` вне диапазона, скачки позиции («телепорты») и
 * **аномальный** откат `ts` относительно `seq` (R6.1; штатный backfill окна
 * касания нарушением не считается — api.md §3.3). Детерминированная чистая
 * функция; результат — биты `SLEW`/`CLOCK_INVALID`, которые лишают рейс допуска
 * в лидерборд и исключают точку из скоринга.
 *
 * Калибровка (T97): разрывы `dt > maxContinuityGapS` — это пауза/гэп
 * (`GAP_BEFORE`), а не телепорт; интервал, в котором горизонталь и вертикаль
 * «ускорились» одинаково, — артефакт таймбазы, а не slew. `alt`/`agl` — разные
 * источники и здесь между собой не сравниваются.
 */
export function analyzeTrackIntegrity(
  points: readonly IntegrityTrackPoint[],
): TrackIntegrityAssessment {
  const sorted = points
    .slice()
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.ts.localeCompare(b.ts));

  let flags = 0;
  let speedSpikes = 0;
  let valueViolations = 0;

  for (const point of sorted) {
    const violation = plausibilityFlags({
      client_point_id: '',
      ts: point.ts,
      quality: 0,
      g_force: point.g_force,
      vertical_speed_fpm: point.vertical_speed_fpm,
      altitude_ft: point.altitude_ft,
    });
    if (violation !== 0) {
      flags |= violation;
      valueViolations += 1;
    }
    const gs = point.groundspeed_kt;
    if (
      typeof gs === 'number' &&
      (!Number.isFinite(gs) || gs < 0 || gs > TRACK_INTEGRITY_LIMITS.maxGroundspeedKt)
    ) {
      flags |= QUALITY_BITS.SLEW;
      speedSpikes += 1;
    }
  }

  let teleports = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (!prev || !curr) continue;
    const dt = (Date.parse(curr.ts) - Date.parse(prev.ts)) / 1000;
    if (!(dt > 0)) continue;
    // Пауза/разрыв записи: позиция меняется штатно, это не телепорт (GAP_BEFORE).
    if (dt > TRACK_INTEGRITY_LIMITS.maxContinuityGapS) continue;
    if (
      typeof prev.lat !== 'number' ||
      typeof prev.lon !== 'number' ||
      typeof curr.lat !== 'number' ||
      typeof curr.lon !== 'number'
    ) {
      continue;
    }
    const distance = haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon);
    if (distance < TRACK_INTEGRITY_LIMITS.minTeleportDistanceM) continue;
    const impliedKt = (distance / dt) * METRES_PER_SECOND_TO_KNOTS;
    if (impliedKt <= TRACK_INTEGRITY_LIMITS.maxImpliedSpeedKt) continue;
    // Стартовый артефакт: позиция прыгнула, но ВС никуда не движется (`gs≈0`,
    // `vs≈0` на обоих концах) — не логируем как телепорт. Реальный slew в полёте
    // всегда имеет скорость/вертикаль хотя бы на одном из концов.
    const pairGsKt = Math.max(
      Math.abs(prev.groundspeed_kt ?? 0),
      Math.abs(curr.groundspeed_kt ?? 0),
    );
    const pairVsFpm = Math.max(
      Math.abs(prev.vertical_speed_fpm ?? 0),
      Math.abs(curr.vertical_speed_fpm ?? 0),
    );
    if (
      pairGsKt < TRACK_INTEGRITY_LIMITS.stationaryKt &&
      pairVsFpm < TRACK_INTEGRITY_LIMITS.stationaryVsFpm
    ) {
      continue;
    }
    // Сжатый `dt` (таймбаза): и позиция, и высота продвинулись в одно число раз.
    if (isTimeBaseArtifact(prev, curr, dt, distance)) continue;
    flags |= QUALITY_BITS.SLEW;
    teleports += 1;
  }

  // Аномальный откат `ts` (позже записанная точка имеет существенно более
  // раннее время и это не объясняется backfill окна касания) — признак сбоя
  // часов/подмены телеметрии: помечаем CLOCK_INVALID (value-бит), чтобы рейс не
  // попал в лидерборд. Считается по `seq`, а не по порядку массива.
  const tsInversions = countTsInversions(points);
  if (tsInversions > 0) flags |= QUALITY_BITS.CLOCK_INVALID;

  return {
    flags,
    teleports,
    speed_spikes: speedSpikes,
    value_violations: valueViolations,
    ts_inversions: tsInversions,
  };
}

export interface FlightQualityOptions {
  /** Время касания; при отсутствии рейс не допускается в лидерборд. */
  touchdownTs: string | null;
  windowS?: number;
  targetHz?: number;
  minLeaderboardHz?: number;
  /** Окно до касания, в котором slew гейтит (с). По умолчанию 5 минут. */
  slewWindowS?: number;
  /**
   * Клиентский hint `is_partial` — усиливается, не понижается сервером.
   * Единственное исключение — `landingConfirmed`: подтверждённое касание
   * отменяет терминальную потерю данных (ADR-0008 §2, T99).
   */
  isPartialHint?: boolean;
  /**
   * Сервер подтвердил касание по треку (`LandingSegment.verified`). Тогда
   * терминальный обрыв/потеря данных (`sim_disconnected`/`no_data`) **после**
   * посадки не делает рейс partial: окно касания записано и пригодно для скоринга.
   */
  landingConfirmed?: boolean;
  /** Клиентские `quality`-биты — только дополнительный сигнал. */
  qualityFlagsHint?: number;
}

export interface FlightQualityAssessment {
  quality_flags: number;
  confidence: number;
  effective_hz: number;
  leaderboard_eligible: boolean;
  is_partial: boolean;
  point_updates: WindowPointQualityUpdate[];
}

/**
 * Серверная агрегация качества рейса (T57/F-04): объединяет клиентские
 * `quality`-биты с plausibility-проверками окна касания и вычисляет
 * `confidence`/`leaderboard_eligible`/`is_partial`. Детерминированная и
 * чистая — без I/O, `Date.now` и `Math.random`.
 */
export function assessFlightQuality(
  points: readonly PlausibilityPoint[],
  options: FlightQualityOptions,
): FlightQualityAssessment {
  const qualityFlagsHint = options.qualityFlagsHint ?? 0;
  // Подтверждённая посадка снимает терминальный `is_partial`-hint (ADR-0008 §2, T99).
  const baseIsPartial = Boolean(options.isPartialHint) && !options.landingConfirmed;

  if (!options.touchdownTs) {
    return {
      quality_flags: qualityFlagsHint,
      confidence: 0,
      effective_hz: 0,
      leaderboard_eligible: false,
      is_partial: baseIsPartial,
      point_updates: [],
    };
  }

  const sanitized: TouchdownWindowPoint[] = points.map((point) => ({
    client_point_id: point.client_point_id,
    ts: point.ts,
    quality: point.quality | plausibilityFlags(point),
  }));

  const slewWindowS = options.slewWindowS ?? SLEW_ELIGIBILITY_WINDOW_S;
  const anchorMs = Date.parse(options.touchdownTs);
  const localIntegrity = analyzeTrackIntegrity(
    points
      .filter((point) => {
        const ts = Date.parse(point.ts);
        return Number.isFinite(ts) && ts >= anchorMs - slewWindowS * 1000 && ts <= anchorMs;
      })
      .map((point) => ({
        ts: point.ts,
        lat: point.latitude,
        lon: point.longitude,
        groundspeed_kt: point.groundspeed_kt,
        vertical_speed_fpm: point.vertical_speed_fpm,
        g_force: point.g_force,
        altitude_ft: point.altitude_ft,
      })),
  );
  const localSlew = hasAnyQualityBit(localIntegrity.flags, QUALITY_BITS.SLEW);

  const window = assessTouchdownWindow(sanitized, {
    touchdownTs: options.touchdownTs,
    windowS: options.windowS,
    targetHz: options.targetHz,
    minLeaderboardHz: options.minLeaderboardHz,
    slewWindowS,
    slewInPreTouchdownWindow: localSlew,
  });

  const qualityFlags = window.quality_flags | qualityFlagsHint | localIntegrity.flags;
  const paused = hasAnyQualityBit(qualityFlags, QUALITY_BITS.PAUSED);
  const isPartial = baseIsPartial || window.gap_in_window || paused;

  return {
    quality_flags: qualityFlags,
    confidence: window.confidence,
    effective_hz: window.effective_hz,
    // Только slew в окне до касания и пауза в окне касания лишают допуска.
    // `is_partial` (gap/terminal loss) — заметка о полноте записи, не гейт.
    leaderboard_eligible: window.leaderboard_eligible && !paused,
    is_partial: isPartial,
    point_updates: window.point_updates,
  };
}

/** Событие рейса для сегментации посадок (`type`/`ts`/`data`). */
export interface LandingEvent {
  type: string;
  ts: string;
  data: Record<string, unknown>;
}

/**
 * Точка трека для сегментации. Структурно совместима с `ScoringPoint` api;
 * хронология восстанавливается по `ORDER BY ts, seq` (ADR-0003/0007).
 */
export interface LandingPoint {
  ts: string;
  seq?: number;
  on_ground: boolean;
  vertical_speed_fpm: number | null;
  g_force: number | null;
  pitch_deg: number | null;
  bank_deg: number | null;
  quality: number;
  latitude?: number | null;
  longitude?: number | null;
  groundspeed_kt?: number | null;
  altitude_ft?: number | null;
}

/**
 * Версия правил группировки касаний (bounce vs новая посадка, touch-and-go).
 * Отделена от `score_version`: формула скоринга (ADR-0004) не меняется, а
 * правила сегментации можно переразбить без пересчёта версии балла.
 *
 * `1.1.0`: касание перед посадкой обязано иметь **достоверный набор высоты**
 * (`confirmedLiftoffBefore` → `hasCredibleClimb`): взлётная пробежка/подскок с
 * `gs ≥ 40` и `agl ≈ 0` больше не создаёт посадку. Семантика сегментов изменилась
 * (у части «пробежных» сессий посадок станет 0), поэтому версия поднята.
 *
 * `1.2.0`: `vs_fpm` посадки берётся строго с **кадра перехода `air→ground`** —
 * агент теперь материализует этот кадр в трек (`FlightRecorder.handleTouchdownEvent`),
 * поэтому серверный `trackTouchdownVs` использует VS фактического касания, а не
 * следующей наземной точки (была систематически мягче — инцидент: клиент −114,
 * сервер −111). Формула балла (`score_version`) не менялась; исторические посадки
 * не пересчитываются.
 *
 * `1.3.0`: отскок (bounce) и touch-and-go различаются по **достоверному набору
 * высоты**, а не только по времени. Повторное касание без набора ≥30 ft AGL —
 * отскок той же посадки (в пределах `bounceMaxAirborneS`); реальный отрыв ≥30 ft
 * даёт отдельную посадку. Поэтому низкий подскок (≈1 м) больше не помечает
 * последнюю посадку как touch-and-go и не теряет свой `bounce_count`.
 *
 * `1.4.0`: «воздушная фаза» больше не считается отскоком без достоверного
 * подскока (`BOUNCE_EVIDENCE`): прирост AGL ≥1.5 ft над последним касанием,
 * длительность ≥0.3 с и ≥3 подряд идущих воздушных сэмпла. Дрожание
 * `SIM ON GROUND` (1–2 сэмпла, +0.1…0.8 ft) сливает касания в одну посадку
 * (`bounce_count=0`). Добавлен cross-check VS касания (`analysis.vs_source`):
 * при расхождении sim-VS и VS по высоте >10% (|sim VS| >50 fpm) берётся
 * значение по высоте.
 *
 * `1.5.0`: `vs_fpm === 0` на кадре перехода считается **неизмеренным**
 * (`null`), а не идеальным касанием. Такая посадка не зачётна, а фантомные
 * «касания» после загрузки/телепорта (скачок >5 000 ft / >5 км) отбрасываются
 * на `/complete` целиком. Семантика сохранённых `landings` меняется — версия
 * поднята.
 */
export const SEGMENTATION_VERSION = '1.5.0';

/**
 * Порог достоверного подскока (отскока). Общий для агента (`LandingTracker`)
 * и серверной `segmentLandings`: иначе превью клиента расходится с сервером.
 */
export const BOUNCE_EVIDENCE = {
  /** Минимальный прирост AGL (ft) над последним касанием. */
  minAglGainFt: 1.5,
  /** Минимальная длительность воздушной фазы (с). */
  minAirborneS: 0.3,
  /** Минимум подряд идущих воздушных сэмплов (20 Гц → 0.15 с). */
  minAirborneSamples: 3,
} as const;

/**
 * Cross-check VS касания по высоте: окно до касания (с), относительный допуск
 * расхождения и порог |sim VS| (fpm), ниже которого sim-значение не оспаривается.
 */
export const VS_CROSSCHECK = {
  altitudeWindowS: 1.5,
  /**
   * Минимум точек окна (включая кадр касания): на разреженном треке пара
   * сэмплов с квантованием высоты даёт шум, а не производную.
   */
  minSamples: 5,
  /** Минимальный реальный охват окна (с): короче — окно считается негодным. */
  minAltitudeSpanS: 0.8,
  /** Минимальная доля объяснённой дисперсии высоты (линейная регрессия). */
  minRSquared: 0.9,
  /**
   * Физический предел |VS| (fpm) для производной высоты: скачок высоты
   * (смена данных/телепорт/битый кадр) не должен подменять sim-VS.
   */
  maxAbsFpm: 6_000,
  toleranceRel: 0.15,
  minAbsFpm: 50,
} as const;

/** Пороги сегментации (ADR-0010 §3, OPEN DECISIONS §2/§3). */
export const SEGMENTATION_DEFAULTS = {
  /** Касание в пределах этого времени после предыдущего — отскок (bounce). */
  bounceMaxAirborneS: 5,
  /** Максимальная выдержка на земле для touch-and-go (с). */
  touchAndGoMaxGroundS: 90,
  /** Выдержка `gs < stopSpeedKt` дольше этого времени = полная остановка (с). */
  stopDwellS: 5,
  /** Порог скорости «стоит на земле» (kt). */
  stopSpeedKt: 1,
  /** Полуширина окна пиковой перегрузки (с), как в metric-экстракторе. */
  metricWindowS: 2,
  /**
   * Окно (с) до касания, из которого агент берёт `vs_fpm` события (минимум
   * вертикальной скорости). Сервер сравнивает событие с **тем же** минимумом
   * трека, а не с мгновенным `vs` точки перехода, иначе реальные T&G ловят
   * ложный SLEW. Синхронно агенту (`preContactWindowS=3`).
   */
  eventVsWindowS: 3,
  /**
   * Минимальный набор высоты над точкой касания (ft), при котором отрыв перед
   * `air→ground` считается реальным. Синхронно агенту (`liftoffAglFt=10`):
   * транзиентный `on_ground=false` на старте сессии (ВС на земле) не создаёт
   * ложную посадку.
   */
  liftoffConfirmFt: LIFTOFF_EVIDENCE.altitudeFt,
  /**
   * Минимальный AGL (ft) за воздушную фазу до касания, при котором отрыв
   * считается реальным набором высоты. Пробежка/подскок (`agl ≈ 0`) при
   * `liftoffConfirmGsKt` больше не создаёт посадку (F: ложная посадка 98 на
   * разбеге). Синхронно агенту (`credibleLiftoffAglFt`).
   */
  credibleLiftoffFt: LIFTOFF_EVIDENCE.credibleAglFt,
  /**
   * Скорость (kt) среди точек предшествующего воздушного участка, при которой
   * отрыв считается реальным, когда `altitude_ft` в треке **отсутствует**.
   * Отсекает стоящий/рулящий ВС с ложным `on_ground=false` (gs ≈ 0). При
   * известной высоте дополнительно требуется `credibleLiftoffFt` (AGL): плоская
   * высота без набора — это не отрыв (см. F: ложная посадка 98 на разбеге).
   */
  liftoffConfirmGsKt: LIFTOFF_EVIDENCE.flyingGsKt,
  /**
   * Порог «есть движение» (kt) для подтверждения отрыва по высоте/вертикали.
   * Bogus-airborne на стоянке (`gs≈0`) не проходит этот порог (T-…).
   */
  liftoffMoveKt: LIFTOFF_EVIDENCE.moveGsKt,
  /** Порог значащей вертикальной скорости при подтверждении отрыва (fpm). */
  liftoffVerticalFpm: LIFTOFF_EVIDENCE.verticalFpm,
  /**
   * Абсолютный допуск расхождения `g` события и пика трека. Событие агента
   * фиксируется на сэмпле касания — до пика обжатия/derotation, который сервер
   * видит в окне ±2 с, поэтому событие законно ниже пика (высокий `g` на
   * выравнивании — физика, а не подделка). T97: 0.3 было мало (A350: 1.01 vs 1.32).
   */
  eventGToleranceG: 0.5,
  /** Дополнительный допуск как доля пикового `g` (турбулентность, жёсткая посадка). */
  eventGRelativeTolerance: 0.3,
  /**
   * Порог достоверного подскока (отскока) — см. `BOUNCE_EVIDENCE`. Касание в
   * пределах `bounceMaxAirborneS` становится отскоком только при таком приросте
   * AGL и длительности; иначе касания сливаются в одну посадку.
   */
  bounceMinAglGainFt: BOUNCE_EVIDENCE.minAglGainFt,
  bounceMinAirborneS: BOUNCE_EVIDENCE.minAirborneS,
  bounceMinAirborneSamples: BOUNCE_EVIDENCE.minAirborneSamples,
  /** Допуск `ts` события `touchdown` относительно перехода трека (мс). */
  eventTsToleranceMs: 5_000,
} as const;

export interface SegmentationOptions {
  bounceMaxAirborneS?: number;
  touchAndGoMaxGroundS?: number;
  stopDwellS?: number;
  stopSpeedKt?: number;
  metricWindowS?: number;
  eventVsWindowS?: number;
  liftoffConfirmFt?: number;
  liftoffConfirmGsKt?: number;
  liftoffMoveKt?: number;
  liftoffVerticalFpm?: number;
  credibleLiftoffFt?: number;
  eventGToleranceG?: number;
  eventGRelativeTolerance?: number;
  eventTsToleranceMs?: number;
  bounceMinAglGainFt?: number;
  bounceMinAirborneS?: number;
  bounceMinAirborneSamples?: number;
}

/** Одна посадка сессии (ADR-0010 §3). */
export interface LandingSegment {
  /** Порядок касания в сессии, начиная с 1; детерминирован. */
  seq: number;
  /** Время первого касания данной посадки (ISO 8601 UTC). */
  touchdownTs: string;
  /** Число отскоков этой посадки (не отдельные посадки). */
  bounceCount: number;
  bounced: boolean;
  /** От касания до отрыва (с); `null` — последняя посадка без отрыва. */
  groundContactS: number | null;
  stoppedOnGround: boolean;
  touchAndGo: boolean;
  /** Метрики из трека (а не из недоверенного события). */
  verified: boolean;
  /** Серверные quality-биты (SLEW и т.п.). */
  flags: number;
  /** Источник `metrics.vs_fpm`: sim-кадр касания или производная высоты. */
  vsSource: 'sim' | 'altitude';
  /** VS по `altitude_ft` за `VS_CROSSCHECK.altitudeWindowS` до касания (fpm). */
  vsAltitudeFpm: number | null;
  metrics: LandingMetricsResponse;
  /**
   * Координаты точки касания из трека (R-01 residual). `null`, когда касание не
   * подтверждено переходом `air→ground` (фолбэк на событие) — тогда геометрия
   * ВПП не применяется, метрики берутся из события.
   */
  touchdown_lat?: number | null;
  touchdown_lon?: number | null;
}

const ZONES = ['TDZ', 'before', 'after'] as const;

function landingNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function landingInt(value: unknown): number | undefined {
  const n = landingNum(value);
  return n === null ? undefined : Math.trunc(n);
}

function landingZone(value: unknown): LandingMetrics['touchdown_zone'] {
  return typeof value === 'string' && (ZONES as readonly string[]).includes(value)
    ? (value as LandingMetrics['touchdown_zone'])
    : undefined;
}

/** Достоверные точки в хронологии: без value-битов, сортировка `ts, seq`. */
function validLandingPoints(points: readonly LandingPoint[]): LandingPoint[] {
  return points
    .filter((p) => (p.quality & QUALITY_VALUE_BITS) === 0)
    .slice()
    .sort((a, b) => a.ts.localeCompare(b.ts) || (a.seq ?? 0) - (b.seq ?? 0));
}

/** Пиковая перегрузка в окне ±windowS вокруг якоря. */
function peakGAt(
  points: readonly LandingPoint[],
  anchorTs: string,
  windowS: number,
): number | null {
  const anchor = Date.parse(anchorTs);
  let peak: number | null = null;
  for (const point of points) {
    const ts = Date.parse(point.ts);
    if (!Number.isFinite(ts) || Math.abs(ts - anchor) > windowS * 1000) continue;
    if (point.g_force === null) continue;
    if (peak === null || point.g_force > peak) peak = point.g_force;
  }
  return peak;
}

function fastestDescentPoint(points: readonly LandingPoint[]): LandingPoint | undefined {
  return points
    .filter((p) => p.vertical_speed_fpm !== null)
    .reduce<LandingPoint | undefined>(
      (best, p) =>
        !best || (p.vertical_speed_fpm ?? 0) < (best.vertical_speed_fpm ?? 0) ? p : best,
      undefined,
    );
}

/**
 * Одна точка для cross-check VS по высоте. `altitude_ft` — абсолютная высота
 * (не AGL): разность высот за окно и даёт вертикальную скорость.
 */
export interface VsAltitudePoint {
  ts: string;
  altitude_ft: number | null;
}

export interface TouchdownVsResult {
  /** Итоговая VS касания (`null` — измерить не удалось). */
  vsFpm: number | null;
  /** Что использовано: sim-кадр (`sim`) или производная высоты (`altitude`). */
  source: 'sim' | 'altitude';
  /** VS по высоте (fpm); `null` — окно высоты недоступно. */
  altitudeFpm: number | null;
}

/**
 * VS по высоте в окне `windowS` до касания (включая кадр касания). Один шаг
 * «ранняя точка → касание» слишком чувствителен к квантованию высоты и дырам в
 * треке, поэтому берётся линейная регрессия altitude(t) по всем точкам окна:
 * `ft/min = slope × 60`. Требуются ≥`minSamples` точек, охват ≥`minAltitudeSpanS`
 * и `R² ≥ minRSquared` (иначе высота не описывается чистой прямой). Нет годного
 * окна → `null` (не фабрикуем значение).
 */
export function altitudeDerivedVs(
  contactTs: string,
  contactAltFt: number | null,
  history: readonly VsAltitudePoint[],
  windowS: number = VS_CROSSCHECK.altitudeWindowS,
): number | null {
  const contactMs = Date.parse(contactTs);
  const contactAlt = landingNum(contactAltFt);
  if (!Number.isFinite(contactMs) || contactAlt === null) return null;
  const fromMs = contactMs - windowS * 1000;
  const samples: { t: number; alt: number }[] = [{ t: 0, alt: contactAlt }];
  for (const point of history) {
    const ts = Date.parse(point.ts);
    const alt = landingNum(point.altitude_ft);
    if (!Number.isFinite(ts) || alt === null || ts >= contactMs || ts < fromMs) continue;
    samples.push({ t: (ts - contactMs) / 1000, alt });
  }
  if (samples.length < VS_CROSSCHECK.minSamples) return null;
  const times = samples.map((point) => point.t);
  if (Math.max(...times) - Math.min(...times) < VS_CROSSCHECK.minAltitudeSpanS) return null;
  const n = samples.length;
  const meanT = samples.reduce((sum, point) => sum + point.t, 0) / n;
  const meanAlt = samples.reduce((sum, point) => sum + point.alt, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let sst = 0;
  for (const point of samples) {
    const dt = point.t - meanT;
    const da = point.alt - meanAlt;
    sxx += dt * dt;
    sxy += dt * da;
    sst += da * da;
  }
  // Плоская высота за окно — сигнал высоты не измерим (квантование/замороженный
  // канал), а не «нулевая VS»: не подменяем sim-значение фабрикованным нулём.
  if (sxx === 0 || sst === 0) return null;
  const slope = sxy / sxx;
  let sse = 0;
  for (const point of samples) {
    const residual = point.alt - (meanAlt + slope * (point.t - meanT));
    sse += residual * residual;
  }
  if (!(1 - sse / sst >= VS_CROSSCHECK.minRSquared)) return null;
  const derived = Math.round(slope * 60);
  if (Math.abs(derived) > VS_CROSSCHECK.maxAbsFpm) return null;
  return derived;
}

/**
 * Cross-check VS касания (D1). Если sim-VS значимо (|sim| > 50 fpm) расходится
 * с регрессией высоты больше чем на 15%, доверяем высоте: лаг/сглаживание
 * sim-канала искажает мгновенное значение. Окно высоты негодное (мало точек,
 * короткий охват, R² < 0.9) → остаётся sim (никогда не фабрикуем). Чистая
 * детерминированная функция.
 */
export function crossCheckTouchdownVs(
  simVsFpm: number | null,
  contactTs: string,
  contactAltFt: number | null,
  history: readonly VsAltitudePoint[],
  windowS: number = VS_CROSSCHECK.altitudeWindowS,
): TouchdownVsResult {
  const sim = landingNum(simVsFpm);
  const altitudeFpm = altitudeDerivedVs(contactTs, contactAltFt, history, windowS);
  if (sim === null) {
    return altitudeFpm === null
      ? { vsFpm: null, source: 'sim', altitudeFpm: null }
      : { vsFpm: altitudeFpm, source: 'altitude', altitudeFpm };
  }
  if (
    altitudeFpm !== null &&
    Math.abs(sim) > VS_CROSSCHECK.minAbsFpm &&
    Math.abs(sim - altitudeFpm) > Math.max(Math.abs(sim), 1) * VS_CROSSCHECK.toleranceRel
  ) {
    return { vsFpm: altitudeFpm, source: 'altitude', altitudeFpm };
  }
  return { vsFpm: sim, source: 'sim', altitudeFpm };
}

/**
 * Вертикальная скорость касания: **сырое** значение точки перехода
 * (`air→ground`) → производная alt → максимальное снижение окна. Перед выбором
 * значение сверяется с производной высоты (`crossCheckTouchdownVs`).
 *
 * VS касания — это мгновенный замер кадра перехода, а не интерполяция/среднее
 * соседних сэмплов: агент кладёт в трек сам кадр перехода (`SEGMENTATION_VERSION`
 * 1.2.0), поэтому `transition.vertical_speed_fpm` и есть фактический sink в
 * момент касания. Производная высоты — только когда мгновенный VS в точке
 * отсутствует; фолбэк на максимум снижения — последний резерв.
 */
function trackTouchdownVs(
  sorted: readonly LandingPoint[],
  transition: LandingPoint,
): TouchdownVsResult {
  const altHistory = sorted
    .filter((point) => point !== transition)
    .map((point) => ({ ts: point.ts, altitude_ft: landingNum(point.altitude_ft) }));
  const contactAlt = landingNum(transition.altitude_ft);
  const direct = landingInt(transition.vertical_speed_fpm);
  if (direct !== undefined && direct !== 0) {
    return crossCheckTouchdownVs(direct, transition.ts, contactAlt, altHistory);
  }
  // P2: `vs_fpm === 0` на кадре контакта — не измеренное снижение. Сим часто
  // клампит его на земле; подставлять производную высоты/«утешительный» минимум
  // окна нельзя — это снова дало бы красивый балл фантому.
  if (direct === 0) {
    return { vsFpm: null, source: 'altitude', altitudeFpm: null };
  }
  const altitudeFpm = altitudeDerivedVs(transition.ts, contactAlt, altHistory);
  if (altitudeFpm !== null && altitudeFpm < 0) {
    return { vsFpm: altitudeFpm, source: 'altitude', altitudeFpm };
  }
  const descent = landingInt(fastestDescentPoint(sorted)?.vertical_speed_fpm);
  return {
    vsFpm: descent !== undefined && descent < 0 ? descent : null,
    source: 'sim',
    altitudeFpm: null,
  };
}

function vsConsistent(eventVs: number, trackVs: number): boolean {
  const tolerance = Math.max(50, Math.abs(trackVs) * 0.25);
  return Math.abs(eventVs - trackVs) <= tolerance;
}

/**
 * Минимальный (наибольший по модулю) `vs` в окне `windowS` до касания — та же
 * величина, из которой агент формирует **пик снижения** события `touchdown`
 * (`LandingTracker.buildMetrics` → `vsPeakFpm`, поле `vs_peak_fpm`; R5.7).
 * Нужна для сравнения «как с равным»: мгновенный `vs` точки перехода
 * систематически мягче оконного минимума, из-за чего реальные T&G получали
 * ложный SLEW.
 */
function fastestDescentVsInWindow(
  sorted: readonly LandingPoint[],
  anchorTs: string,
  windowS: number,
): number | null {
  const anchor = Date.parse(anchorTs);
  if (!Number.isFinite(anchor)) return null;
  let best: number | null = null;
  for (const point of sorted) {
    const ts = Date.parse(point.ts);
    if (!Number.isFinite(ts) || ts > anchor || ts < anchor - windowS * 1000) continue;
    if (point.vertical_speed_fpm === null) continue;
    if (best === null || point.vertical_speed_fpm < best) best = point.vertical_speed_fpm;
  }
  return best;
}

/** Событие `touchdown` противоречит треку (накрутка) → `SLEW`. */
function eventContradictsTrack(
  event: LandingEvent,
  transitionTs: string,
  eventVsTrack: number,
  trackG: number | null,
  trackPitch: number | null,
  trackBank: number | null,
  eventTsToleranceMs: number,
  eventGToleranceG: number,
  eventGRelativeTolerance: number,
): boolean {
  const d = event.data ?? {};
  // Сверяем с оконным минимумом (`eventVsTrack`) **пик снижения** события:
  // новый агент кладёт его в `vs_peak_fpm` (R5.7), старый — в `vs_fpm`
  // (fallback для уже записанных/офлайн-буферов событий).
  const eventVs = landingInt(d.vs_peak_fpm) ?? landingInt(d.vs_fpm);
  // Сравниваем с оконным минимумом (`eventVsTrack`), а не с мгновенным `vs`
  // точки перехода — так же считает агент (`LandingTracker.buildMetrics`).
  if (eventVs !== undefined && !vsConsistent(eventVs, eventVsTrack)) return true;
  const eventG = landingNum(d.g ?? d.g_force);
  if (eventG !== null && trackG !== null) {
    // Событие фиксируется до пика обжатия, поэтому «недооценка» `g` относительно
    // пика трека — физика выравнивания, а не подделка (T97).
    const gTolerance = Math.max(eventGToleranceG, Math.abs(trackG) * eventGRelativeTolerance);
    if (Math.abs(eventG - trackG) > gTolerance) return true;
  }
  const eventPitch = landingNum(d.pitch_deg);
  if (eventPitch !== null && trackPitch !== null && Math.abs(eventPitch - trackPitch) > 5) {
    return true;
  }
  const eventBank = landingNum(d.bank_deg);
  if (eventBank !== null && trackBank !== null && Math.abs(eventBank - trackBank) > 5) {
    return true;
  }
  const eventTs = Date.parse(event.ts);
  const seenTs = Date.parse(transitionTs);
  return (
    Number.isFinite(eventTs) &&
    Number.isFinite(seenTs) &&
    Math.abs(eventTs - seenTs) > eventTsToleranceMs
  );
}

const RUNWAY_ICAO_PATTERN = /^[A-Z0-9]{1,8}$/;

/** Ingested runway designators are untrusted: keep only the contract shape. */
function normaliseRunwayIcao(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toUpperCase();
  return RUNWAY_ICAO_PATTERN.test(text) ? text : undefined;
}

function eventMetrics(
  event: LandingEvent | null,
  vsFpm: number | null,
  gForce: number | null,
  pitchDeg: number | null,
  bankDeg: number | null,
  bounceCount: number,
): LandingMetricsResponse {
  const d = event?.data ?? {};
  return {
    vs_fpm: vsFpm === null ? null : Math.trunc(vsFpm),
    g_force: gForce,
    pitch_deg: pitchDeg ?? undefined,
    bank_deg: bankDeg ?? undefined,
    bounce_count: bounceCount,
    bounced: bounceCount > 0,
    centreline_offset_m: landingNum(d.centreline_offset_m) ?? undefined,
    touchdown_zone: landingZone(d.touchdown_zone),
    headwind_kt: landingNum(d.headwind_kt) ?? undefined,
    crosswind_kt: landingNum(d.crosswind_kt) ?? undefined,
    runway_icao: normaliseRunwayIcao(d.runway_icao) ?? normaliseRunwayIcao(d.runway),
  };
}

/**
 * Был ли перед касанием в `transitionIndex` реальный отрыв. Смотрим назад по
 * непрерывному участку `on_ground=false` и ищем признаки полёта через общий
 * `hasCredibleClimb`: достоверный набор высоты (`agl ≥ credibleLiftoffFt` при
 * движении/вертикали), либо — когда AGL недоступен — прежнее `hasFlightEvidence`
 * (движение/полётная скорость/вертикаль). Так bogus-airborne на старте сессии
 * (ВС на полосе: `gs ≈ 0`, `vs ≈ 0`, но `alt`/`agl` произвольны) не превращается
 * в ложную посадку, **и** взлётная пробежка (`gs ≥ 40`, `agl ≈ 0`) не создаёт
 * посадку на следующем `on_ground=true` (F: ложная посадка 98 на разбеге).
 *
 * Если ни `altitude_ft`, ни `groundspeed_kt` в треке нет — критерий неоценим,
 * считаем отрыв реальным (обратная совместимость).
 */
function confirmedLiftoffBefore(
  sorted: readonly LandingPoint[],
  transitionIndex: number,
  liftoffConfirmFt: number,
  liftoffConfirmGsKt: number,
  liftoffMoveKt: number,
  liftoffVerticalFpm: number,
  credibleLiftoffFt: number,
): boolean {
  const groundAlt = landingNum(sorted[transitionIndex]?.altitude_ft);
  let sawAltitude = false;
  let sawGs = false;
  for (let i = transitionIndex - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    if (!point || point.on_ground) break;
    const alt = landingNum(point.altitude_ft);
    if (alt !== null) sawAltitude = true;
    if (landingNum(point.groundspeed_kt) !== null) sawGs = true;
    const agl = alt !== null && groundAlt !== null ? alt - groundAlt : null;
    if (
      hasCredibleClimb(
        {
          on_ground: false,
          groundspeed_kt: point.groundspeed_kt,
          vertical_speed_fpm: point.vertical_speed_fpm,
          agl_ft: agl,
        },
        {
          altitudeFt: liftoffConfirmFt,
          flyingGsKt: liftoffConfirmGsKt,
          moveGsKt: liftoffMoveKt,
          verticalFpm: liftoffVerticalFpm,
          minAglFt: credibleLiftoffFt,
        },
      )
    ) {
      return true;
    }
  }
  return !sawAltitude && !sawGs;
}

/**
 * Индекс первого кадра устойчивого отрыва (`on_ground=false`) после касания:
 * воздушная фаза, в которой достигнут достоверный набор высоты
 * (`hasCredibleClimb`). Низкий подскок (< `credibleLiftoffFt`) устойчивым
 * отрывом не считается — это отскок, а не touch-and-go.
 */
function sustainedLiftoffIndex(
  sorted: readonly LandingPoint[],
  fromIndex: number,
  endIndex: number,
  liftoffConfirmFt: number,
  liftoffConfirmGsKt: number,
  liftoffMoveKt: number,
  liftoffVerticalFpm: number,
  credibleLiftoffFt: number,
): number | null {
  let groundAlt = landingNum(sorted[fromIndex]?.altitude_ft);
  for (let i = fromIndex + 1; i < endIndex; i += 1) {
    const point = sorted[i];
    if (!point) continue;
    if (point.on_ground) {
      groundAlt = landingNum(point.altitude_ft) ?? groundAlt;
      continue;
    }
    const runStart = i;
    let credible = false;
    for (; i < endIndex && !sorted[i]?.on_ground; i += 1) {
      const sample = sorted[i];
      if (!sample) continue;
      const alt = landingNum(sample.altitude_ft);
      const agl = alt !== null && groundAlt !== null ? alt - groundAlt : null;
      if (
        hasCredibleClimb(
          {
            on_ground: false,
            groundspeed_kt: sample.groundspeed_kt,
            vertical_speed_fpm: sample.vertical_speed_fpm,
            agl_ft: agl,
          },
          {
            altitudeFt: liftoffConfirmFt,
            flyingGsKt: liftoffConfirmGsKt,
            moveGsKt: liftoffMoveKt,
            verticalFpm: liftoffVerticalFpm,
            minAglFt: credibleLiftoffFt,
          },
        )
      ) {
        credible = true;
        break;
      }
    }
    if (credible) return runStart;
    // Пропускаем низкий подскок и продолжаем со следующего наземного кадра.
    const ground = sorted[i];
    if (ground?.on_ground) groundAlt = landingNum(ground.altitude_ft) ?? groundAlt;
  }
  return null;
}

/** Наблюдалось ли `gs < stopSpeedKt` дольше `stopDwellS` в диапазоне [from, to]. */
function detectStoppedOnGround(
  sorted: readonly LandingPoint[],
  fromIndex: number,
  toIndex: number,
  stopSpeedKt: number,
  stopDwellS: number,
): boolean {
  let runStartMs: number | null = null;
  for (let i = fromIndex; i <= toIndex; i += 1) {
    const point = sorted[i];
    if (!point) continue;
    const gs = point.groundspeed_kt;
    if (typeof gs === 'number' && Number.isFinite(gs) && gs < stopSpeedKt) {
      const ts = Date.parse(point.ts);
      if (runStartMs === null) {
        runStartMs = ts;
      } else if ((ts - runStartMs) / 1000 > stopDwellS) {
        return true;
      }
    } else {
      runStartMs = null;
    }
  }
  return false;
}

interface LandingGroup {
  firstIndex: number;
}

/**
 * Детерминированная сегментация посадок сессии (ADR-0010 §3). Чистая функция:
 * без I/O, `Date.now` и `Math.random`; вход сортируется `ORDER BY ts, seq`.
 *
 * - Касание = переход `air → ground` в достоверных точках трека.
 * - Достоверный отрыв (`hasCredibleClimb`, ≥ `credibleLiftoffFt`) отделяет одну
 *   посадку от другой. Низкий подскок достоверным отрывом не является.
 * - Повторное касание без достоверного отрыва в пределах `bounceMaxAirborneS`
 *   после предыдущего — отскок (атрибут текущей посадки, новой строки нет).
 *   Отскок достоверен только при подъёме AGL ≥ `bounceMinAglGainFt`, длительности
 *   ≥ `bounceMinAirborneS` и ≥ `bounceMinAirborneSamples` воздушных сэмплах
 *   (см. `BOUNCE_EVIDENCE`); иначе касания сливаются (`bounce_count=0`).
 * - Touch-and-go = **устойчивый** отрыв без полной остановки и выдержка
 *   ≤ `touchAndGoMaxGroundS`; низкий подскок не делает посадку touch-and-go.
 * - Последняя посадка без устойчивого отрыва: `touchAndGo=false`,
 *   `groundContactS=null`.
 * - Без перехода, но с событием `touchdown` с `vs_fpm` — одна неподтверждённая
 *   посадка (`verified=false`, `SLEW`), чтобы сохранить поведение single-landing.
 */
export function segmentLandings(
  events: readonly LandingEvent[],
  points: readonly LandingPoint[],
  options?: SegmentationOptions,
): LandingSegment[] {
  const cfg = { ...SEGMENTATION_DEFAULTS, ...options };
  const sorted = validLandingPoints(points);
  // Политика лидерборда: slew/телепорт гейтит только в `SLEW_ELIGIBILITY_WINDOW_S`
  // до касания. Ранний slew (смена стоянки и т.п.) остаётся в треке, но не
  // disqualifies всю сессию. Считаем локально для каждой посадки, а не по рейсу.
  // CLOCK_INVALID остаётся в `flags` как информационная заметка (не гейт).
  const localIntegrityFlags = (anchorTs: string): number => {
    const anchor = Date.parse(anchorTs);
    if (!Number.isFinite(anchor)) return 0;
    const from = anchor - SLEW_ELIGIBILITY_WINDOW_S * 1000;
    let firstIdx = sorted.findIndex((point) => Date.parse(point.ts) >= from);
    if (firstIdx === -1) firstIdx = sorted.length;
    // Одна точка до окна — чтобы детект скачка на границе видел пару.
    const startIdx = Math.max(0, firstIdx - 1);
    const subset = sorted
      .slice(startIdx)
      .filter((point) => Date.parse(point.ts) <= anchor)
      .map((point) => ({
        ts: point.ts,
        seq: point.seq,
        lat: point.latitude,
        lon: point.longitude,
        groundspeed_kt: point.groundspeed_kt,
        vertical_speed_fpm: point.vertical_speed_fpm,
        g_force: point.g_force,
        altitude_ft: point.altitude_ft,
      }));
    return analyzeTrackIntegrity(subset).flags;
  };

  const touchdownEvents = events
    .filter((e) => e.type === 'touchdown' || e.type === 'landing')
    .slice()
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const bounceEvents = events.filter((e) => e.type === 'bounce');
  const usedEventIndexes = new Set<number>();

  const rawTransitions: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const previous = sorted[i - 1];
    if (current?.on_ground && previous && !previous.on_ground) rawTransitions.push(i);
  }
  // Только переходы после реального отрыва: старт сессии на земле с транзиентным
  // `on_ground=false` не должен давать ложную посадку (синхронно агенту).
  const transitions = rawTransitions.filter((index) =>
    confirmedLiftoffBefore(
      sorted,
      index,
      cfg.liftoffConfirmFt,
      cfg.liftoffConfirmGsKt,
      cfg.liftoffMoveKt,
      cfg.liftoffVerticalFpm,
      cfg.credibleLiftoffFt,
    ),
  );

  const matchTouchdownEvent = (anchorTs: string, allowFallback: boolean): LandingEvent | null => {
    let bestIndex = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < touchdownEvents.length; i += 1) {
      if (usedEventIndexes.has(i)) continue;
      const candidate = touchdownEvents[i];
      if (!candidate) continue;
      const delta = Math.abs(Date.parse(candidate.ts) - Date.parse(anchorTs));
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = i;
      }
    }
    // Первой посадке событие-якорь доступно всегда (как раньше): расхождение
    // `ts` тогда фиксируется как `SLEW`, а не «теряется».
    if (bestIndex >= 0 && (bestDelta <= cfg.eventTsToleranceMs || allowFallback)) {
      usedEventIndexes.add(bestIndex);
      return touchdownEvents[bestIndex] ?? null;
    }
    return null;
  };

  const countBounceEvents = (fromTs: string, toTs: string | null): number => {
    const from = Date.parse(fromTs);
    const to = toTs === null ? Number.POSITIVE_INFINITY : Date.parse(toTs);
    return bounceEvents.filter((e) => {
      const ts = Date.parse(e.ts);
      return Number.isFinite(ts) && ts >= from && ts < to;
    }).length;
  };

  /**
   * Число **достоверных** отскоков после касания `fromIndex`. Воздушная фаза
   * считается отскоком только если набрала `bounceMinAglGainFt` над последним
   * касанием, длится не меньше `bounceMinAirborneS` и содержит не меньше
   * `bounceMinAirborneSamples` подряд идущих воздушных сэмплов. Иначе контакты
   * сливаются (дрожание `SIM ON GROUND` на 20 Гц — не отскок).
   */
  const countTrackBounces = (
    sortedPoints: readonly LandingPoint[],
    fromIndex: number,
    toIndex: number,
    maxAirborneS: number,
  ): number => {
    let count = 0;
    let lastContactTs = Date.parse(sortedPoints[fromIndex]?.ts ?? '');
    let groundAlt = landingNum(sortedPoints[fromIndex]?.altitude_ft);
    let airStartMs: number | null = null;
    let airSamples = 0;
    let maxAlt: number | null = null;
    for (let i = fromIndex + 1; i < toIndex; i += 1) {
      const point = sortedPoints[i];
      if (!point) continue;
      if (!point.on_ground) {
        if (airStartMs === null) {
          airStartMs = Date.parse(point.ts);
          airSamples = 0;
          maxAlt = null;
        }
        airSamples += 1;
        const alt = landingNum(point.altitude_ft);
        if (alt !== null) maxAlt = maxAlt === null ? alt : Math.max(maxAlt, alt);
        continue;
      }
      const ts = Date.parse(point.ts);
      const inAir = airStartMs !== null;
      const gain = maxAlt !== null && groundAlt !== null ? maxAlt - groundAlt : null;
      const durationS = airStartMs === null ? 0 : (ts - airStartMs) / 1000;
      const credibleHop =
        inAir &&
        airSamples >= cfg.bounceMinAirborneSamples &&
        durationS >= cfg.bounceMinAirborneS &&
        gain !== null &&
        gain >= cfg.bounceMinAglGainFt;
      if (credibleHop && Number.isFinite(ts) && Number.isFinite(lastContactTs)) {
        if ((ts - lastContactTs) / 1000 <= maxAirborneS) count += 1;
        lastContactTs = ts;
      }
      airStartMs = null;
      airSamples = 0;
      maxAlt = null;
      groundAlt = landingNum(point.altitude_ft) ?? groundAlt;
    }
    return count;
  };

  const segments: LandingSegment[] = [];

  if (transitions.length === 0) {
    // Переходы были, но все отброшены как недостоверные (нет реального отрыва):
    // это шум/транзиент, а не посадка — событию не доверяем.
    if (rawTransitions.length > 0) return segments;
    const event = touchdownEvents[0];
    const eventVs = event ? landingInt(event.data?.vs_fpm) : undefined;
    if (event && eventVs !== undefined) {
      const bounceCount = bounceEvents.length;
      segments.push({
        seq: 1,
        touchdownTs: event.ts,
        bounceCount,
        bounced: bounceCount > 0,
        groundContactS: null,
        stoppedOnGround: false,
        touchAndGo: false,
        verified: false,
        flags: localIntegrityFlags(event.ts) | QUALITY_BITS.SLEW,
        vsSource: 'sim',
        vsAltitudeFpm: null,
        metrics: eventMetrics(
          event,
          eventVs < 0 ? eventVs : null,
          landingNum(event.data?.g ?? event.data?.g_force),
          landingNum(event.data?.pitch_deg),
          landingNum(event.data?.bank_deg),
          bounceCount,
        ),
      });
    }
    return segments;
  }

  const groups: LandingGroup[] = transitions.map((index) => ({ firstIndex: index }));

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    if (!group) continue;
    const first = sorted[group.firstIndex];
    if (!first) continue;
    const trackVsResult = trackTouchdownVs(sorted, first);
    const trackVs = trackVsResult.vsFpm;
    const trackG = peakGAt(sorted, first.ts, cfg.metricWindowS) ?? landingNum(first.g_force);
    const trackPitch = landingNum(first.pitch_deg);
    const trackBank = landingNum(first.bank_deg);
    const matchedEvent = matchTouchdownEvent(first.ts, groups.length === 1);

    const nextGroup = groups[groupIndex + 1];
    const nextGroupFirst = nextGroup ? sorted[nextGroup.firstIndex] : undefined;
    const liftoffIndex = sustainedLiftoffIndex(
      sorted,
      group.firstIndex,
      nextGroup?.firstIndex ?? sorted.length,
      cfg.liftoffConfirmFt,
      cfg.liftoffConfirmGsKt,
      cfg.liftoffMoveKt,
      cfg.liftoffVerticalFpm,
      cfg.credibleLiftoffFt,
    );
    const bounceWindowEnd = nextGroupFirst?.ts ?? null;
    const trackBounceCount = countTrackBounces(
      sorted,
      group.firstIndex,
      nextGroup?.firstIndex ?? sorted.length,
      cfg.bounceMaxAirborneS,
    );
    const eventBounceCount = countBounceEvents(first.ts, bounceWindowEnd);
    const bounceCount = Math.max(trackBounceCount, eventBounceCount);

    if (trackVs === null) {
      // VS не измерена (`0`/положительная на кадре контакта) — посадка всё равно
      // остаётся: это реальный `air→ground` после достоверного отрыва. `null`
      // честно означает «нет замера»; событие (если есть) может дать VS.
      const eventVs = matchedEvent ? landingInt(matchedEvent.data?.vs_fpm) : undefined;
      const measuredEventVs = eventVs !== undefined && eventVs < 0 ? eventVs : null;
      segments.push({
        seq: segments.length + 1,
        touchdownTs: first.ts,
        bounceCount,
        bounced: bounceCount > 0,
        groundContactS: null,
        stoppedOnGround: false,
        touchAndGo: false,
        verified: false,
        flags: localIntegrityFlags(first.ts) | QUALITY_BITS.SLEW,
        vsSource: trackVsResult.source,
        vsAltitudeFpm: trackVsResult.altitudeFpm,
        metrics: eventMetrics(
          matchedEvent,
          measuredEventVs,
          trackG,
          trackPitch,
          trackBank,
          bounceCount,
        ),
      });
      continue;
    }

    let flags = localIntegrityFlags(first.ts);
    const eventVsTrack = fastestDescentVsInWindow(sorted, first.ts, cfg.eventVsWindowS) ?? trackVs;
    if (
      matchedEvent &&
      eventContradictsTrack(
        matchedEvent,
        first.ts,
        eventVsTrack,
        trackG,
        trackPitch,
        trackBank,
        cfg.eventTsToleranceMs,
        cfg.eventGToleranceG,
        cfg.eventGRelativeTolerance,
      )
    ) {
      flags |= QUALITY_BITS.SLEW;
    }

    const liftoff = liftoffIndex !== null ? sorted[liftoffIndex] : undefined;
    const groundContactS = liftoff
      ? Math.round((Date.parse(liftoff.ts) - Date.parse(first.ts)) / 1000)
      : null;
    const stoppedOnGround =
      liftoffIndex !== null
        ? detectStoppedOnGround(
            sorted,
            group.firstIndex,
            liftoffIndex,
            cfg.stopSpeedKt,
            cfg.stopDwellS,
          )
        : false;
    const touchAndGo =
      liftoff !== undefined &&
      !stoppedOnGround &&
      groundContactS !== null &&
      groundContactS <= cfg.touchAndGoMaxGroundS;

    const base = matchedEvent
      ? eventMetrics(matchedEvent, trackVs, trackG, trackPitch, trackBank, bounceCount)
      : {
          vs_fpm: Math.trunc(trackVs),
          g_force: trackG,
          pitch_deg: trackPitch ?? undefined,
          bank_deg: trackBank ?? undefined,
          bounce_count: bounceCount,
          bounced: bounceCount > 0,
        };

    segments.push({
      seq: segments.length + 1,
      touchdownTs: first.ts,
      bounceCount,
      bounced: bounceCount > 0,
      groundContactS,
      stoppedOnGround,
      touchAndGo,
      verified: true,
      flags,
      vsSource: trackVsResult.source,
      vsAltitudeFpm: trackVsResult.altitudeFpm,
      metrics: { ...base, vs_fpm: Math.trunc(trackVs), g_force: trackG },
      touchdown_lat: landingNum(first.latitude),
      touchdown_lon: landingNum(first.longitude),
    });
  }

  return segments;
}

/**
 * Выбор представительной посадки по политике flight-level (ADR-0010 §4).
 * `best`: `score DESC, touchdown_at DESC, seq DESC`; `last`: `seq` максимальный;
 * `avg` — как `best` (среднее хранится отдельно, `landing_scores.avg_score`).
 */
export function pickRepresentativeLanding<
  T extends { seq: number; score: number; touchdown_at: string },
>(landings: readonly T[], policy: 'best' | 'last' | 'avg' = 'best'): T | null {
  if (landings.length === 0) return null;
  if (policy === 'last') {
    return landings.reduce((a, b) => (b.seq > a.seq ? b : a));
  }
  return landings.reduce((a, b) => {
    if (b.score !== a.score) return b.score > a.score ? b : a;
    const aTs = Date.parse(a.touchdown_at);
    const bTs = Date.parse(b.touchdown_at);
    if (bTs !== aTs) return bTs > aTs ? b : a;
    return b.seq > a.seq ? b : a;
  });
}
