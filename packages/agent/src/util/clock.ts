/** Часы процесса (инъектируются для детерминированных тестов). */
export interface Clock {
  nowMs(): number;
  nowIso(): string;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

/** Фиксированные часы для тестов. */
export function fixedClock(iso: string): Clock {
  const ms = Date.parse(iso);
  return { nowMs: () => ms, nowIso: () => iso };
}
