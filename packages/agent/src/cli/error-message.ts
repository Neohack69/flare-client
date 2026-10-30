/**
 * Человекочитаемое сообщение об ошибке для логов/статусов. У системных
 * `AggregateError` (например, `net` при недоступном SimConnect) `message`
 * пустой, а единственная зацепка — `code` (`ECONNREFUSED`). Без него лог
 * честно пишет «simulator not available», но не говорит почему.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const hasCode = typeof code === 'string' && code.length > 0;
    if (error.message) return hasCode ? `${error.message} (${code})` : error.message;
    if (hasCode) return `${error.name || 'Error'}: ${code}`;
    return error.name || String(error);
  }
  return String(error);
}
