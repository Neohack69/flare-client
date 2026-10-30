import type {
  AgentStatusKind,
  DesktopOutboxCounts,
  DesktopRuntimeInfo,
} from '@flightlog/contracts';

/**
 * Диагностика для «Скопировать диагностику» (desktop-client.md §6.5):
 * версии + последние (уже отредактированные) логи. **Без токенов/PII** —
 * device_id не секрет, но токены/коды сюда не попадают.
 */
export interface DiagnosticsInput {
  runtime: DesktopRuntimeInfo;
  statusKind: AgentStatusKind;
  outbox: DesktopOutboxCounts | null;
  logs: readonly string[];
}

export function buildDiagnosticsText(input: DiagnosticsInput): string {
  const { runtime, statusKind, outbox, logs } = input;
  const lines: string[] = [
    'Flare Desktop — diagnostics',
    `app=${runtime.appVersion}`,
    `agent=${runtime.agentVersion ?? 'n/a'}`,
    `electron=${runtime.electron}`,
    `chromium=${runtime.chromium}`,
    `node=${runtime.node}`,
    `protocol=${runtime.protocol}`,
    `channel=${runtime.channel}`,
    `locale=${runtime.locale}`,
    `device_id=${runtime.deviceId ?? 'n/a'}`,
    `status=${statusKind}`,
    `agent_running=${runtime.agentRunning}`,
  ];
  if (outbox) {
    lines.push(
      `outbox=flights:${outbox.pendingFlights},points:${outbox.pendingPoints},events:${outbox.pendingEvents}`,
    );
  }
  if (logs.length > 0) {
    lines.push('', '--- recent logs ---', ...logs);
  }
  return lines.join('\n');
}
