import { describe, expect, it } from 'vitest';

import { buildSubscribeMessage, buildUnsubscribeMessage, parseUpdateMessage } from './messages.js';

describe('X-Plane WS message construction', () => {
  it('subscribe: req_id + type + dataref ids', () => {
    expect(JSON.parse(buildSubscribeMessage(1, [10, 20]))).toEqual({
      req_id: 1,
      type: 'dataref_subscribe_values',
      params: { datarefs: [{ id: 10 }, { id: 20 }] },
    });
  });

  it('unsubscribe: req_id + type + dataref ids', () => {
    expect(JSON.parse(buildUnsubscribeMessage(2, [10]))).toEqual({
      req_id: 2,
      type: 'dataref_unsubscribe_values',
      params: { datarefs: [{ id: 10 }] },
    });
  });

  it('конструируются только subscribe/unsubscribe (нет write-сообщений)', () => {
    const text = buildSubscribeMessage(1, [1]) + buildUnsubscribeMessage(2, [1]);
    expect(text).not.toContain('dataref_set_values');
    expect(text).not.toContain('command_');
  });
});

describe('X-Plane WS update parsing', () => {
  it('реальный кадр XP 12.4.3: data: { "<id>": value }', () => {
    // Записано с живого X-Plane 12.4.3 (read-only WS subscribe).
    const updates = parseUpdateMessage({
      data: {
        '2392572021896': 41.270451728279141,
        '2392572022232': 101.82107053894782,
        '2393211420136': 1,
        '2393211705464': [20.294218063354492, 20.294218063354492, 0],
      },
      type: 'dataref_update_values',
    });
    expect(updates).toEqual([
      { id: 2392572021896, value: 41.270451728279141 },
      { id: 2392572022232, value: 101.82107053894782 },
      { id: 2393211420136, value: 1 },
      { id: 2393211705464, value: [20.294218063354492, 20.294218063354492, 0] },
    ]);
  });

  it('data-карта: нечисловые ключи игнорируются', () => {
    const updates = parseUpdateMessage({
      type: 'dataref_update_values',
      data: { abc: 1, '5': 2 },
    });
    expect(updates).toEqual([{ id: 5, value: 2 }]);
  });

  it('params.datarefs: [{id,value}] и [{id,values}]', () => {
    const updates = parseUpdateMessage({
      type: 'dataref_update_values',
      params: {
        datarefs: [
          { id: 1, value: 2.5 },
          { id: 2, values: [1, 2, 3] },
        ],
      },
    });
    expect(updates).toEqual([
      { id: 1, value: 2.5 },
      { id: 2, value: [1, 2, 3] },
    ]);
  });

  it('params.values: карта id → value', () => {
    const updates = parseUpdateMessage({
      type: 'dataref_update_values',
      params: { values: { '7': 1.5, '8': 0 } },
    });
    expect(updates).toEqual([
      { id: 7, value: 1.5 },
      { id: 8, value: 0 },
    ]);
  });

  it('игнорирует прочие типы и мусор', () => {
    expect(parseUpdateMessage({ type: 'result', params: {} })).toBeNull();
    expect(parseUpdateMessage({ type: 'api_error' })).toBeNull();
    expect(parseUpdateMessage(null)).toBeNull();
    expect(parseUpdateMessage('not-json')).toBeNull();
    expect(parseUpdateMessage([])).toBeNull();
  });

  it('нечисловые значения деградируют в null', () => {
    const updates = parseUpdateMessage({
      type: 'dataref_update_values',
      params: { datarefs: [{ id: 1, value: { nested: true } }, { id: 2 }] },
    });
    expect(updates).toEqual([
      { id: 1, value: null },
      { id: 2, value: null },
    ]);
  });
});
