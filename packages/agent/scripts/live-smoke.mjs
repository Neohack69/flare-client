/**
 * Read-only live smoke для проверки совместимости node-simconnect с MSFS 2024.
 *
 * БЕЗОПАСНОСТЬ: скрипт только запрашивает SimVars (read-only). Никаких write-операций,
 * pause/unpause или изменения состояния сима не выполняется.
 *
 * Запуск (после `pnpm --filter @flightlog/agent build`):
 *   pnpm --filter @flightlog/agent live-smoke
 */
import { NodeSimConnectAdapter } from '../dist/sim/node-simconnect-adapter.js';

const SAMPLE_LIMIT = Number.parseInt(process.env.SMOKE_SAMPLES ?? '5', 10);
const TIMEOUT_MS = Number.parseInt(process.env.SMOKE_TIMEOUT_MS ?? '20000', 10);

const adapter = new NodeSimConnectAdapter({ clientName: 'Flare Live Smoke (read-only)' });
let received = 0;

const finish = async (code) => {
  try {
    await adapter.disconnect();
  } catch {
    // ignore
  }
  process.exit(code);
};

adapter.on('open', (info) => {
  console.log('[smoke] connected (read-only):', JSON.stringify(info));
});

adapter.on('sample', (sample) => {
  received += 1;
  console.log(`[smoke] sample #${received}:`, JSON.stringify(sample));
  if (received >= SAMPLE_LIMIT) void finish(0);
});

adapter.on('error', (error) => {
  console.error('[smoke] error:', error);
});

adapter.on('disconnect', (reason) => {
  console.log('[smoke] disconnected:', reason);
  process.exit(received >= SAMPLE_LIMIT ? 0 : 1);
});

setTimeout(() => {
  console.error(`[smoke] timeout after ${TIMEOUT_MS} ms (samples=${received})`);
  void finish(received > 0 ? 0 : 1);
}, TIMEOUT_MS).unref();

try {
  await adapter.connect();
} catch (error) {
  console.error('[smoke] connect failed:', error);
  await finish(1);
}
