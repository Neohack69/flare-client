import { describe, expect, it } from 'vitest';

import {
  RREF_HEADER_BYTES,
  RREF_MAGIC,
  RREF_NAME_BYTES,
  RREF_PAIR_BYTES,
  RREF_REQUEST_BYTES,
  decodeRrefResponse,
  decodeRrefValues,
  encodeRrefRequest,
  isRrefResponse,
} from './rref.js';

/** Собирает ответ-датаграмму `RREF` из пар `(index, value)` (float32). */
function rrefResponse(pairs: ReadonlyArray<readonly [number, number]>): Buffer {
  const buffer = Buffer.alloc(RREF_HEADER_BYTES + pairs.length * RREF_PAIR_BYTES);
  buffer.write(RREF_MAGIC, 0, 'ascii');
  pairs.forEach(([index, value], slot) => {
    const offset = RREF_HEADER_BYTES + slot * RREF_PAIR_BYTES;
    buffer.writeInt32LE(index, offset);
    buffer.writeFloatLE(value, offset + 4);
  });
  return buffer;
}

describe('RREF request encoding', () => {
  it('encodeRrefRequest: 413 байт, магия, freq/index LE, имя dataref', () => {
    const buffer = encodeRrefRequest('sim/time/paused', 10, 7);
    expect(buffer.length).toBe(RREF_REQUEST_BYTES);
    expect(buffer.length).toBe(413);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe(RREF_MAGIC);
    expect(buffer.readInt32LE(5)).toBe(10);
    expect(buffer.readInt32LE(9)).toBe(7);
    const name = buffer
      .subarray(13, 13 + RREF_NAME_BYTES)
      .toString('utf8')
      .replace(/\0[\s\S]*$/, '');
    expect(name).toBe('sim/time/paused');
  });

  it('freq=0 — отписка (значение на месте freq)', () => {
    const buffer = encodeRrefRequest('sim/time/paused', 0, 3);
    expect(buffer.readInt32LE(5)).toBe(0);
    expect(buffer.readInt32LE(9)).toBe(3);
  });

  it('длинное имя обрезается до 400 байт без исключения', () => {
    const longName = `sim/${'x'.repeat(600)}`;
    const buffer = encodeRrefRequest(longName, 1, 0);
    expect(buffer.length).toBe(RREF_REQUEST_BYTES);
    expect(buffer.subarray(13, 13 + RREF_NAME_BYTES).toString('utf8').length).toBeLessThanOrEqual(
      RREF_NAME_BYTES,
    );
  });
});

describe('RREF response decoding', () => {
  it('пустой/не-RREF буфер → пустой результат', () => {
    expect(isRrefResponse(Buffer.from('NOPE'))).toBe(false);
    expect(decodeRrefResponse(Buffer.from('NOPE'))).toEqual([]);
    expect(decodeRrefResponse(Buffer.alloc(0))).toEqual([]);
  });

  it('мультипакет: несколько пар в одной датаграмме разбираются циклом', () => {
    const buffer = rrefResponse([
      [0, 47.5],
      [1, -12.25],
      [2, 1013.25],
    ]);
    expect(decodeRrefResponse(buffer)).toEqual([
      { index: 0, value: 47.5 },
      { index: 1, value: -12.25 },
      { index: 2, value: 1013.25 },
    ]);
  });

  it('out-of-order пары сохраняют порядок появления, карта — по индексу', () => {
    const buffer = rrefResponse([
      [5, 1],
      [1, 2],
      [3, 3],
    ]);
    expect(decodeRrefResponse(buffer).map((pair) => pair.index)).toEqual([5, 1, 3]);
    const values = decodeRrefValues(buffer);
    expect(values.get(5)).toBe(1);
    expect(values.get(1)).toBe(2);
    expect(values.get(3)).toBe(3);
  });

  it('дубли индекса — last-wins', () => {
    const buffer = rrefResponse([
      [2, 10],
      [2, 20],
      [2, 30],
    ]);
    expect(decodeRrefValues(buffer).get(2)).toBe(30);
  });

  it('float32: полная точность недостижима (~1 м на позиции), значение округляется', () => {
    const buffer = rrefResponse([[0, 47.123456789]]);
    const decoded = decodeRrefValues(buffer).get(0);
    expect(decoded).toBeDefined();
    expect(decoded).toBeCloseTo(47.123456789, 4);
    expect(decoded).not.toBe(47.123456789);
  });

  it('хвостовые байты, не покрывающие полную пару, игнорируются', () => {
    const buffer = Buffer.concat([rrefResponse([[1, 5]]), Buffer.from([0x00, 0x01, 0x02])]);
    expect(decodeRrefResponse(buffer)).toEqual([{ index: 1, value: 5 }]);
  });

  it('isRrefResponse принимает Uint8Array', () => {
    const buffer = rrefResponse([[0, 1]]);
    expect(isRrefResponse(new Uint8Array(buffer))).toBe(true);
  });
});
