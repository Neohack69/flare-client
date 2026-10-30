import { z } from 'zod';

import {
  aircraftIcaoSchema,
  airportIcaoSchema,
  latitudeSchema,
  longitudeSchema,
  semverSchema,
  utcDateTimeSchema,
} from './primitives.js';
import { landingMetricsResponseSchema, scoreComponentsSchema, scoreGradeSchema } from './scoring.js';
import { runwaySchema } from './runway.js';

/**
 * Серверный предпросмотр балла касания (ADR-0004 §2, `score-preview.md`).
 *
 * Контракт аддитивный и **никогда не авторитетный**: авторитет — пересчёт на
 * `/complete` из хранимого трека. Здесь клиент присылает данные касания,
 * сервер считает тот же `scoreLanding`, но с геометрией ВПП (центр/зона),
 * которую клиент без ВПП знать не может. Запрос/ответ без PII и токенов.
 *
 * Геометрия (`centreline_offset_m`/`touchdown_zone`) в запросе **отсутствует
 * намеренно** (`.strict()` их отвергает): она всегда вычисляется сервером из
 * позиции касания и ВПП, поэтому клиентские значения не могут повлиять на балл
 * (`score-preview.md` §3, R4).
 */
export const touchdownPreviewRequestSchema = z
  .object({
    /** Порядок касания в сессии (с 1), совпадает с `seq` посадки. */
    seq: z.number().int().min(1),
    /** Якорь времени касания, совпадает с `ts` события агента. */
    touchdown_at: utcDateTimeSchema,
    /** Широта точки касания. */
    lat: latitudeSchema,
    /** Долгота точки касания. */
    lon: longitudeSchema,
    /**
     * Истинный курс касания (круговая средняя ±3 с), град. `null` — в окне
     * меньше `TOUCHDOWN_HEADING_MIN_SAMPLES` (=3) валидных/правдоподобных
     * курсов. Тогда сервер не подбирает торец (как `/complete`), возвращает
     * `resolved=false`, а клиент держит метку «предварительно» — курс не
     * подменяется мгновенным значением кадра касания.
     */
    heading_deg: z.number().finite().min(0).max(360).nullable(),
    /** Вертикальная скорость касания, fpm (`PLAUSIBILITY_LIMITS`). */
    vs_fpm: z.number().int().min(-6000).max(6000),
    /** Пиковая перегрузка касания (`PLAUSIBILITY_LIMITS`). */
    g_force: z.number().finite().min(0).max(5),
    pitch_deg: z.number().finite().min(-90).max(90).nullish(),
    bank_deg: z.number().finite().min(-90).max(90).nullish(),
    bounce_count: z.number().int().nonnegative().max(64).default(0),
    /** Тип ВС (для порогов); hint, не источник геометрии. */
    aircraft_icao: aircraftIcaoSchema.nullish(),
    /** Обозначение ВПП; hint — доверяем только при точном совпадении с БД. */
    runway_icao: z.string().trim().min(1).max(8).nullish(),
    /**
     * Аэропорт; hint — **только fallback**, когда сервер не разрешил аэропорт
     * (`destination_icao` рейса пуст и рядом с точкой касания аэропорта нет).
     * Никогда не перекрывает определённый назначением аэропорт (`/complete`
     * приоритет не меняет) — паритет `score-preview.md` §5.
     */
    airport_icao: airportIcaoSchema.nullish(),
  })
  .strict();
export type TouchdownPreviewRequest = z.output<typeof touchdownPreviewRequestSchema>;
export type TouchdownPreviewRequestInput = z.input<typeof touchdownPreviewRequestSchema>;

export const touchdownPreviewResponseSchema = z
  .object({
    data: z
      .object({
        seq: z.number().int().min(1),
        score: z.number().int().min(0).max(100),
        grade: scoreGradeSchema,
        components: scoreComponentsSchema,
        score_version: semverSchema,
        segmentation_version: semverSchema,
        /** Контрактно: результат предпросмотра никогда не авторитетен. */
        preliminary: z.literal(true),
        /** `false` — геометрия ВПП не применена (см. `score-preview.md` §3). */
        resolved: z.boolean(),
        runway: runwaySchema.nullable(),
        /** Эффективные серверные метрики: геометрия ВПП слита поверх клиентских. */
        metrics: landingMetricsResponseSchema,
      })
      .strict(),
  })
  .strict();
export type TouchdownPreviewResponse = z.output<typeof touchdownPreviewResponseSchema>;
