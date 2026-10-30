import { z } from 'zod';

/**
 * Публичная (не секретная) конфигурация возможностей, от которой зависит
 * пользовательский сценарий авторизации (T-MAIL1):
 *
 * - `email_verification_required` — нужен ли подтверждённый e-mail, чтобы
 *   пользоваться аккаунтом. При `false` интерфейс не должен обещать письмо.
 * - `mail_enabled` — реально ли API может доставить письмо (включён SMTP-транспорт).
 *   При `false` кнопки «отправить письмо снова» и текст «мы отправили письмо»
 *   недопустимы.
 * - `journal_summary_available` (A-02) — реализован ли Pro AI-разбор капитанского
 *   журнала. Пока `false`: `POST /v1/flights/{id}/journal/summary` отвечает
 *   `501 NOT_IMPLEMENTED`, UI обязан скрыть действие. Необязательное поле —
 *   старый бандл клиента без него трактует отсутствие как «недоступно».
 *
 * Секретов здесь нет: флаги безопасны для публичного кэшируемого эндпоинта.
 */
export const publicConfigSchema = z
  .object({
    email_verification_required: z.boolean(),
    mail_enabled: z.boolean(),
    journal_summary_available: z.boolean().optional(),
  })
  .strict();
export type PublicConfig = z.output<typeof publicConfigSchema>;
