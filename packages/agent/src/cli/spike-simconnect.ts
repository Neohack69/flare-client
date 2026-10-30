/**
 * CD-1 (Spike S2) — ручной Go/No-Go харнесс `node-simconnect` ↔ MSFS 2024.
 *
 * СТРОГО read-only: запрашиваются только SimVars; переменные сима не меняются,
 * пауза не ставится, активный полёт не затрагивается. Запуск — только вручную,
 * в CI не добавляется.
 *
 * Запуск:
 *   pnpm --filter @flightlog/agent spike:simconnect
 *   (или после сборки: node packages/agent/scripts/spike-simconnect.mjs)
 */
import {
  DEFAULT_PROTOCOL,
  NodeSimConnectAdapter,
  type SimConnectProtocolName,
} from '../sim/node-simconnect-adapter.js';
import { formatSpikeReport } from '../spike/report.js';
import {
  DEFAULT_SPIKE_CONNECT_TIMEOUT_MS,
  DEFAULT_SPIKE_DURATION_MS,
  DEFAULT_SPIKE_IDLE_TIMEOUT_MS,
  DEFAULT_SPIKE_MAX_SAMPLES,
  DEFAULT_SPIKE_MIN_SAMPLES,
  requiredSimVarNames,
  runSimConnectSpike,
} from '../spike/run.js';

const PROTOCOLS: readonly SimConnectProtocolName[] = ['sunrise', 'kittyhawk', 'fsx_sp2'];

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readProtocol(env: NodeJS.ProcessEnv): SimConnectProtocolName {
  const raw = env.SPIKE_PROTOCOL?.trim().toLowerCase();
  if (raw && (PROTOCOLS as readonly string[]).includes(raw)) {
    return raw as SimConnectProtocolName;
  }
  return DEFAULT_PROTOCOL;
}

const protocol = readProtocol(process.env);
const clientName = process.env.SPIKE_CLIENT_NAME?.trim() || 'Flare CD-1 Spike (read-only)';
const adapter = new NodeSimConnectAdapter({
  clientName,
  protocol,
  maxSampleHz: readInt(process.env, 'SPIKE_MAX_HZ', 0),
});

console.log('[spike] CD-1 Spike S2: node-simconnect <-> MSFS 2024 (STRICTLY READ-ONLY)');
console.log(`[spike] обязательные SimVar (${requiredSimVarNames().length}): ${requiredSimVarNames().join(', ')}`);
console.log(`[spike] подключение к симу (протокол ${protocol})...`);

const result = await runSimConnectSpike({
  adapter,
  protocol,
  maxSamples: readInt(process.env, 'SPIKE_SAMPLES', DEFAULT_SPIKE_MAX_SAMPLES),
  durationMs: readInt(process.env, 'SPIKE_DURATION_MS', DEFAULT_SPIKE_DURATION_MS),
  connectTimeoutMs: readInt(process.env, 'SPIKE_CONNECT_TIMEOUT_MS', DEFAULT_SPIKE_CONNECT_TIMEOUT_MS),
  idleTimeoutMs: readInt(process.env, 'SPIKE_IDLE_TIMEOUT_MS', DEFAULT_SPIKE_IDLE_TIMEOUT_MS),
  minSamples: readInt(process.env, 'SPIKE_MIN_SAMPLES', DEFAULT_SPIKE_MIN_SAMPLES),
});

console.log('');
console.log(formatSpikeReport(result.report));
if (!result.report.connection.connectedEver) {
  console.error(
    '[spike] Подсказка: запустите MSFS 2024, дождитесь главного меню и повторите команду. ' +
      'MSFS 2020 проверяется отдельно (SPIKE_PROTOCOL=kittyhawk).',
  );
}

process.exit(result.exitCode);
