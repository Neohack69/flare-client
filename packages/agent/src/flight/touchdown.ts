import {
  landingMetricsResponseSchema,
  sanitizeOptionalNumber,
  TRACK_NUMBER_RULES,
  type LandingMetricsResponse,
} from '@flightlog/contracts';
import {
  BOUNCE_EVIDENCE,
  LIFTOFF_EVIDENCE,
  SEGMENTATION_DEFAULTS,
  circularMeanDeg,
  crossCheckTouchdownVs,
  hasCredibleClimb,
  isPlausibleCoordinate,
  scoreLanding,
  type LandingScore,
} from '@flightlog/scoring';

import type { TelemetrySample } from '../sim/types.js';
import { isImplausiblePositionJump } from './teleport.js';

export interface LandingTrackerOptions {
  /** Касание в пределах этого времени после предыдущего — отскок (с). */
  bounceMaxAirborneS?: number;
  /** Окно до касания для оценки vs/g (с). */
  preContactWindowS?: number;
  /** Максимальная выдержка на земле для touch-and-go (с). */
  touchAndGoMaxGroundS?: number;
  /** Выдержка `gs < stopSpeedKt` дольше этого времени = полная остановка (с). */
  stopDwellS?: number;
  /** Порог скорости «стоит на земле» (kt). */
  stopSpeedKt?: number;
  /**
   * Высота **опорной точки** (не колёс, FOQA-DATUM-1), выше которой отрыв
   * считается реальным (ft).
   */
  liftoffAglFt?: number;
  /**
   * Минимальный AGL опорной точки (ft), достигнутый за воздушную фазу, при
   * котором отрыв считается достоверным набором высоты (а не взлётной
   * пробежкой/подскоком). Пробежка (`gs ≥ 40`, `agl ≈ 0`) не набирает его →
   * отрыва и посадки нет. FOQA-DATUM-1: порог отсчитывается от опорной точки
   * (фактически = `D` ft высоты колёс меньше); поведение не менялось (см.
   * `@flightlog/scoring` `LIFTOFF_EVIDENCE.credibleAglFt`).
   */
  credibleLiftoffAglFt?: number;
  /** Минимальная длительность воздушной фазы от отрыва до касания (с). */
  minAirborneS?: number;
  /**
   * Достоверный подскок (отскок): минимальный прирост AGL над последним
   * касанием (ft) и минимальная длительность воздушной фазы (с). Короче/ниже —
   * дрожание `SIM ON GROUND`, касания сливаются (`bounceCount = 0`).
   */
  bounceMinAglGainFt?: number;
  bounceMinAirborneS?: number;
  bounceMinAirborneSamples?: number;
  /** «Арм-окно» старта сессии (с) для случая отсутствия AGL/vs (см. phases.ts). */
  armWindowS?: number;
  /** ICAO типа ВС для метрик скоринга. */
  aircraftIcao?: string;
}

const DEFAULT_OPTIONS: Required<Omit<LandingTrackerOptions, 'aircraftIcao'>> = {
  bounceMaxAirborneS: SEGMENTATION_DEFAULTS.bounceMaxAirborneS,
  preContactWindowS: 3,
  touchAndGoMaxGroundS: SEGMENTATION_DEFAULTS.touchAndGoMaxGroundS,
  stopDwellS: SEGMENTATION_DEFAULTS.stopDwellS,
  stopSpeedKt: SEGMENTATION_DEFAULTS.stopSpeedKt,
  liftoffAglFt: 10,
  credibleLiftoffAglFt: LIFTOFF_EVIDENCE.credibleAglFt,
  minAirborneS: LIFTOFF_EVIDENCE.minAirborneS,
  bounceMinAglGainFt: BOUNCE_EVIDENCE.minAglGainFt,
  bounceMinAirborneS: BOUNCE_EVIDENCE.minAirborneS,
  bounceMinAirborneSamples: BOUNCE_EVIDENCE.minAirborneSamples,
  armWindowS: 3,
};

