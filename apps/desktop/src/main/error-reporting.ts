import {
  CLIENT_ERROR_MESSAGE_MAX,
  CLIENT_ERROR_RELEASE_MAX,
  CLIENT_ERROR_STACK_MAX,
  type ClientErrorIngest,
} from '@flightlog/contracts';

/**
 * T118: GlitchTip-согласие. Каркас без внешнего SDK: транспорт подключается
 * отдельно при появлении DSN. Пока отправка — no-op, гарантированно без ПД и
 * токенов. Состояние («подключено/не настроено») показывается в About.
 */
export interface ErrorReportingState {
  /** DSN задан в окружении (env) — иначе «не настроено». */
  configured: boolean;
  /** Пользователь дал согласие И DSN настроен — только тогда шлём. */
  enabled: boolean;
}

export function resolveErrorReporting(
  dsn: string | null | undefined,
  consent: boolean,
): ErrorReportingState {
  const configured = typeof dsn === 'string' && dsn.trim().length > 0;
  return { configured, enabled: configured && consent };
}

export type ErrorReportingLog = (message: string) => void;

/**
 * Инициализация каркаса. Реальный SDK (GlitchTip/Sentry) здесь появится вместе
 * с DSN; до этого функция лишь фиксирует факт включения в логе.
 */
export function initErrorReporting(state: ErrorReportingState, log?: ErrorReportingLog): void {
  if (!state.configured) return;
  log?.(state.enabled ? 'error reporting enabled (scaffold)' : 'error reporting consent off');
}

/** W1b: в диагностику уходит не больше 16 КБ хвоста лога. */
export const DIAGNOSTICS_LOG_TAIL_MAX = 16 * 1024;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SECRET_ASSIGN_RE =
  /(password|passwd|pwd|secret|token|access_token|refresh_token|api[_-]?key|authorization|cookie)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;
const WINDOWS_PATH_RE = /(?:[A-Za-z]:\\|\\\\)[^\s"',}\]]+/g;
const POSIX_PATH_RE = /\/(?:Users|home|root|var|opt|tmp|etc|mnt|srv|private)\/[^\s"',}\]]*/g;
const FILE_URL_RE = /\bfile:\/\/\/[^\s"',}\]]+/gi;

/** Вырезает ПДн/секреты/пути, которые могут оказаться в логах и тексте ошибки. */
export function redactDiagnosticsText(value: string): string {
  return value
    .replace(FILE_URL_RE, '[path]')
    .replace(WINDOWS_PATH_RE, '[path]')
    .replace(POSIX_PATH_RE, '[path]')
    .replace(EMAIL_RE, '[email]')
    .replace(JWT_RE, '[token]')
    .replace(BEARER_RE, 'Bearer [redacted]')
    .replace(SECRET_ASSIGN_RE, (_match, key: string) => `${key}=[redacted]`);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

export interface DiagnosticsReportInput {
  appVersion: string;
  agentVersion: string | null;
  os: string;
  locale: string;
  logs: readonly string[];
}

/** Текст отчёта: только версии/ОС/язык и хвост лога, без токенов и путей. */
export function buildDiagnosticsReport(input: DiagnosticsReportInput): string {
  const logTail = tail(input.logs.join('\n'), DIAGNOSTICS_LOG_TAIL_MAX);
  const lines = [
    'Flare Desktop diagnostics',
    `app=${input.appVersion}`,
    `core=${input.agentVersion ?? 'n/a'}`,
    `os=${input.os}`,
    `locale=${input.locale}`,
  ];
  if (logTail.length > 0) lines.push('', '--- recent logs ---', logTail);
  return redactDiagnosticsText(lines.join('\n'));
}

/**
 * Тело `POST /v1/client-errors`: сообщение — краткая шапка, `stack` — хвост
 * лога (схема допускает 8 КБ; отчёт всё равно ограничен 16 КБ до санитайза).
 */
export function buildClientErrorPayload(input: DiagnosticsReportInput): ClientErrorIngest {
  const report = buildDiagnosticsReport(input);
  const summary = redactDiagnosticsText(
    `Flare Desktop diagnostics: app ${input.appVersion}, core ${input.agentVersion ?? 'n/a'}, OS ${input.os}, locale ${input.locale}`,
  );
  return {
    message: truncate(summary, CLIENT_ERROR_MESSAGE_MAX),
    source: 'desktop',
    release: truncate(input.appVersion, CLIENT_ERROR_RELEASE_MAX),
    stack: truncate(report, CLIENT_ERROR_STACK_MAX),
    context: {
      app_version: input.appVersion,
      agent_version: input.agentVersion ?? 'n/a',
      os: input.os,
      locale: input.locale,
    },
  };
}

export interface SendClientErrorOptions {
  endpoint: string;
  payload: ClientErrorIngest;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const SEND_TIMEOUT_MS = 10_000;

/** Отправка диагностики в API; любой сбой — `false`, без исключений наружу. */
export async function sendClientErrorReport(options: SendClientErrorOptions): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SEND_TIMEOUT_MS);
  try {
    const response = await fetchImpl(options.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options.payload),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
