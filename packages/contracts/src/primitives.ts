import { z } from 'zod';

/** ISO 8601 timestamp in UTC. Accepts suffix "Z" or "±00:00". */
export const utcDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => /(?:Z|[+-]00:00)$/.test(value), {
    message: 'must be an ISO 8601 timestamp in UTC (suffix "Z" or "±00:00")',
  });
export type UtcDateTime = z.output<typeof utcDateTimeSchema>;

/** UUID v4 (RFC 4122). */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const uuidSchema = z.string().regex(UUID_V4_RE, 'must be a UUID v4');
export type Uuid = z.output<typeof uuidSchema>;

/** Semantic version, e.g. "1.0.0". */
export const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'must be a semantic version (x.y.z)');
export type Semver = z.output<typeof semverSchema>;

/** ICAO airport code (4 uppercase alphanumeric characters). */
export const airportIcaoSchema = z
  .string()
  .regex(/^[A-Z0-9]{4}$/, 'must be a 4-char ICAO airport code');
export type AirportIcao = z.output<typeof airportIcaoSchema>;

/** ICAO aircraft type code (2-4 uppercase alphanumeric characters). */
export const aircraftIcaoSchema = z
  .string()
  .regex(/^[A-Z0-9]{2,4}$/, 'must be an ICAO aircraft type code (2-4 chars)');
export type AircraftIcao = z.output<typeof aircraftIcaoSchema>;

/** Callsign (short sanitized string, max 16 chars per llm-layer.md §8). */
export const callsignSchema = z.string().trim().min(1).max(16);
export type Callsign = z.output<typeof callsignSchema>;

/** Latitude in decimal degrees. */
export const latitudeSchema = z.number().finite().min(-90).max(90);
export type Latitude = z.output<typeof latitudeSchema>;

/** Longitude in decimal degrees. */
export const longitudeSchema = z.number().finite().min(-180).max(180);
export type Longitude = z.output<typeof longitudeSchema>;

/** E-mail address. */
export const emailSchema = z.string().email().max(254);
export type Email = z.output<typeof emailSchema>;

/**
 * Отображаемое имя пилота (ADR-0020 §2.1 / IDN-07): свернуть пробелы + trim,
 * 1..64, без control (`\p{Cc}`) и bidi-override. Unicode (вкл. эмодзи) разрешён;
 * ZWJ (`U+200D`) не запрещаем — иначе ломаются составные эмодзи.
 */
export const displayNameSchema = z
  .string()
  .transform((v) => v.replace(/\s+/gu, ' ').trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(64)
      .refine((v) => !/\p{Cc}/u.test(v), 'no control characters')
      .refine((v) => !/[\u202A-\u202E\u2066-\u2069]/u.test(v), 'no bidi overrides'),
  );
export type DisplayName = z.output<typeof displayNameSchema>;

/**
 * URL, открываемый во внешнем браузере/навигации: только `https:`.
 * Исключение — loopback (`http://localhost`/`127.0.0.1`/`[::1]`) для dev-сборки,
 * чтобы не ломать локальный device flow (F-105); любой другой `http:` отвергается.
 */
export const httpsUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      if (value.startsWith('https://')) return true;
      try {
        const url = new URL(value);
        return (
          url.protocol === 'http:' &&
          (url.hostname === 'localhost' ||
            url.hostname === '127.0.0.1' ||
            url.hostname === '[::1]')
        );
      } catch {
        return false;
      }
    },
    { message: 'must be an https URL (http allowed only for loopback in development)' },
  );
export type HttpsUrl = z.output<typeof httpsUrlSchema>;