/**
 * Минимум валидных/правдоподобных курсов в окне касания, ниже которого курс
 * касания не публикуется (`null`). **Дублирует серверную константу**
 * `TOUCHDOWN_HEADING_MIN_SAMPLES` (`apps/api/src/airports/resolve-landing-runway.ts`):
 * `medianTouchdownHeadingDeg` на `/complete` тоже возвращает `null` при меньшем
 * числе сэмплов. Паритет превью с `/complete` (R1, `score-preview.md` §5):
 * разряженное окно не должно давать `resolved=true` с торцом, который сервер
 * позже не выберет. При расхождении менять синхронно.
 */
export const TOUCHDOWN_HEADING_MIN_SAMPLES = 3;

export type TouchdownKind = 'touchdown' | 'bounce';

/**
 * Предпросмотр одной посадки сессии (ADR-0010). Авторитет — серверная
 * `segmentLandings`; агент ведёт тот же счётчик `seq`/отскоков для UX и буфера.
 */
export interface LandingPreview {
  /** Порядок касания в сессии, начиная с 1. */
  seq: number;
  /** Время первого касания посадки (ISO 8601 UTC). */
  touchdown_at: string;
  /** Время отрыва (ISO 8601 UTC); `null` — посадка ещё/уже на земле без отрыва. */
  liftoff_at: string | null;
  /** От касания до отрыва (с); `null` — отрыва не было. */
  groundContactS: number | null;
  /** Наблюдалась полная остановка (gs < stopSpeedKt дольше stopDwellS). */
  stoppedOnGround: boolean;
  /** Отрыв без полной остановки и с малой выдержкой на земле. */
  touchAndGo: boolean;
  /** Число отскоков этой посадки (не отдельные посадки). */
  bounceCount: number;
  metrics: LandingMetricsResponse;
  /** Предпросмотр балла (ADR-0004: авторитет — сервер). */
  score: LandingScore;
}

export interface TouchdownEvent {
  kind: TouchdownKind;
  ts: string;
  metrics: LandingMetricsResponse;
  /**
   * Координаты точки касания (кадр `air→ground`). Нужны серверному
   * предпросмотру балла (`score-preview.md` §4); `undefined` у старых
   * потребителей события — превью тогда не вызывается.
   */
  latitude?: number;
  longitude?: number;
  /**
   * Круговая средняя истинного курса в окне `preContactWindowS` до касания —
   * тот же вход, что `medianTouchdownHeadingDeg` на `/complete`. `null` — в окне
   * меньше `TOUCHDOWN_HEADING_MIN_SAMPLES` (=3) валидных/правдоподобных курсов
   * (тогда превью отправляет `heading_deg: null`, и сервер резолвит как
   * `/complete`, а не по одиночному кадру).
   */
  headingDeg?: number | null;
  /**
   * Пик снижения (наибольшая по модулю VS) в окне до касания, fpm (R5.7).
   * Отдельно от `metrics.vs_fpm` (= VS касания): сервер сравнивает это значение
   * с оконным минимумом трека в проверке согласованности события (SLEW).
   */
  vsPeakFpm: number;
  /** Предпросмотр балла (ADR-0004: авторитет — сервер). */
  score: LandingScore;
  /** Количество отскоков текущей посадки после этого события. */
  bounceCount: number;
  /** Порядковый номер посадки, к которой относится событие. */
  landingSeq: number;
  /** Признак touch-and-go текущей посадки (после отрыва). */
  touchAndGo: boolean;
}

