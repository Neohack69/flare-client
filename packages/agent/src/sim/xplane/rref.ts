/**
 * UDP `RREF` codec (ADR-0023 §2.1a/§2.3, R4). Чистые функции — без сокетов,
 * тестируются фикстурами без сима.
 *
 * Wire-format (кандидат; `VERIFY-LIVE-TOMORROW` по `xplane-12-probe-plan.md` §7):
 *   запрос:  `<4s x i i 400s` = `'RREF'` + 1 pad + freq(int32 LE) + index(int32 LE)
 *            + имя dataref (400 байт, NUL-padded UTF-8);
 *   ответ:   `'RREF'` + 1 pad, далее пары `(index:int32 LE, value:float32 LE)`;
 *            одна датаграмма может содержать НЕСКОЛЬКО пар (разбор циклом).
 *
 * ⚠️ Точность RREF: все значения приходят **float32** независимо от типа dataref.
 * Для `latitude`/`longitude` это даёт ошибку позиции порядка ~1 м
 * (`RREF_POSITION_TOLERANCE_M`) — на порядок меньше порога телепорта (50 м), но
 * для точки касания лишний шум. Поэтому основной транспорт — Web API (double),
 * RREF — фолбэк (ADR-0023 §2.3/R3).
 */
import { Buffer } from 'node:buffer';

export const RREF_MAGIC = 'RREF';
/** `4s` + pad-байт (`x`) = 5 байт заголовка запроса/ответа. */
export const RREF_HEADER_BYTES = 5;
/** Пара `(index:int32, value:float32)` = 8 байт. */
export const RREF_PAIR_BYTES = 8;
/** Поле имени dataref в запросе = 400 байт (`400s`). */
export const RREF_NAME_BYTES = 400;
/** Полный размер RREF-запроса: 4 + 1 + 4 + 4 + 400 = 413 байт. */
export const RREF_REQUEST_BYTES = 4 + 1 + 4 + 4 + RREF_NAME_BYTES;

/** Ожидаемая погрешность позиции из-за float32 (~1 м, ADR-0023 R3). */
export const RREF_POSITION_TOLERANCE_M = 1;

export interface RrefPair {
  readonly index: number;
  readonly value: number;
}

/**
 * Собирает RREF-запрос на dataref. `freq` — раз/сек; `freq=0` — отписка
 * (ADR-0023 §2.1a; единственный разрешённый UDP-пакет — `RREF`).
 * `index` — наш внутренний слот (резолвится обратно в dataref по карте подписки).
 */
export function encodeRrefRequest(dataref: string, freq: number, index: number): Buffer {
  const buffer = Buffer.alloc(RREF_REQUEST_BYTES);
  buffer.write(RREF_MAGIC, 0, 'ascii');
  buffer.writeInt32LE(freq | 0, RREF_HEADER_BYTES);
  buffer.writeInt32LE(index | 0, RREF_HEADER_BYTES + 4);
  Buffer.from(dataref, 'utf8').copy(buffer, RREF_HEADER_BYTES + 8);
  return buffer;
}

/** `true`, если буфер начинается с магии `RREF`. */
export function isRrefResponse(buffer: Uint8Array): boolean {
  if (buffer.length < RREF_HEADER_BYTES) return false;
  return (
    buffer[0] === 0x52 && // R
    buffer[1] === 0x52 && // R
    buffer[2] === 0x45 && // E
    buffer[3] === 0x46 // F
  );
}

/**
 * Разбирает датаграмму-ответ `RREF` в пары `(index, value)` в порядке появления.
 * Несколько пар в одной датаграмме разбираются циклом (ADR-0023 R4). Хвостовые
 * байты, не покрывающие полную пару, игнорируются (устойчивость к обрезанному
 * пакету). Не-`RREF` буфер → пустой массив.
 */
export function decodeRrefResponse(buffer: Uint8Array): RrefPair[] {
  if (!isRrefResponse(buffer)) return [];
  const view = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const pairs: RrefPair[] = [];
  const payload = view.subarray(RREF_HEADER_BYTES);
  const count = Math.floor(payload.length / RREF_PAIR_BYTES);
  for (let pair = 0; pair < count; pair += 1) {
    const offset = pair * RREF_PAIR_BYTES;
    pairs.push({
      index: payload.readInt32LE(offset),
      value: payload.readFloatLE(offset + 4),
    });
  }
  return pairs;
}

/**
 * Разбирает датаграмму в карту `index → value` с правилом **last-wins** (ADR-0023
 * R4: дубли индекса в одном/разных пакетах — побеждает последнее значение).
 */
export function decodeRrefValues(buffer: Uint8Array): Map<number, number> {
  const values = new Map<number, number>();
  for (const pair of decodeRrefResponse(buffer)) {
    values.set(pair.index, pair.value);
  }
  return values;
}
