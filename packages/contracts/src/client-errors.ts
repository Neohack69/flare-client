import { z } from 'zod';

/**
 * Контракт клиентской ошибки (`POST /v1/client-errors`).
 *
 * Тело принимается от браузера web и от desktop-клиента. Поля — только
 * диагностические: сообщение, стек, источник, страница, релиз и произвольный
 * контекст (плоские примитивы). Никаких ПДн/секретов контракт не гарантирует —
 * API дополнительно вычищает e-mail, токены и query-string (см. sanitizer).
 */
export const CLIENT_ERROR_MESSAGE_MAX = 1000;
export const CLIENT_ERROR_STACK_MAX = 8000;
export const CLIENT_ERROR_URL_MAX = 1000;
export const CLIENT_ERROR_RELEASE_MAX = 80;
export const CLIENT_ERROR_FINGERPRINT_MAX = 64;
export const CLIENT_ERROR_CONTEXT_KEYS_MAX = 20;
export const CLIENT_ERROR_CONTEXT_KEY_MAX = 40;
export const CLIENT_ERROR_CONTEXT_VALUE_MAX = 200;
export const CLIENT_ERROR_STACK_FRAME_MAX = 160;

/** Стабильная длина fingerprint (две FNV-1a 32-битных половины). */
export const CLIENT_ERROR_FINGERPRINT_LENGTH = 16;

export const clientErrorSourceSchema = z.enum(['web', 'desktop']);
export type ClientErrorSource = z.output<typeof clientErrorSourceSchema>;

/**
 * Значение контекста — только плоский примитив. Вложенные объекты/массивы
 * запрещены: иначе легко протащить тело запроса или профиль пользователя.
 */
export const clientErrorContextValueSchema = z.union([
  z.string().max(CLIENT_ERROR_CONTEXT_VALUE_MAX),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const clientErrorContextKeySchema = z
  .string()
  .min(1)
  .max(CLIENT_ERROR_CONTEXT_KEY_MAX)
  .regex(/^[A-Za-z0-9_.-]+$/, 'context keys may only contain letters, digits, dot, dash, underscore');

export const clientErrorContextSchema = z
  .record(clientErrorContextKeySchema, clientErrorContextValueSchema)
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > CLIENT_ERROR_CONTEXT_KEYS_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `context must have at most ${CLIENT_ERROR_CONTEXT_KEYS_MAX} keys`,
      });
    }
  });

export const clientErrorIngestSchema = z
  .object({
    message: z.string().trim().min(1).max(CLIENT_ERROR_MESSAGE_MAX),
    stack: z.string().max(CLIENT_ERROR_STACK_MAX).optional(),
    source: clientErrorSourceSchema,
    url: z.string().trim().max(CLIENT_ERROR_URL_MAX).optional(),
    release: z.string().trim().max(CLIENT_ERROR_RELEASE_MAX).optional(),
    fingerprint: z
      .string()
      .trim()
      .min(1)
      .max(CLIENT_ERROR_FINGERPRINT_MAX)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    context: clientErrorContextSchema.optional(),
  })
  .strict();

export type ClientErrorIngest = z.output<typeof clientErrorIngestSchema>;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Первый «настоящий» кадр стека (без строки с сообщением об ошибке). */
export function firstClientErrorStackFrame(stack: string | null | undefined): string {
  if (!stack) return '';
  const lines = stack.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('at ') || /^[^@\s]+@/u.test(trimmed)) {
      return normalizeWhitespace(trimmed).slice(0, CLIENT_ERROR_STACK_FRAME_MAX);
    }
  }
  return '';
}

/**
 * Путь страницы без query-string/hash: query может содержать токены, e-mail и
 * прочие ПДн, поэтому в fingerprint и лог попадает только pathname.
 */
export function clientErrorPath(url: string | null | undefined): string {
  if (!url) return '';
  // Абсолютный URL или путь от корня; произвольный текст — не URL.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith('/')) return '';
  try {
    const parsed = new URL(url, 'https://placeholder.invalid');
    return parsed.pathname || '/';
  } catch {
    return '';
  }
}

function fnv1a(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Стабильный fingerprint: нормализованное сообщение + первый кадр стека + путь.
 * Deterministic, без crypto/DOM — одинаково работает в браузере, desktop и API.
 */
export function clientErrorFingerprint(input: {
  message: string;
  stack?: string | null;
  url?: string | null;
}): string {
  const message = normalizeWhitespace(input.message);
  const frame = firstClientErrorStackFrame(input.stack);
  const path = clientErrorPath(input.url);
  const base = `${message}\n${frame}\n${path}`;
  // Две разные FNV-1a половины уменьшают вероятность коллизии при группировке.
  return `${fnv1a(base, 0x811c9dc5)}${fnv1a(base, 0x01000193)}`;
}
