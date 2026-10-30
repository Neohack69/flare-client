import { z } from 'zod';

import { httpsUrlSchema, semverSchema, utcDateTimeSchema } from './primitives.js';

/**
 * Контракт фида обновлений MSFS-плагина (api.md §3.7, ADR-0017 §24).
 *
 * Публичный, read-only и **информационный**: недоступность фида не влияет на
 * приём телеметрии (§13.1), обновление никогда не обязательно (`mandatory`
 * всегда `false`), а `min_supported_version` — индикатор «для новых функций»,
 * а не гейт записи (§13.5 п.5).
 */

/** Канал релиза плагина. */
export const pluginChannelSchema = z.enum(['community', 'beta']);
export type PluginChannel = z.output<typeof pluginChannelSchema>;

/**
 * Одна запись релиза — форма `data` у `GET /v1/plugin/releases/latest` и элемент
 * статического манифеста (`PLUGIN_UPDATE_MANIFEST_URL`).
 */
export const pluginReleaseSchema = z
  .object({
    channel: pluginChannelSchema,
    /** Semver последней доступной версии для канала. */
    version: semverSchema,
    /** Прямая ссылка на zip-архив Community-пакета. */
    url: httpsUrlSchema,
    /** Короткий текст изменений (RU; EN — по `?lang=` в будущем). */
    notes: z.string().max(4000).nullable().default(null),
    /** Ссылка на полный changelog. */
    notes_url: httpsUrlSchema.nullable().default(null),
    /** SHA-256 архива (defense-in-depth); `null` — не опубликован. */
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, 'must be a SHA-256 hex digest')
      .nullable()
      .default(null),
    published_at: utcDateTimeSchema,
    /** Всегда `false` (принудительных обновлений нет, api.md §3.7). */
    mandatory: z.boolean().default(false),
    /** «Для новых функций обновитесь»; НЕ запрет приёма записи (§13.5 п.5). */
    min_supported_version: semverSchema.default('0.0.0'),
  })
  // Толерантно к аддитивным полям манифеста (§13.3): новые ключи игнорируются,
  // а не превращают фид в 503. Ответ содержит только объявленные поля.
  .strip();
export type PluginRelease = z.output<typeof pluginReleaseSchema>;

/**
 * Статический манифест `latest.json` (mirror B, api.md §3.7): набор релизов по
 * каналам. API-эндпоинт — источник истины, манифест — его внешняя копия.
 */
export const pluginReleaseManifestSchema = z.object({
  releases: z.array(pluginReleaseSchema).min(1),
});
export type PluginReleaseManifest = z.output<typeof pluginReleaseManifestSchema>;

/** Успешный ответ `GET /v1/plugin/releases/latest` (api.md §1.1, §3.7). */
export const pluginReleaseResponseSchema = z
  .object({ data: pluginReleaseSchema })
  .strict();
export type PluginReleaseResponse = z.output<typeof pluginReleaseResponseSchema>;
