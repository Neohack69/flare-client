import { describe, expect, it, vi } from 'vitest';

import { MemoryOutboxBuffer } from '../buffer/memory-buffer.js';
import type { FlushSummary } from './uploader.js';
import { OutboxSyncer, pendingTotal, type OutboxUploader } from './outbox-syncer.js';

const SUMMARY: FlushSummary = {
  flights_processed: 1,
  flights_completed: 1,
  flights_abandoned: 0,
  points_uploaded: 4,
  events_uploaded: 1,
  pending_flights: 0,
  pending_points: 0,
  pending_events: 0,
};

function makeLogger() {
  const entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  const push = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    entries.push({ level, message, meta });
  };
  return { entries, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

describe('OutboxSyncer', () => {
  it('логирует причину и счётчики, возвращает pending before/after', async () => {
    const buffer = new MemoryOutboxBuffer();
    const logger = makeLogger();
    const uploader: OutboxUploader = { flush: vi.fn(async () => SUMMARY) };
    const syncer = new OutboxSyncer({ uploader, buffer, logger });

    const result = await syncer.flush('startup');

    expect(result.reason).toBe('startup');
    expect(result.summary).toEqual(SUMMARY);
    expect(pendingTotal(result.pending_after)).toBe(0);
    expect(
      logger.entries.some(
        (entry) => entry.message === 'sync completed' && entry.meta?.reason === 'startup',
      ),
    ).toBe(true);
  });

  it('сериализует параллельные flush и не запускает uploader дважды', async () => {
    const buffer = new MemoryOutboxBuffer();
    const logger = makeLogger();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flush = vi.fn(async () => {
      await gate;
      return SUMMARY;
    });
    const syncer = new OutboxSyncer({ uploader: { flush }, buffer, logger });

    const first = syncer.flush('interval');
    const second = syncer.flush('manual');
    expect(first).toBe(second);
    expect(flush).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);

    const third = syncer.flush('manual');
    await third;
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
