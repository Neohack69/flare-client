/**
 * Device-flow error classification (CD-4.3, ADR-0018 §5).
 *
 * The device flow surfaces server error codes through the agent-host (fatal or
 * `sync_error`). We only need the machine-readable code, so matching is done on
 * the code token to stay independent of the surrounding prose/locale.
 */

export type DeviceIssue = 'device-limit' | 'machine-mismatch';

export function classifyDeviceIssue(message: string | null | undefined): DeviceIssue | null {
  if (!message) return null;
  if (/DEVICE_LIMIT_REACHED/i.test(message)) return 'device-limit';
  if (/MACHINE_MISMATCH/i.test(message)) return 'machine-mismatch';
  return null;
}
