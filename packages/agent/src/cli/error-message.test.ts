import { describe, expect, it } from 'vitest';

import { describeError } from './error-message';

describe('describeError', () => {
  it('возвращает message обычной ошибки', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('добавляет code, если он есть', () => {
    const error = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    expect(describeError(error)).toBe('connect failed (ECONNREFUSED)');
  });

  it('AggregateError без message: отдаёт name + code (кейс недоступного SimConnect)', () => {
    const error = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    expect(describeError(error)).toBe('AggregateError: ECONNREFUSED');
  });

  it('ошибка без message и без code не пустая', () => {
    expect(describeError(new Error(''))).toBe('Error');
  });

  it('не-Error приводится к строке', () => {
    expect(describeError('oops')).toBe('oops');
    expect(describeError(undefined)).toBe('undefined');
  });
});
