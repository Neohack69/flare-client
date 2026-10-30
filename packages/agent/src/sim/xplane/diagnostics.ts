/**
 * One-time диагностика XP-подписки (аналог `describeSimVarDefinition` для MSFS).
 * Строка стабильна и пинована тестом; host логирует её один раз при connect.
 * Дамп dataref'ов запрещён (только allow-list поля и статусы, AppSec §5.2).
 */
import type { SimSourceDiagnostics } from '../source.js';

export interface XPlaneSubscriptionReport {
  /** Транспорт: `xp-web-api-v1` | `xp-udp-rref`. */
  readonly transport: string;
  /** Dataref'ы, для которых удалось получить id/значения (allow-list). */
  readonly resolved: readonly string[];
  /** Allow-list dataref'ы, отсутствующие в симе/версии. */
  readonly missing: readonly string[];
  /** Обязательные (`R`) dataref'ы. */
  readonly required: readonly string[];
  /** Базовая позиционная «дюжина» (AC-2). */
  readonly coreRequired: readonly string[];
  /** Канонические поля без XP-эквивалента (honest null). */
  readonly unsupported: readonly string[];
}

function countPresent(present: readonly string[], candidates: readonly string[]): number {
  const set = new Set(present);
  let count = 0;
  for (const name of candidates) if (set.has(name)) count += 1;
  return count;
}

/** Строит one-time диагностику подписки (без логирования). */
export function describeXPlaneSubscription(report: XPlaneSubscriptionReport): SimSourceDiagnostics {
  const total = report.resolved.length + report.missing.length;
  const coreResolved = countPresent(report.resolved, report.coreRequired);
  const requiredResolved = countPresent(report.resolved, report.required);
  const missingSuffix =
    report.missing.length > 0 ? `; unavailable: ${report.missing.length}` : '';
  return {
    message:
      `X-Plane 12 data definition: ${report.resolved.length}/${total} datarefs resolved ` +
      `(core R ${coreResolved}/${report.coreRequired.length}, ` +
      `all R ${requiredResolved}/${report.required.length}); ` +
      `transport ${report.transport}${missingSuffix}`,
    meta: {
      sim: 'xplane12',
      transport: report.transport,
      datarefs: total,
      resolved: report.resolved.length,
      unavailable: report.missing.length,
      core_required_resolved: coreResolved,
      core_required_total: report.coreRequired.length,
      required_resolved: requiredResolved,
      required_total: report.required.length,
      no_equivalent_fields: [...report.unsupported],
      ...(report.missing.length > 0 ? { unavailable_datarefs: [...report.missing] } : {}),
    },
  };
}

/** Текст предупреждения об отсутствующих dataref'ах (один раз за сессию). */
export function describeMissingXPlaneDatarefs(missing: readonly string[]): string {
  return (
    `X-Plane 12: ${missing.length} dataref(s) unavailable in this sim/version — ` +
    `affected fields degrade to null: ${missing.join(', ')}`
  );
}