function finiteValues(values: readonly (number | null)[]): number[] {
  return values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Детект касаний и сегментация посадок по переходам `SIM ON GROUND` (T9, ADR-0010).
 *
 * Метрики берутся из высокочастотного окна `preContactWindowS` перед касанием:
 * `vs_fpm` — **VS касания** (мгновенная вертикальная скорость точки перехода,
 * как у серверной `trackTouchdownVs`; ADR-0008), `g_force` — пиковая перегрузка
 * (ADR-0004: фиксированный вход). Пик снижения окна (наибольшая по модулю VS)
 * отдаётся отдельным полем `vsPeakFpm` и не подменяет `vs_fpm` (R5.7).
 *
 * Посадка регистрируется **только после реального отрыва** (`airborneConfirmed`):
 * `air→ground` без предшествующего достоверного `airborne` игнорируется. Иначе
 * транзиентный `SIM ON GROUND=false` на старте сессии (ВС на земле) давал ложную
 * посадку #1. Исключение — отскок: повторное касание в окне
 * `bounceMaxAirborneS` относится к текущей посадке и не требует нового отрыва,
 * но обязано быть **достоверным подскоком** (`BOUNCE_EVIDENCE`): AGL +1.5 ft,
 * ≥0.3 с и ≥3 воздушных сэмпла. Дрожание `SIM ON GROUND` (D1, LIRN) даёт
 * `bounceCount=0` — касания сливаются.
 *
 * Отрыв достоверен лишь при **наборе высоты** не ниже `credibleLiftoffAglFt`
 * (по умолчанию 30 ft) — взлётная пробежка с `on_ground=false`, `gs ≥ 40` и
 * `agl ≈ 0` не подтверждает отрыв. Касание фазы, **начавшейся на земле**,
 * дополнительно требует длительности не меньше `minAirborneS` (по умолчанию 10 с):
 * короткий мисдетект `SIM ON GROUND` не становится посадкой. Фаза, начавшаяся
 * **в воздухе** (наземного кадра до неё не было), гейт длительности не проходит —
 * короткий, но достоверный по AGL финальный сегмент засчитывается. Когда AGL
 * недоступен — прежнее доказательство (`hasFlightEvidence`).
 *
 * Группировка совпадает с серверной `segmentLandings`: повторное касание не
 * позже `bounceMaxAirborneS` после предыдущего — отскок той же посадки,
 * позже — новая посадка `seq+1`. Отрыв после касания помечается как
 * touch-and-go, если не было полной остановки и выдержка ≤ `touchAndGoMaxGroundS`.
 *
 * Телепорт-инвалидация: кадр `slew` и неправдоподобный скачок позиции помечают
 * сессию (`teleportedSinceGround`). Пока она помечена, отрыв не подтверждается,
 * поэтому slew, завершившийся в воздухе (короткий, длинный или начавшийся в
 * slew), не даёт ни отрыва, ни посадки. Флаг снимает только обработанный
 * наземный кадр — после него обычный полёт записывается штатно.
 */
export class LandingTracker {
  private readonly options: LandingTrackerOptions;
  private previousOnGround: boolean | null = null;
  private airborneConfirmed = false;
  private airborneEverConfirmed = false;
  private airborneSinceMs: number | null = null;
  /**
   * Текущая воздушная фаза началась «в воздухе» (первый обработанный кадр был
   * `on_ground=false`, наземного кадра до него не было). Тогда окно отсчитывается
   * от первого воздушного сэмпла, а гейт `minAirborneS` не применяется: короткий,
   * но достоверный финальный сегмент (старт записи в воздухе/поздний арм) не
   * должен терять реальную посадку. Фазы, начавшиеся на земле, гейт сохраняют.
   */
  private airbornePhaseStartedAirborne = false;
  /**
   * Максимальный AGL (ft) за текущую воздушную фазу и признак, что AGL вообще
   * наблюдался. Нужны, чтобы отличить реальный набор высоты от пробежки/подскока
   * (`agl ≈ 0`) и от трека без высоты (тогда действует прежнее доказательство).
   */
  private maxAglFtSinceLiftoff: number | null = null;
  private sawAglSinceLiftoff = false;
  /** Число подряд идущих воздушных сэмплов текущей фазы (дебонс отскока). */
  private airPhaseSamples = 0;
  /** AGL последнего касания (ft) — база прироста для достоверного подскока. */
  private lastTouchdownAglFt: number | null = null;
  private lastTouchdownMs: number | null = null;
  private groundStopRunStartMs: number | null = null;
  private window: TelemetrySample[] = [];
  private previousSample: TelemetrySample | null = null;
  /**
   * Сессия «инвалидирована телепортом»: был slew/неправдоподобный скачок и с тех
   * пор не обработано ни одного наземного кадра. Пока флаг стоит, достоверный
   * отрыв не подтверждается — slew, завершившийся в воздухе, не фабрикует рейс.
   * Снимается только на обработанном кадре `on_ground === true`.
   */
  private teleportedSinceGround = false;
  private readonly landingList: LandingPreview[] = [];

  constructor(options: Partial<LandingTrackerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get landings(): readonly LandingPreview[] {
    return this.landingList;
  }

  get landingCount(): number {
    return this.landingList.length;
  }

  get touchAndGoCount(): number {
    return this.landingList.filter((landing) => landing.touchAndGo).length;
  }

  get currentBounceCount(): number {
    return this.current()?.bounceCount ?? 0;
  }

  get hasTouchdown(): boolean {
    return this.landingList.length > 0;
  }

  /** Был ли в сессии хотя бы один достоверный отрыв (реальный полёт). */
  get hasConfirmedLiftoff(): boolean {
    return this.airborneEverConfirmed;
  }

  /** Текущее состояние: на земле или в воздухе (по достоверному отрыву). */
  get onGround(): boolean {
    if (this.previousOnGround !== false) return true;
    return !this.airborneConfirmed;
  }

  /** Установить ICAO типа ВС, определённый из SimVars на старте рейса (ADR-0008). */
  setAircraftIcao(icao: string): void {
    this.options.aircraftIcao = icao;
  }

  reset(): void {
    this.previousOnGround = null;
    this.airborneConfirmed = false;
    this.airborneEverConfirmed = false;
    this.airborneSinceMs = null;
    this.airbornePhaseStartedAirborne = false;
    this.maxAglFtSinceLiftoff = null;
    this.sawAglSinceLiftoff = false;
    this.airPhaseSamples = 0;
    this.lastTouchdownAglFt = null;
    this.lastTouchdownMs = null;
    this.groundStopRunStartMs = null;
    this.window = [];
    this.previousSample = null;
    this.teleportedSinceGround = false;
    this.landingList.length = 0;
  }

  update(sample: TelemetrySample): TouchdownEvent[] {
    // Кадр slew (IS SLEW ACTIVE) — не полёт: пропускаем без изменения состояния и
    // без добавления в окно, `previousSample` остаётся до-slew кадром. С slew
    // сессия считается инвалидированной до первого настоящего наземного кадра.
    if (sample.slew) {
      this.teleportedSinceGround = true;
      return [];
    }
    // Кадр сразу после выключения slew: позиция уже ушла, флаг сброшен. Один
    // такой кадр пропускаем, приняв новую позицию за базу (иначе флаг «залипнет»),
    // и тоже инвалидируем сессию.
    if (isImplausiblePositionJump(this.previousSample, sample)) {
      this.teleportedSinceGround = true;
      this.previousSample = sample;
      return [];
    }
    this.previousSample = sample;
    this.pushToWindow(sample);

    const wasOnGround = this.previousOnGround;
    const isOnGround = sample.on_ground;
    const nowMs = Date.parse(sample.ts);
    const events: TouchdownEvent[] = [];

    // Обработанный наземный кадр — единственное доказательство, что телепорт
    // завершился на земле; снимаем инвалидацию (п. «clear only on ground»).
    if (isOnGround) this.teleportedSinceGround = false;

    this.trackGroundDwell(isOnGround, sample, nowMs);

    if (isOnGround) {
      // Отскок относится к уже подтверждённой посадке и допускается без нового
      // отрыва; «новая» посадка — только после достоверного airborne.
      const isBounceCandidate =
        this.lastTouchdownMs !== null &&
        nowMs - this.lastTouchdownMs <= (this.options.bounceMaxAirborneS ?? 0) * 1000;
      // Дрожание `SIM ON GROUND` (1–2 сэмпла, +0.1…0.8 ft AGL) — не подскок:
      // касания сливаются, события/`bounceCount` нет (синхронно серверу).
      // Подтверждённый отрыв (реальный полёт) — уже не отскок, а новая посадка
      // (как `segmentLandings`: достоверный liftoff начинает новую группу).
      const credibleBounce =
        isBounceCandidate && !this.airborneConfirmed && this.isCredibleHop(sample, nowMs);
      if (wasOnGround === false && (this.airborneConfirmed || credibleBounce)) {
        // Отскок — атрибут текущей посадки. Первое касание фазы эмитим только
        // если отрыв был достоверным: набор высоты выше порога и достаточная
        // длительность в воздухе. Иначе это шум SIM ON GROUND (пробежка/подскок)
        // — сбрасываем `airborneConfirmed` и не создаём `LandingPreview`.
        if (credibleBounce || this.isCredibleAirbornePhase(nowMs)) {
          const event = this.handleTouchdown(sample, nowMs, credibleBounce);
          if (event) events.push(event);
        }
      }
      this.airborneConfirmed = false;
      this.airborneSinceMs = null;
      this.airbornePhaseStartedAirborne = false;
      this.maxAglFtSinceLiftoff = null;
      this.sawAglSinceLiftoff = false;
      this.airPhaseSamples = 0;
    } else {
      if (this.airborneSinceMs === null) {
        this.airborneSinceMs = nowMs;
        // Наземного кадра до этой фазы не было (`wasOnGround === null`) — запись
        // стартовала в воздухе; окно отсчитывается от первого воздушного сэмпла.
        this.airbornePhaseStartedAirborne = wasOnGround === null;
        this.maxAglFtSinceLiftoff = null;
        this.sawAglSinceLiftoff = false;
        this.airPhaseSamples = 0;
      }
      this.airPhaseSamples += 1;
      const agl = sample.agl_ft;
      if (typeof agl === 'number' && Number.isFinite(agl)) {
        this.sawAglSinceLiftoff = true;
        this.maxAglFtSinceLiftoff = Math.max(this.maxAglFtSinceLiftoff ?? agl, agl);
      }
      if (!this.airborneConfirmed && this.isConfirmedAirborne(sample, nowMs)) {
        this.airborneConfirmed = true;
        this.airborneEverConfirmed = true;
        // Отрыв: закрываем текущую посадку (T&G либо продолжение полёта) и
        // начинаем новое окно замера (сбрасываем зашумлённое предыдущее касание).
        this.handleLiftoff(sample, nowMs);
        this.window = [sample];
      }
    }

    this.previousOnGround = isOnGround;
    return events;
  }

  /**
   * Достоверный отрыв: **набор высоты** выше `credibleLiftoffAglFt` при
   * движении/вертикали (общий с сервером `hasCredibleClimb`). Одной полётной
   * скорости недостаточно: на разбеге `on_ground=false`, `gs ≥ 40`, `agl ≈ 0`
   * — это ещё не отрыв. Когда AGL недоступен, действует прежнее доказательство
   * (`hasFlightEvidence`); при отсутствии и AGL, и `vs` — устойчивый
   * `on_ground=false` дольше арм-окна (транзиент старта так не проходит).
   */
  private isConfirmedAirborne(sample: TelemetrySample, nowMs: number): boolean {
    // Телепорт/slew без последующего наземного кадра — отрыв недостоверен.
    if (this.teleportedSinceGround) return false;
    const { agl_ft: agl, vs_fpm: vs } = sample;
    if (agl === null && vs === null) {
      // Оба сигнала недоступны: считаем отрыв достоверным лишь при устойчивом
      // `on_ground=false` дольше арм-окна (транзиент старта так не проходит).
      const since = this.airborneSinceMs;
      return since !== null && nowMs - since >= (this.options.armWindowS ?? 0) * 1000;
    }
    return hasCredibleClimb(
      {
        on_ground: sample.on_ground,
        groundspeed_kt: sample.gs_kt,
        vertical_speed_fpm: sample.vs_fpm,
        agl_ft: sample.agl_ft,
      },
      {
        altitudeFt: this.options.liftoffAglFt,
        minAglFt: this.options.credibleLiftoffAglFt,
      },
    );
  }

  /**
   * Достоверность воздушной фазы к моменту касания: — если AGL за фазу
   * наблюдался — набор высоты не ниже `credibleLiftoffAglFt` (общий с сервером
   * критерий отделения). Пробежка/подскок/мисдетект `SIM ON GROUND` дают
   * `agl ≈ 0` → не посадка. Плюс гейт `minAirborneS` для фаз, **начавшихся на
   * земле**: короткий отрыв с земли не превращается в посадку.
   *
   * Для фазы, начавшейся **в воздухе** (запись стартовала уже в полёте/поздний
   * арм — наземного кадра до неё не было), гейт длительности **не применяется**:
   * его отсчёт от первого воздушного сэмпла иначе подавлял бы реальную посадку
   * на коротком финальном отрезке. Достоверность держит проверка AGL.
   */
  private isCredibleAirbornePhase(nowMs: number): boolean {
    const since = this.airborneSinceMs;
    if (since === null) return false;
    if (
      !this.airbornePhaseStartedAirborne &&
      (nowMs - since) / 1000 < (this.options.minAirborneS ?? 0)
    ) {
      return false;
    }
    return (
      !this.sawAglSinceLiftoff ||
      (this.maxAglFtSinceLiftoff ?? 0) >= (this.options.credibleLiftoffAglFt ?? 0)
    );
  }

  /**
   * Достоверный подскок (отскок) между двумя касаниями: прирост AGL над
   * последним касанием ≥ `bounceMinAglGainFt`, длительность ≥
   * `bounceMinAirborneS` и ≥ `bounceMinAirborneSamples` воздушных сэмплов.
   * Дрожание `SIM ON GROUND` на 20 Гц (+0.1…0.8 ft, 1–2 сэмпла) не проходит —
   * касания сливаются в одну посадку. Синхронно серверной `segmentLandings`.
   */
  private isCredibleHop(sample: TelemetrySample, nowMs: number): boolean {
    const since = this.airborneSinceMs;
    if (since === null) return false;
    if (this.airPhaseSamples < (this.options.bounceMinAirborneSamples ?? 0)) return false;
    if ((nowMs - since) / 1000 < (this.options.bounceMinAirborneS ?? 0)) return false;
    const contactAgl = this.lastTouchdownAglFt;
    const agl =
      typeof sample.agl_ft === 'number' && Number.isFinite(sample.agl_ft) ? sample.agl_ft : null;
    const peakAgl = this.maxAglFtSinceLiftoff ?? agl;
    if (contactAgl === null || peakAgl === null) return false;
    return peakAgl - contactAgl >= (this.options.bounceMinAglGainFt ?? 0);
  }

  private handleTouchdown(
    sample: TelemetrySample,
    nowMs: number,
    credibleBounce: boolean,
  ): TouchdownEvent | null {
    // Достоверный `air→ground` — посадка, независимо от знака `vs` и значения
    // `g` на кадре контакта. Оба сима часто отдают `vs=0`/`g=1.00` на земле:
    // это неизмеренное значение, а не отсутствие касания. `vs>=0` → `null`,
    // `g<1.0` сохраняется как есть (скоринг/показ считают его неизмеренным).
    const measured = this.measuredContact(sample);

    const isBounce = credibleBounce;

    if (isBounce) {
      const landing = this.current();
      if (landing) {
        landing.bounceCount += 1;
        // Короткий подскок — не отрыв: реального touch-and-go ещё не было.
        landing.liftoff_at = null;
        landing.groundContactS = null;
        landing.touchAndGo = false;
      }
    } else {
      const first = this.buildMetrics(sample, 0, measured);
      this.landingList.push({
        seq: this.landingList.length + 1,
        touchdown_at: sample.ts,
        liftoff_at: null,
        groundContactS: null,
        stoppedOnGround: false,
        touchAndGo: false,
        bounceCount: 0,
        metrics: first.metrics,
        score: scoreLanding(first.metrics),
      });
      this.groundStopRunStartMs = null;
    }

    const landing = this.current();
    const bounceCount = landing?.bounceCount ?? 0;
    const built = this.buildMetrics(sample, bounceCount, measured);
    if (landing) {
      landing.metrics = built.metrics;
      landing.score = scoreLanding(built.metrics);
    }
    this.lastTouchdownMs = nowMs;
    this.lastTouchdownAglFt =
      typeof sample.agl_ft === 'number' && Number.isFinite(sample.agl_ft) ? sample.agl_ft : null;

    return {
      kind: isBounce ? 'bounce' : 'touchdown',
      ts: sample.ts,
      metrics: built.metrics,
      latitude: sample.lat,
      longitude: sample.lon,
      headingDeg: this.touchdownHeadingDeg(),
      vsPeakFpm: built.vsPeakFpm,
      score: landing?.score ?? scoreLanding(built.metrics),
      bounceCount,
      landingSeq: landing?.seq ?? 1,
      touchAndGo: landing?.touchAndGo ?? false,
    };
  }

  /**
   * Круговая средняя истинного курса в окне до касания (`preContactWindowS` = ±3 с
   * — тот же вход, что `medianTouchdownHeadingDeg` на `/complete`). В окно
   * попадают только курсы кадров с правдоподобными координатами
   * (`isPlausibleCoordinate` — общий с сервером отсев sentinel/вне диапазона);
   * при меньшем числе валидных сэмплов, чем `TOUCHDOWN_HEADING_MIN_SAMPLES`,
   * возвращается `null` — ровно как сервер. Мгновенный курс кадра касания как
   * fallback **не** используется: одиночный/разряженный кадр не должен давать
   * `resolved=true` с торцом, который `/complete` не выберет (R1).
   */
  private touchdownHeadingDeg(): number | null {
    const headings = this.window
      .filter((item) => isPlausibleCoordinate(item.lat, item.lon))
      .map((item) => item.heading_deg)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (headings.length < TOUCHDOWN_HEADING_MIN_SAMPLES) return null;
    return circularMeanDeg(headings);
  }

  private handleLiftoff(sample: TelemetrySample, nowMs: number): void {
    const landing = this.current();
    if (!landing || landing.liftoff_at !== null) return;
    const touchdownMs = Date.parse(landing.touchdown_at);
    if (!Number.isFinite(touchdownMs)) return;
    const groundContactS = Math.max(0, Math.round((nowMs - touchdownMs) / 1000));
    landing.liftoff_at = sample.ts;
    landing.groundContactS = groundContactS;
    landing.touchAndGo =
      !landing.stoppedOnGround &&
      groundContactS <= (this.options.touchAndGoMaxGroundS ?? Number.POSITIVE_INFINITY);
  }

  private trackGroundDwell(isOnGround: boolean, sample: TelemetrySample, nowMs: number): void {
    if (!isOnGround) {
      this.groundStopRunStartMs = null;
      return;
    }
    const landing = this.current();
    if (!landing) return;
    if (sample.gs_kt < (this.options.stopSpeedKt ?? 1)) {
      if (this.groundStopRunStartMs === null) {
        this.groundStopRunStartMs = nowMs;
      } else if ((nowMs - this.groundStopRunStartMs) / 1000 > (this.options.stopDwellS ?? 5)) {
        landing.stoppedOnGround = true;
      }
    } else {
      this.groundStopRunStartMs = null;
    }
  }

  private current(): LandingPreview | undefined {
    return this.landingList[this.landingList.length - 1];
  }

  private pushToWindow(sample: TelemetrySample): void {
    this.window.push(sample);
    const windowS = this.options.preContactWindowS ?? 3;
    const cutoff = Date.parse(sample.ts) - windowS * 1000;
    const trimmed = this.window.filter((item) => Date.parse(item.ts) >= cutoff);
    this.window = trimmed.length > 0 ? trimmed : [sample];
  }

  /**
   * Метрики контакта из кадра `air→ground`. Касание не отбрасывается по знаку
   * `vs`/величине `g`:
   * - `vs >= 0` (включая клампнутый `0`) — неизмеренное снижение → `null`;
   * - `g` не число → `null`, иначе сохраняется как есть (в т.ч. `< 1.0`).
   */
  private measuredContact(sample: TelemetrySample): {
    vsFpm: number | null;
    gForce: number | null;
  } {
    const rawVs = sanitizeOptionalNumber(sample.vs_fpm, TRACK_NUMBER_RULES.vs_fpm) ?? null;
    let vsFpm: number | null = null;
    if (rawVs === null) {
      const derived = this.touchdownVs(sample);
      vsFpm = derived !== null && derived < 0 ? derived : null;
    } else if (rawVs < 0) {
      const measured = this.touchdownVs(sample);
      vsFpm = measured !== null && measured < 0 ? measured : null;
    }
    // Валидность касания — по кадру касания, а не по пику окна: подскок/шум
    // до касания не должен «вытянуть» g выше 1.0.
    const gForce = round2(sample.g);
    return { vsFpm, gForce: Number.isFinite(gForce) ? gForce : null };
  }

  private buildMetrics(
    sample: TelemetrySample,
    bounceCount: number,
    measured: { vsFpm: number | null; gForce: number | null },
  ): { metrics: LandingMetricsResponse; vsPeakFpm: number } {
    const vsCandidates = finiteValues(this.window.map((item) => item.vs_fpm));
    const vsPeakFpm = vsCandidates.length > 0 ? Math.min(...vsCandidates) : (sample.vs_fpm ?? 0);

    const metrics = landingMetricsResponseSchema.parse({
      vs_fpm: measured.vsFpm,
      g_force: measured.gForce,
      pitch_deg: sample.pitch_deg,
      bank_deg: sample.bank_deg,
      bounce_count: bounceCount,
      bounced: bounceCount > 0,
      aircraft_icao: this.options.aircraftIcao,
    });

    return { metrics, vsPeakFpm: Math.round(vsPeakFpm) };
  }

  /**
   * VS касания — величина, из которой сервер формирует `metrics.vs_fpm`
   * (`trackTouchdownVs`): **сырой** `vs_fpm` кадра перехода `air→ground`; при его
   * отсутствии — производная высоты по предыдущей точке окна; в крайнем случае —
   * наибольшее снижение в окне. Значение не интерполируется и не усредняется по
   * соседним сэмплам (иначе sink в момент касания сглаживался бы в сторону более
   * мягкого). Санитайз (округление/кламп) совпадает с записью точки трека,
   * поэтому клиентское значение равно серверному (R5.7, ADR-0008).
   *
   * D1: перед выбором — cross-check с регрессией высоты (`altitude_ft` за
   * 1.5 с до касания). При расхождении >15% (|sim VS| >50 fpm) берётся высота;
   * окно высоты негодное — остаётся sim (не фабрикуем).
   */
  private touchdownVs(sample: TelemetrySample): number | null {
    const history = this.window
      .filter((item) => item !== sample)
      .map((item) => ({ ts: item.ts, altitude_ft: item.alt_ft }));
    const direct = sanitizeOptionalNumber(sample.vs_fpm, TRACK_NUMBER_RULES.vs_fpm) ?? null;
    if (direct !== null && direct !== 0) {
      const checked = crossCheckTouchdownVs(direct, sample.ts, sample.alt_ft, history);
      if (checked.vsFpm !== null) return checked.vsFpm;
    }
    // P2: `0` — не измеренный sink rate. Пробуем восстановить VS по высоте,
    // но никогда не подставляем «идеальный ноль» и не берём оконный минимум.
    if (direct === 0) {
      const fromAltitude = crossCheckTouchdownVs(null, sample.ts, sample.alt_ft, history);
      return fromAltitude.vsFpm !== null && fromAltitude.vsFpm < 0
        ? fromAltitude.vsFpm
        : null;
    }
    const checked = crossCheckTouchdownVs(null, sample.ts, sample.alt_ft, history);
    if (checked.vsFpm !== null && checked.vsFpm < 0) return checked.vsFpm;

    const vsCandidates = finiteValues(this.window.map((item) => item.vs_fpm));
    if (vsCandidates.length === 0) return null;
    const peak = Math.round(Math.min(...vsCandidates));
    return peak < 0 ? peak : null;
  }
}

/** Прежнее имя трекера (обратная совместимость); семантика — `LandingTracker`. */
export { LandingTracker as TouchdownTracker };
export type { LandingTrackerOptions as TouchdownTrackerOptions };
