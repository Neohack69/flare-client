import {
  resolveStatusKind,
  type AgentStatusEvent,
  type DesktopAccount,
} from '@flightlog/contracts';

/**
 * T-CLIENT2: чистая логика окна привязки — без DOM, тестируется в node.
 * Определяет, привязан ли ПК, нужно ли показывать код и не истёк ли он.
 */

export interface PairingInput {
  status: AgentStatusEvent | null;
  account: DesktopAccount | null;
  agentRunning: boolean;
  recording: boolean;
  agentError: boolean;
  now?: number;
}

export interface PairingView {
  /** ПК привязан к аккаунту (агент работает и вход не требуется). */
  linked: boolean;
  /** Показать карточку с кодом подтверждения. */
  showDeviceCode: boolean;
  deviceCode: string | null;
  verificationUri: string | null;
  codeExpired: boolean;
  /** Подпись аккаунта (имя или e-mail) либо null. */
  accountLabel: string | null;
}

export function pairingView(input: PairingInput): PairingView {
  const { status, account, agentRunning, recording, agentError } = input;
  const now = input.now ?? Date.now();
  const kind = resolveStatusKind(status, { agentRunning, recording, agentError });

  // `sim_waiting` агент публикует ДО авторизации, поэтому одно состояние ещё не
  // доказывает привязку. Признаки авторизации: `deviceId` в статусе, известный
  // аккаунт или состояние, которое бывает только у авторизованного агента.
  const authorizedKinds = new Set([
    'connected_idle',
    'recording',
    'touchdown',
    'syncing',
    'sync_ok',
    'sync_error',
  ]);
  const requiresAuth = kind === 'auth_required' || kind === 'sync_error_fatal';
  const linked =
    status !== null &&
    agentRunning &&
    !requiresAuth &&
    (Boolean(status.deviceId) || account !== null || authorizedKinds.has(kind));

  const expiresAt = status?.userCodeExpiresAt ? Date.parse(status.userCodeExpiresAt) : null;
  const codeExpired = expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= now;

  return {
    linked,
    showDeviceCode: kind === 'auth_required' && Boolean(status?.userCode),
    deviceCode: status?.userCode ?? null,
    verificationUri: status?.verificationUri ?? null,
    codeExpired,
    accountLabel: account?.displayName ?? account?.email ?? null,
  };
}
