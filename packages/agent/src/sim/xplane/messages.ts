/**
 * WebSocket-сообщения X-Plane Web API (read-only подмножество, ADR-0023 §2.4).
 *
 * Разрешены ТОЛЬКО `dataref_subscribe_values` и `dataref_unsubscribe_values`:
 * write-сообщения в модуле не конструируются вовсе — это структурная гарантия
 * read-only (структурный запрет проверяется guard-тестом `guard.test.ts`).
 *
 * Реальная схема входящего кадра (подтверждено на XP 12.4.3):
 * `{"type":"dataref_update_values","data":{"<id>":value,...}}`.
 * Разбор толерантный: дополнительно принимаются кандидатные варианты из
 * `xplane-12-probe-plan.md` — `params.datarefs: [{id,value}]` и
 * `params.values: { "<id>": value }`.
 */
import type { XPlaneRawValue } from './values.js';

export interface XPlaneDatarefUpdate {
  readonly id: number;
  readonly value: XPlaneRawValue;
}

/** `req_id` + подписка на dataref-id (сам id резолвится по имени из allow-list). */
export function buildSubscribeMessage(reqId: number, ids: readonly number[]): string {
  return JSON.stringify({
    req_id: reqId,
    type: 'dataref_subscribe_values',
    params: { datarefs: ids.map((id) => ({ id })) },
  });
}

/** Отписка от dataref-id. */
export function buildUnsubscribeMessage(reqId: number, ids: readonly number[]): string {
  return JSON.stringify({
    req_id: reqId,
    type: 'dataref_unsubscribe_values',
    params: { datarefs: ids.map((id) => ({ id })) },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toRawValue(value: unknown): XPlaneRawValue {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === 'number' && Number.isFinite(item) ? item : null,
    );
  }
  return null;
}

function appendIdValueMap(
  updates: XPlaneDatarefUpdate[],
  map: Record<string, unknown> | null,
): void {
  if (!map) return;
  for (const [key, raw] of Object.entries(map)) {
    const id = Number(key);
    if (!Number.isFinite(id)) continue;
    updates.push({ id, value: toRawValue(raw) });
  }
}

/**
 * Разбирает входящее сообщение; возвращает список обновлений, если это
 * `dataref_update_values`, иначе `null` (прочие типы игнорируются).
 */
export function parseUpdateMessage(payload: unknown): XPlaneDatarefUpdate[] | null {
  const record = asRecord(payload);
  if (!record) return null;
  if (record.type !== 'dataref_update_values') return null;
  const updates: XPlaneDatarefUpdate[] = [];

  // Реальный кадр XP 12.4.3: data: { "<id>": value }.
  appendIdValueMap(updates, asRecord(record.data));

  // Кандидатные варианты (probe-plan): params.datarefs[] / params.values{}.
  const params = asRecord(record.params) ?? record;
  const datarefs = params.datarefs;
  if (Array.isArray(datarefs)) {
    for (const item of datarefs) {
      const entry = asRecord(item);
      if (!entry) continue;
      const id = typeof entry.id === 'number' && Number.isFinite(entry.id) ? entry.id : null;
      if (id === null) continue;
      updates.push({ id, value: toRawValue(entry.value ?? entry.values) });
    }
  }

  appendIdValueMap(updates, asRecord(params.values));

  return updates;
}
