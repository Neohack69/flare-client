import { randomUUID } from 'node:crypto';

/** Генератор идентификаторов (UUID v4). Инъектируется для детерминированных тестов. */
export type IdGenerator = () => string;

export const uuidGenerator: IdGenerator = () => randomUUID();

/**
 * Детерминированный генератор UUID v4 для тестов: `seed` управляет всеми
 * полями, результат проходит `uuidSchema` из `@flightlog/contracts`.
 */
export function seededUuidGenerator(seed = 0): IdGenerator {
  let counter = seed;
  return () => {
    counter += 1;
    const n = counter.toString(16).padStart(12, '0').slice(-12);
    return `00000000-0000-4000-8000-${n}`;
  };
}
