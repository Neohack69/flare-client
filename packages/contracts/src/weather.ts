import { z } from 'zod';

/**
 * Погодные SimVars (только чтение), снятые в точке телеметрии/касания.
 *
 * Все поля nullable: рейсы и моки без погоды дают `null`, а не «0»
 * (обратная совместимость, T-weather). `wind_dir_deg` — метеорологическое
 * направление (откуда дует, относительно истинного севера), `precip` — код
 * `AMBIENT PRECIP STATE` (2 = нет, 4 = дождь, 8 = снег), `visibility_m` —
 * `AMBIENT VISIBILITY` в метрах.
 *
 * `wind_gust_kt` в MSFS SimVars отсутствует (нет отдельной переменной порыва —
 * `AMBIENT WIND VELOCITY` уже включает порывы); поле зарезервировано под
 * источники, где порыв доступен, иначе `null`.
 */
export const weatherSampleShape = {
  wind_dir_deg: z.number().finite().min(0).max(360).nullish(),
  wind_speed_kt: z.number().finite().nonnegative().nullish(),
  wind_gust_kt: z.number().finite().nonnegative().nullish(),
  temp_c: z.number().finite().nullish(),
  qnh_hpa: z.number().finite().nullish(),
  precip: z.number().int().nonnegative().nullish(),
  visibility_m: z.number().finite().nonnegative().nullish(),
} as const;

export const weatherSampleSchema = z.object(weatherSampleShape).strict();
export type WeatherSample = z.output<typeof weatherSampleSchema>;
export type WeatherSampleInput = z.input<typeof weatherSampleSchema>;

/**
 * Сводка погоды рейса (`flights.weather`): снимки на взлёте и касании плюс
 * агрегаты по всему треку. Считается сервером при `/complete`; `null`-поля —
 * нет данных (старые рейсы, погода не читалась).
 */
export const flightWeatherSummarySchema = z
  .object({
    /** Первая наблюдённая погода (начало записи). */
    takeoff: weatherSampleSchema.nullable(),
    /** Погода, ближайшая к касанию представительной посадки. */
    touchdown: weatherSampleSchema.nullable(),
    avg_wind_dir_deg: z.number().finite().min(0).max(360).nullable(),
    avg_wind_speed_kt: z.number().finite().nonnegative().nullable(),
    max_wind_speed_kt: z.number().finite().nonnegative().nullable(),
    max_wind_gust_kt: z.number().finite().nonnegative().nullable(),
    avg_temp_c: z.number().finite().nullable(),
    avg_qnh_hpa: z.number().finite().nullable(),
    min_visibility_m: z.number().finite().nonnegative().nullable(),
    precip_max: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type FlightWeatherSummary = z.output<typeof flightWeatherSummarySchema>;
export type FlightWeatherSummaryInput = z.input<typeof flightWeatherSummarySchema>;
