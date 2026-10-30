#!/usr/bin/env node
import { runManualSync } from './manual-sync.js';
import { createConsoleLogger, parseLogLevel } from './logger.js';

const logger = createConsoleLogger({ level: parseLogLevel(process.env.AGENT_LOG_LEVEL) });
const outcome = await runManualSync({ logger });

if (outcome.result) {
  const { summary, pending_before: before, pending_after: after } = outcome.result;
  process.stdout.write(
    `${JSON.stringify({
      status: outcome.ok ? 'ok' : 'pending',
      synced: {
        flights: summary.flights_completed,
        points: summary.points_uploaded,
        events: summary.events_uploaded,
      },
      remaining: {
        flights: after.pendingFlights,
        points: after.pendingPoints,
        events: after.pendingEvents,
      },
      pending_before: {
        flights: before.pendingFlights,
        points: before.pendingPoints,
        events: before.pendingEvents,
      },
    })}\n`,
  );
}

if (!outcome.ok) {
  logger.error('manual sync failed', { error: outcome.error ?? 'unknown error' });
  process.exitCode = 1;
}
