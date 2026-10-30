import type { OutboxBuffer, OutboxCounts } from '../buffer/types.js';
import type { Logger } from '../cli/logger.js';
import type { FlushSummary } from './uploader.js';

/** Результат одного прохода синка outbox → API. */
export interface OutboxSyncResult {
  reason: string;
  summary: FlushSummary;
  pending_before: OutboxCounts;
  pending_after: OutboxCounts;
}

/** Минимальная поверхность uploader'а, нужная синкеру (упрощает моки). */
export interface OutboxUploader {
  flush(): Promise<FlushSummary>;
}

export interface OutboxSyncerOptions {
  uploader: OutboxUploader;
  buffer: OutboxBuffer;
  logger: Logger;
}

export function pendingTotal(counts: OutboxCounts): number {
  return counts.pendingFlights + counts.pendingPoints + counts.pendingEvents;
}

/**
 * Обёртка над батчевым uploader'ом: сериализует параллельные flush'и, снимает
 * счётчики outbox до/после и пишет единый лог `sync completed {reason, ...}`.
 *
 * Намеренно НЕ зависит от SimConnect: синк запускается при старте агента и по
 * таймеру, даже если сим не найден или рейс не пишется. Это позволяет догрузить
 * зависшие рейсы при рестарте и вручную через CLI.
 */
export class OutboxSyncer {
  private inFlight: Promise<OutboxSyncResult> | null = null;

  constructor(private readonly options: OutboxSyncerOptions) {}

  flush(reason: string): Promise<OutboxSyncResult> {
    if (this.inFlight) return this.inFlight;
    const run = this.doFlush(reason);
    this.inFlight = run.finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doFlush(reason: string): Promise<OutboxSyncResult> {
    const pendingBefore = this.options.buffer.pendingCounts();
    const summary = await this.options.uploader.flush();
    const pendingAfter = this.options.buffer.pendingCounts();
    const pending = pendingTotal(pendingAfter);

    this.options.logger.info('sync completed', {
      reason,
      ...summary,
      pending_total: pending,
    });

    return { reason, summary, pending_before: pendingBefore, pending_after: pendingAfter };
  }
}
