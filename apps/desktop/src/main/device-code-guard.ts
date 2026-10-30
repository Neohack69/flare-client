/**
 * Rate-limit/guard для renderer-команды `request-device-code` (F-101).
 *
 * Команда перезапускает runtime агента за свежим `user_code`. Без лимита
 * скомпрометированный same-origin renderer (XSS/supply-chain) мог бы вызывать
 * её в цикле: бесконечный stop/start агента, поток `POST /auth/device/code` и
 * мусорные pending-устройства в БД. Дизайн (ADR-0011 §7) требует ограничения —
 * модуль не зависит от Electron и покрыт unit-тестами.
 */

export interface DeviceCodeRequestContext {
  /** Есть ли сейчас показанный пользователю код. */
  hasPendingCode: boolean;
  /** Истёк ли этот код (тогда запрос нового осмыслен). */
  codeExpired: boolean;
}

export interface DeviceCodeRequestGuardOptions {
  /** Минимальный интервал между успешными запросами. */
  cooldownMs?: number;
  /** Окно скользящего лимита. */
  windowMs?: number;
  /** Максимум успешных запросов в окне. */
  maxRequests?: number;
  now?(): number;
}

export const DEVICE_CODE_COOLDOWN_MS = 30_000;
export const DEVICE_CODE_WINDOW_MS = 5 * 60_000;
export const DEVICE_CODE_MAX_REQUESTS = 3;

/**
 * Разрешает запрос нового кода, только если кода нет или он истёк,
 * не чаще `cooldownMs` и не больше `maxRequests` за `windowMs`.
 */
export class DeviceCodeRequestGuard {
  private readonly cooldownMs: number;
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly now: () => number;
  private timestamps: number[] = [];

  constructor(options: DeviceCodeRequestGuardOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? DEVICE_CODE_COOLDOWN_MS;
    this.windowMs = options.windowMs ?? DEVICE_CODE_WINDOW_MS;
    this.maxRequests = options.maxRequests ?? DEVICE_CODE_MAX_REQUESTS;
    this.now = options.now ?? Date.now;
  }

  /** Проверяет без записи (для тестов/диагностики). */
  canRequest(context: DeviceCodeRequestContext): boolean {
    const now = this.now();
    const fresh = this.freshTimestamps(now);
    if (context.hasPendingCode && !context.codeExpired) return false;
    if (fresh.length >= this.maxRequests) return false;
    const last = fresh[fresh.length - 1];
    if (last !== undefined && now - last < this.cooldownMs) return false;
    return true;
  }

  /** Проверяет и, если можно, записывает попытку. Возвращает решение. */
  tryRequest(context: DeviceCodeRequestContext): boolean {
    const now = this.now();
    if (!this.canRequest(context)) return false;
    this.timestamps = [...this.freshTimestamps(now), now];
    return true;
  }

  private freshTimestamps(now: number): number[] {
    return this.timestamps.filter((timestamp) => now - timestamp < this.windowMs);
  }
}
