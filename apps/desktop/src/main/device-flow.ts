import type { AgentStatusEvent, DesktopLocale } from '@flightlog/contracts';

import { getDesktopMessages, interpolate } from '../shared/i18n.js';

/**
 * Device verification (T-CLIENT2): клиент показывает `user_code`, а
 * подтверждение происходит в **системном браузере** по явной кнопке
 * «Открыть сайт для подтверждения» (`shell.openExternal`). Сайт внутрь окна
 * клиента не грузится. Здесь — только состояние кода, таймер истечения и
 * публикация статуса; main прокидывает побочные эффекты (окно/трей/уведомления).
 */

export interface DeviceCodeInput {
  user_code: string;
  verification_uri: string;
  expires_in: number;
}

export interface DeviceFlowState {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

export interface DeviceFlowCallbacks {
  /** Показать/сфокусировать окно привязки: пользователь должен увидеть код. */
  showWindow(): void;
  /** Обновить код в трее; `null` — сбросить (устройство авторизовано). */
  setTrayUserCode(code: string | null, expiresAt: number | null): void;
  /** Опубликовать статус агента (`auth_required` с кодом либо «код истёк»). */
  publishStatus(event: AgentStatusEvent): void;
  /** Разовое уведомление, если окно скрыто (пользователь не увидит код иначе). */
  notifyPending(state: DeviceFlowState): void;
  /** Агент авторизован — окно переходит в состояние «привязано» без перезагрузки. */
  onAuthorized(): void;
  locale(): DesktopLocale;
}

export interface DeviceFlowOptions extends DeviceFlowCallbacks {
  now?(): number;
  setTimeout?(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout?(handle: ReturnType<typeof setTimeout>): void;
  isWindowVisible?(): boolean;
}

export class DeviceFlow {
  private pending: DeviceFlowState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private notified = false;
  private readonly now: () => number;
  private readonly setTimer: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly options: DeviceFlowOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
  }

  get state(): DeviceFlowState | null {
    return this.pending;
  }

  isPending(): boolean {
    return this.pending !== null;
  }

  /**
   * Код показан, но срок уже истёк (таймер ещё не сработал либо сработал).
   * Нужно F-101: новый код запрашиваем только если кода нет или он истёк.
   */
  isExpired(): boolean {
    return this.pending !== null && this.now() >= this.pending.expiresAt;
  }

  handleUserCode(input: DeviceCodeInput): DeviceFlowState {
    this.cancelTimer();
    const now = this.now();
    const expiresAt = now + Math.max(1, input.expires_in) * 1000;
    const state: DeviceFlowState = {
      userCode: input.user_code,
      verificationUri: input.verification_uri,
      expiresAt,
    };
    this.pending = state;
    this.notified = false;

    this.options.setTrayUserCode(state.userCode, state.expiresAt);
    this.options.showWindow();
    this.options.publishStatus(this.authRequiredEvent(state));
    this.notifyIfHidden();

    this.timer = this.setTimer(() => this.expire(), Math.max(0, expiresAt - now));
    return state;
  }

  /** Код подтверждён — сбрасываем состояние; окно само перейдёт в «привязано». */
  markAuthorized(): void {
    if (!this.pending) return;
    this.pending = null;
    this.cancelTimer();
    this.options.setTrayUserCode(null, null);
    this.options.onAuthorized();
  }

  /** T-CLIENT3: язык сменился — переопубликовать активный код в новом языке. */
  republish(): void {
    const state = this.pending;
    if (!state) return;
    this.options.publishStatus(
      this.now() >= state.expiresAt ? this.expiredEvent(state) : this.authRequiredEvent(state),
    );
  }

  /** Разовое уведомление, если окно скрыто и код ещё в силе. */
  notifyIfHidden(windowVisible = this.options.isWindowVisible?.() ?? false): void {
    const state = this.pending;
    if (!state || this.notified || windowVisible) return;
    if (this.now() >= state.expiresAt) return;
    this.notified = true;
    this.options.notifyPending(state);
  }

  /** Сброс без публикации «авторизован» (остановка агента/выход). */
  reset(): void {
    this.pending = null;
    this.cancelTimer();
    this.options.setTrayUserCode(null, null);
  }

  dispose(): void {
    this.cancelTimer();
  }

  private expire(): void {
    const state = this.pending;
    if (!state) return;
    this.pending = null;
    this.cancelTimer();
    // Оставляем код в трее с прошедшим сроком, чтобы меню показало «код истёк».
    this.options.setTrayUserCode(state.userCode, state.expiresAt);
    this.options.publishStatus(this.expiredEvent(state));
  }

  private authRequiredEvent(state: DeviceFlowState): AgentStatusEvent {
    const messages = getDesktopMessages(this.options.locale()).status.deviceCode;
    return {
      state: 'auth_required',
      userCode: state.userCode,
      verificationUri: state.verificationUri,
      expiresIn: Math.max(0, Math.round((state.expiresAt - this.now()) / 1000)),
      userCodeExpiresAt: new Date(state.expiresAt).toISOString(),
      message: interpolate(messages.pending, { code: state.userCode }),
    };
  }

  private expiredEvent(state: DeviceFlowState): AgentStatusEvent {
    const messages = getDesktopMessages(this.options.locale()).status.deviceCode;
    return {
      state: 'auth_required',
      userCode: state.userCode,
      verificationUri: state.verificationUri,
      userCodeExpiresAt: new Date(state.expiresAt).toISOString(),
      message: messages.expired,
    };
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
