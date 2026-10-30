import {
  GRADE_UNKNOWN_HEX,
  gradeHex,
  resolveStatusKind,
  statusDescriptor,
  type AgentMePlan,
  type AgentStatusEvent,
  type DesktopAccount,
  type DesktopLocale,
  type DesktopOutboxCounts,
  type DesktopRuntimeInfo,
} from '@flightlog/contracts';

import { formatClock, formatSyncTime, getDesktopMessages, interpolate } from '../shared/i18n.js';
import { STATUS_FIT_DEBOUNCE_MS, STATUS_FIT_EPSILON_PX } from '../shared/status-fit.js';
import type { UpdateStatus } from '../shared/update-status.js';
import { iconSvg } from './icons.js';
import { pairingView } from './pairing.js';
import { applyPlanChip, planChipView, planView } from '../shared/plan.js';
import { statusGridView, type StatusTone } from './status-view.js';

/** FIX-UPDATE-CHECK-FEEDBACK: не даём кнопке «зависнуть» без ответа. */
const UPDATE_CHECK_TIMEOUT_MS = 15_000;

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setText(id: string, value: string): void {
  const el = byId(id);
  if (el) el.textContent = value;
}

function setIcon(id: string, icon: Parameters<typeof iconSvg>[0], size = 18): void {
  const el = byId(id);
  if (el) el.innerHTML = iconSvg(icon, size);
}

function setAttr(id: string, name: string, value: string): void {
  byId(id)?.setAttribute(name, value);
}

function formatCount(value: number | undefined, locale: string): string {
  if (value === undefined) return '-';
  return new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US').format(value);
}

function main(): void {
  const bridge = window.flightlog;
  const swinRoot = byId('swin');
  if (!bridge || !swinRoot) return;
  const swin: HTMLElement = swinRoot;

  let locale: DesktopLocale = bridge.locale;
  let messages = getDesktopMessages(locale);

  let runtime: DesktopRuntimeInfo | null = null;
  let status: AgentStatusEvent | null = null;
  let outbox: DesktopOutboxCounts | null = null;
  let account: DesktopAccount | null = null;
  let plan: AgentMePlan | null = null;
  let agentRunning = false;
  let agentError: string | null = null;
  let recording = false;
  let updateReady: string | null = null;
  let updateCheck: UpdateStatus | null = null;
  let updateInstalling = false;
  let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
  let deviceIssue: 'device-limit' | 'machine-mismatch' | null = null;
  let received = false;

  /**
   * T-CLIENT3: строки, не зависящие от статуса. Вызывается при старте и на
   * каждую смену языка — окно переводится мгновенно, без перезагрузки.
   */
  function applyStaticLabels(): void {
    document.title = messages.status.windowTitle;
    document.documentElement.lang = locale;
    setIcon('brand', 'brand', 20);
    setIcon('titlebar-mark', 'brand', 16);
    setText('label-sync', messages.status.actions.syncNow);
    setText('label-sync-prefix', messages.status.outbox.lastSyncLabel);
    setText('label-about', messages.status.actions.about);
    setText('landing-overline', messages.status.lastLanding.overline);
    setText('landing-score-label', messages.status.lastLanding.score);
    setText('landing-vs-label', messages.status.lastLanding.vs);
    setIcon('icon-sync', 'refresh-cw', 16);
    setIcon('banner-offline-icon', 'info', 16);
    setIcon('banner-error-icon', 'warning', 16);
    setText('device-code-overline', messages.status.deviceCode.overline);
    setText('label-copy-code', messages.status.deviceCode.copy);
    setText('label-open-device', messages.status.deviceCode.openSite);
    setText('label-request-code', messages.status.deviceCode.requestNew);
    setText('device-code-hint', messages.status.deviceCode.readOnlyHint);
    setText('label-install-update', messages.status.update.install);
    setText('label-check-updates', messages.status.update.check);
    setText('label-manage-devices', messages.notifications.manageDevices);
    setIcon('icon-copy', 'copy', 16);
    setIcon('icon-open', 'external', 16);
    setIcon('icon-request', 'refresh', 16);
    setIcon('icon-check-updates', 'refresh-cw', 16);
    setAttr('lang-switch', 'aria-label', messages.status.language.label);
    setAttr('lang-ru', 'aria-label', messages.status.language.ru);
    setAttr('lang-en', 'aria-label', messages.status.language.en);
    setAttr('button-minimize', 'aria-label', messages.windowControls.minimize);
    setAttr('button-minimize', 'title', messages.windowControls.minimize);
    setAttr('button-close', 'aria-label', messages.windowControls.close);
    setAttr('button-close', 'title', messages.windowControls.close);
    setIcon('icon-minimize', 'minimize', 16);
    setIcon('icon-close', 'close', 16);
    setIcon('plan-chip-icon', 'clock', 12);
    syncLanguageButtons();
  }

  /** T-CLIENT3: активный язык переключателя (визуально + a11y). */
  function syncLanguageButtons(): void {
    for (const code of ['ru', 'en'] as const) {
      const button = byId<HTMLButtonElement>(`lang-${code}`);
      if (!button) continue;
      const active = code === locale;
      button.classList.toggle('langswitch__btn--active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }

  applyStaticLabels();

  /**
   * DESKTOP-UPDATE-CARD: авто-высота окна по факту контента. Замер идёт со снятым
   * растяжением 100vh (класс), поэтому окно умеет и расти, и сжиматься.
   * main закрепляет нижнюю кромку — окно растёт вверх от трея.
   */
  const MEASURE_CLASS = 'status-page--measuring';
  let fitTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFitHeight = 0;

  function measureStatusHeight(): number {
    const bar = byId('titlebar')?.getBoundingClientRect().height ?? 0;
    document.body.classList.add(MEASURE_CLASS);
    const content = swin.scrollHeight;
    document.body.classList.remove(MEASURE_CLASS);
    return Math.round(bar + content);
  }

  function scheduleFit(): void {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = null;
      const height = measureStatusHeight();
      if (!Number.isFinite(height) || height <= 0) return;
      // Антидребезг: только реальная разница высот, иначе ResizeObserver зациклится.
      if (lastFitHeight > 0 && Math.abs(height - lastFitHeight) < STATUS_FIT_EPSILON_PX) return;
      lastFitHeight = height;
      bridge?.fitStatusWindow(height);
    }, STATUS_FIT_DEBOUNCE_MS);
  }

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(swin);
    const titlebarEl = byId('titlebar');
    if (titlebarEl) observer.observe(titlebarEl);
  }

  /**
   * F2: свет по шву тайтлбара — один раз за показ окна (докручивается классом,
   * без нового JS-чанка). Reduced motion гасит анимацию в CSS.
   */
  let sheenPlayed = false;
  const titlebar = byId('titlebar');

  function playSheen(): void {
    if (!titlebar || sheenPlayed) return;
    if (document.documentElement.dataset.plan !== 'pro') return;
    sheenPlayed = true;
    titlebar.classList.remove('titlebar--sheen');
    void titlebar.offsetWidth;
    titlebar.classList.add('titlebar--sheen');
  }

  titlebar?.addEventListener('animationend', (event) => {
    if (event.animationName === 'titlebar-sheen') titlebar.classList.remove('titlebar--sheen');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      sheenPlayed = false;
      return;
    }
    playSheen();
  });

  /** T-CLIENT2: состояние привязки ПК к аккаунту (без перезагрузки окна). */
  function renderPairing(): void {
    const view = pairingView({
      status,
      account,
      agentRunning,
      recording,
      agentError: agentError !== null,
    });
    const root = byId('pairing');
    root?.classList.toggle('pairing--linked', view.linked);
    setText(
      'pairing-text',
      view.linked ? messages.status.pairing.linked : messages.status.pairing.notLinked,
    );
    setText(
      'pairing-account',
      view.accountLabel
        ? interpolate(messages.status.pairing.account, { email: view.accountLabel })
        : '',
    );
  }

  /**
   * iter77: data-plan на <html> — только при достоверном плане. F2: план живёт
   * в чипе шапки; trial-полоса и Clock — только для trial.
   */
  function renderPlan(): void {
    const view = planView(plan);
    const chip = planChipView(plan, messages);
    const root = document.documentElement;
    if (view.skin) root.dataset.plan = view.skin;
    else delete root.dataset.plan;
    if (view.line === 'trial') root.dataset.trial = 'true';
    else delete root.dataset.trial;

    applyPlanChip(chip, {
      chip: byId('plan-chip'),
      text: byId('plan-chip-text'),
      icon: byId('plan-chip-icon'),
      bar: byId('plan-chip-bar'),
    });
    if (view.skin) playSheen();
  }

  function renderDeviceCode(): void {
    const root = byId('device-code');
    if (!root) return;
    const view = pairingView({
      status,
      account,
      agentRunning,
      recording,
      agentError: agentError !== null,
    });
    root.hidden = !view.showDeviceCode;
    if (!view.showDeviceCode) return;

    setText('device-code-value', view.deviceCode ?? '-');
    root.classList.toggle('devicecode--expired', view.codeExpired);

    const timer = byId('device-code-timer');
    if (timer) {
      if (view.codeExpired) {
        timer.textContent = messages.status.deviceCode.expired;
      } else {
        const expiresAt = status?.userCodeExpiresAt ? Date.parse(status.userCodeExpiresAt) : null;
        if (expiresAt !== null && Number.isFinite(expiresAt)) {
          const total = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
          const mm = String(Math.floor(total / 60)).padStart(2, '0');
          const ss = String(total % 60).padStart(2, '0');
          const at = formatClock(locale, status?.userCodeExpiresAt);
          timer.textContent = `${mm}:${ss} · ${interpolate(messages.status.deviceCode.expiresAt, {
            time: at,
          })}`;
        } else {
          timer.textContent = status?.message ?? '';
        }
      }
    }

    const requestButton = byId('button-request-code');
    if (requestButton) requestButton.hidden = !view.codeExpired;
    const actions = byId('device-code-actions');
    if (actions) actions.hidden = view.codeExpired;
  }

  /**
   * SIM-STATUS-1: строки «симулятор / полёт / данные». Тикают раз в секунду
   * локально (age/countdown), не создавая новых IPC-каналов.
   */
  function renderStatusGrid(): void {
    const kind = resolveStatusKind(status, {
      agentRunning,
      recording,
      agentError: agentError !== null,
    });
    const view = statusGridView({
      locale,
      kind,
      status,
      received,
      outbox,
      nowMs: Date.now(),
    });
    setText('sim-line', view.simulator);
    setText('flight-line', view.flight);
    setText('data-line', view.data);
    const simRow = byId('sim-row');
    if (simRow) simRow.hidden = view.simulator === '';
    const dataRow = byId('data-row');
    if (dataRow) dataRow.hidden = view.data === '';
    setTone('sim-row', view.simulatorTone);
    setTone('flight-row', view.flightTone);
    setTone('data-row', view.dataTone);

    const degraded = byId('degraded-row');
    if (degraded) degraded.hidden = view.degraded === null;
    setText('degraded-line', view.degraded ?? '');

    const pending = byId('pending-row');
    if (pending) pending.hidden = view.pending === null;
    setText('pending-line', view.pending ?? '');
  }

  function setTone(id: string, tone: StatusTone): void {
    const row = byId(id);
    if (!row) return;
    row.classList.remove(
      'statusgrid__row--ok',
      'statusgrid__row--warn',
      'statusgrid__row--muted',
      'statusgrid__row--active',
    );
    row.classList.add(`statusgrid__row--${tone}`);
  }

  function render(): void {
    const kind = resolveStatusKind(status, {
      agentRunning,
      recording,
      agentError: agentError !== null,
    });
    const descriptor = statusDescriptor(kind, status?.grade ?? null);
    const color =
      kind === 'touchdown' && status?.grade ? descriptor.hex : `var(${descriptor.token})`;
    swin.style.setProperty('--state-color', color);

    const chip = byId('chip');
    chip?.classList.toggle('state--pulse', kind === 'recording');
    chip?.classList.toggle('state--spin', kind === 'syncing');

    const copy = received ? messages.status.copies[kind] : messages.status.loading;
    setText('state-title', copy.title);
    // Не дублируем заголовок: сообщение агента показываем только если оно иное.
    setText(
      'state-message',
      status?.message && status.message !== copy.title ? status.message : copy.message,
    );
    setIcon('state-icon', descriptor.icon, 18);

    renderStatusGrid();

    const flight = byId('flight');
    const showFlight = kind === 'recording' || kind === 'touchdown';
    if (flight) flight.hidden = !showFlight;
    if (showFlight) {
      const icao = status?.aircraftIcao ?? '-';
      const id = status?.clientFlightId ?? status?.flightId;
      setText('flight-route', icao);
      const meta: string[] = [];
      if (id) meta.push(interpolateFlight(id));
      const points = outbox?.pendingPoints ?? status?.pendingCounts?.pendingPoints;
      if (points !== undefined) {
        meta.push(
          messages.status.currentFlight.points.replace('{points}', formatCount(points, locale)),
        );
      }
      setText('flight-meta', meta.join(' · '));
    }

    const lastSync = formatSyncTime(locale, status?.lastSyncAt);
    setText('sync-value', lastSync);

    const error = byId('error');
    const showError = kind === 'sync_error' || kind === 'sync_error_fatal';
    if (error) {
      error.hidden = !showError;
      error.classList.toggle('syncrow__err--danger', kind === 'sync_error_fatal');
    }
    if (showError) {
      setText('error-text', status?.message || messages.status.copies[kind].message);
      setIcon('error-icon', descriptor.icon, 14);
    }

    const offline = byId('banner-offline');
    if (offline) offline.hidden = navigator.onLine !== false;
    setText('banner-offline-text', messages.status.banners.offline);

    const errorBanner = byId('banner-error');
    if (errorBanner) errorBanner.hidden = agentError === null;
    if (agentError) {
      setText(
        'banner-error-text',
        messages.status.banners.agentError.replace('{message}', agentError),
      );
    }

    renderDeviceIssue();

    const deviceName = runtime?.deviceName ?? '-';
    setText('device-line', messages.status.device.label.replace('{name}', deviceName));

    // CD-5: нет версии (сбой `getRuntimeInfo`) → честный «—», а не выдуманное «v0.0.0».
    setText('app-version', runtime?.appVersion ? `v${runtime.appVersion}` : '-');

    const syncButton = byId<HTMLButtonElement>('button-sync');
    if (syncButton) syncButton.disabled = !agentRunning || kind === 'syncing';

    const agentButton = byId<HTMLButtonElement>('button-agent');
    if (agentButton) {
      agentButton.classList.toggle('dbtn--danger', kind === 'recording');
      setText(
        'label-agent',
        agentRunning ? messages.status.actions.stopAgent : messages.status.actions.startAgent,
      );
      setIcon('icon-agent', agentRunning ? 'stop' : 'play', 16);
    }

    renderPairing();
    renderPlan();
    renderDeviceCode();
    renderUpdate();
    renderLastLanding();
    scheduleFit();
  }

  /** CD-4.3: понятная инструкция при лимите устройств / несовпадении машины. */
  function renderDeviceIssue(): void {
    const banner = byId('banner-device');
    if (!banner) return;
    banner.hidden = deviceIssue === null;
    if (deviceIssue === null) return;
    const notification = messages.notifications;
    const title =
      deviceIssue === 'device-limit'
        ? notification.deviceLimitTitle
        : notification.machineMismatchTitle;
    const body =
      deviceIssue === 'device-limit'
        ? notification.deviceLimitBody
        : notification.machineMismatchBody;
    setText('banner-device-text', `${title}. ${body}`);
    setIcon('banner-device-icon', 'warning', 16);
  }

  /**
   * DESKTOP-UPDATE-CARD: одно из шести состояний карточки (comfort-bg-update-window.md §3.3).
   * Готовность важнее истории проверки — `ready`/`deferred` имеют приоритет над `error`.
   */
  type UpdateCardState = 'checking' | 'available' | 'latest' | 'ready' | 'deferred' | 'error';

  function updateCardState(): UpdateCardState | null {
    if (updateReady !== null) return recording ? 'deferred' : 'ready';
    if (updateCheck === null) return null;
    switch (updateCheck.kind) {
      case 'checking':
        return 'checking';
      case 'available':
        return 'available';
      case 'not-available':
        return 'latest';
      case 'error':
        return 'error';
      default:
        return null;
    }
  }

  /** Версия в строке — отдельный mono-фрагмент (данные, а не проза). */
  function setVersionText(id: string, template: string, version: string): void {
    const el = byId(id);
    if (!el) return;
    const parts = template.split('{version}');
    el.textContent = '';
    el.append(document.createTextNode(parts[0] ?? ''));
    if (parts.length === 1) return;
    const value = document.createElement('span');
    value.className = 'mono upd__ver';
    value.textContent = version;
    el.append(value, document.createTextNode(parts.slice(1).join('{version}')));
  }

  /**
   * T132/T-CLIENT2: карточка «Доступна версия X» + «Перезапустить и обновить».
   * Установка откладывается, пока идёт полёт (кнопка disabled + строка причины).
   * FIX-UPDATE-CHECK-FEEDBACK: та же карточка показывает ход ручной проверки.
   */
  function renderUpdate(): void {
    const card = byId('update');
    const reason = byId('update-reason');
    const reasonIcon = byId('update-reason-icon');
    const installButton = byId<HTMLButtonElement>('button-install-update');

    const checkButton = byId<HTMLButtonElement>('button-check-updates');
    const checking = updateCheck?.kind === 'checking';
    if (checkButton) {
      checkButton.disabled = checking;
      checkButton.classList.toggle('dbtn--spinning', checking);
    }

    const state = updateCardState();
    if (!card) return;
    card.hidden = state === null;
    if (state === null) {
      delete card.dataset.state;
      if (reason) reason.hidden = true;
      if (installButton) installButton.hidden = true;
      return;
    }
    card.dataset.state = state;

    const showCta = state === 'ready' || state === 'deferred';
    // Строка причины видна и в `ready` (пустая), чтобы высота карточки не менялась.
    if (reason) reason.hidden = !showCta;
    if (reasonIcon) reasonIcon.hidden = state !== 'deferred';
    setText('update-reason-text', state === 'deferred' ? messages.status.update.deferred : '');
    if (state === 'deferred') setIcon('update-reason-icon', 'plane-landing', 12);

    if (installButton) {
      installButton.hidden = !showCta;
      installButton.disabled = state !== 'ready' || updateInstalling;
    }

    switch (state) {
      case 'checking':
        setText('update-text', messages.about.updatesChecking);
        setIcon('update-icon', 'refresh', 16);
        break;
      case 'available':
        setVersionText(
          'update-text',
          messages.about.updateAvailable,
          updateCheck?.version ?? '',
        );
        setIcon('update-icon', 'refresh', 16);
        break;
      case 'latest':
        setText('update-text', messages.about.updateLatest);
        setIcon('update-icon', 'check', 16);
        break;
      case 'ready':
      case 'deferred':
        setVersionText('update-text', messages.status.update.ready, updateReady ?? '');
        setIcon('update-icon', 'check', 16);
        break;
      case 'error':
        setText('update-text', messages.about.updateError);
        setIcon('update-icon', 'warning', 16);
        break;
      default:
        break;
    }
  }

  function clearUpdateCheckTimer(): void {
    if (updateCheckTimer) {
      clearTimeout(updateCheckTimer);
      updateCheckTimer = null;
    }
  }

  function beginUpdateCheck(): void {
    updateCheck = { kind: 'checking' };
    clearUpdateCheckTimer();
    updateCheckTimer = setTimeout(() => {
      updateCheckTimer = null;
      if (updateCheck?.kind === 'checking') {
        updateCheck = { kind: 'error' };
        render();
      }
    }, UPDATE_CHECK_TIMEOUT_MS);
    render();
  }

  /** Фоновые (периодические) проверки UI не трогают — только явный клик. */
  function applyUpdateStatus(status: UpdateStatus): void {
    if (status.kind === 'downloaded') {
      // Строку заменит `updateReady`-строка («перезапустить для установки»).
      clearUpdateCheckTimer();
      updateCheck = null;
      render();
      return;
    }
    if (updateCheck?.kind !== 'checking') return;
    if (status.kind === 'checking') return;
    clearUpdateCheckTimer();
    updateCheck =
      status.kind === 'available'
        ? { kind: 'available', version: status.version }
        : { kind: status.kind };
    render();
  }

  /** Карточка последней посадки (T115): балл/грейд/VS живут и после рейса. */
  function renderLastLanding(): void {
    const card = byId('landing');
    if (!card) return;
    const hasLanding =
      status != null && (status.score != null || status.grade != null || status.vsFpm != null);
    card.hidden = !hasLanding;
    if (!hasLanding || !status) return;

    const copy = messages.status.lastLanding;
    card.style.setProperty(
      '--landing-color',
      status.grade ? gradeHex(status.grade) : GRADE_UNKNOWN_HEX,
    );
    setText('landing-score', status.score != null ? String(status.score) : '-');
    setText('landing-grade', status.grade ? copy.grade[status.grade] : '');
    setText(
      'landing-vs',
      status.vsFpm != null ? interpolate(copy.fpm, { fpm: Math.round(status.vsFpm) }) : '-',
    );

    const flags: string[] = [];
    if (status.bounceCount && status.bounceCount > 0) {
      flags.push(interpolate(copy.bounce, { count: status.bounceCount }));
    }
    if (status.touchAndGo) flags.push(copy.touchAndGo);
    // score-preview.md §4: серверный балл — «подтверждено», клиентский — «предварительно».
    // Поле опционально: старые события его не несут → без метки.
    if (status.scorePreliminary === true) flags.push(copy.preliminary);
    else if (status.scorePreliminary === false) flags.push(copy.confirmed);
    setText('landing-flags', flags.length > 0 ? flags.join(' · ') : copy.noBounce);

    const seq = status.landingSeq != null ? interpolate(copy.seq, { seq: status.landingSeq }) : '';
    const at = formatClock(locale, status.lastLandingAt);
    setText('landing-seq', [seq, at].filter(Boolean).join(' · '));
  }

  function shortId(id: string): string {
    return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
  }

  function interpolateFlight(id: string): string {
    return messages.status.currentFlight.flight.replace('{id}', shortId(id));
  }

  function applyStatus(event: AgentStatusEvent): void {
    status = event;
    received = true;
    if (event.state === 'recording' || event.state === 'touchdown') recording = true;
    if (
      event.state === 'connected_idle' ||
      event.state === 'sim_waiting' ||
      event.state === 'auth_required'
    ) {
      recording = false;
    }
    if (event.state === 'sync_error') agentError = null;
    render();
  }

  bridge.onStatus(applyStatus);
  bridge.onAgentRunning((running) => {
    agentRunning = running;
    if (running) agentError = null;
    render();
  });
  bridge.onAgentError((error) => {
    agentError = error;
    render();
  });
  bridge.onOutbox((counts) => {
    outbox = counts;
    render();
  });
  bridge.onUpdateReady((version) => {
    updateReady = version;
    render();
  });
  // FIX-UPDATE-CHECK-FEEDBACK: ход/итог ручной проверки обновлений.
  bridge.onUpdateStatus(applyUpdateStatus);
  // CD-4.3: проблема устройства (лимит/несовпадение) — баннер с инструкцией.
  bridge.onDeviceIssue((issue) => {
    deviceIssue = issue;
    render();
  });
  // T-CLIENT3: main подтвердил смену языка — переводим окно мгновенно.
  bridge.onLocale((next) => {
    locale = next;
    messages = getDesktopMessages(locale);
    applyStaticLabels();
    render();
  });

  const syncButton = byId<HTMLButtonElement>('button-sync');
  const agentButton = byId<HTMLButtonElement>('button-agent');
  const aboutButton = byId<HTMLButtonElement>('button-about');
  const copyCodeButton = byId<HTMLButtonElement>('button-copy-code');
  const openDeviceButton = byId<HTMLButtonElement>('button-open-device');
  const requestCodeButton = byId<HTMLButtonElement>('button-request-code');
  const installUpdateButton = byId<HTMLButtonElement>('button-install-update');
  const checkUpdatesButton = byId<HTMLButtonElement>('button-check-updates');
  const manageDevicesButton = byId<HTMLButtonElement>('button-manage-devices');
  const minimizeButton = byId<HTMLButtonElement>('button-minimize');
  const closeButton = byId<HTMLButtonElement>('button-close');

  minimizeButton?.addEventListener('click', () => void bridge.minimizeWindow());
  closeButton?.addEventListener('click', () => void bridge.closeWindow());
  syncButton?.addEventListener('click', () => void bridge.syncNow());
  aboutButton?.addEventListener('click', () => void bridge.openAbout());
  agentButton?.addEventListener('click', () => {
    if (agentRunning) void bridge.stopAgent();
    else void bridge.startAgent();
  });
  copyCodeButton?.addEventListener('click', () => {
    void bridge.copyUserCode();
    setText('label-copy-code', messages.status.deviceCode.copied);
    setIcon('icon-copy', 'check', 16);
    window.setTimeout(() => {
      setText('label-copy-code', messages.status.deviceCode.copy);
      setIcon('icon-copy', 'copy', 16);
    }, 1_400);
  });
  // Подтверждение — во внешнем браузере (сайт внутрь окна не грузится).
  openDeviceButton?.addEventListener('click', () => void bridge.openDeviceInBrowser());
  requestCodeButton?.addEventListener('click', () => void bridge.requestDeviceCode());
  installUpdateButton?.addEventListener('click', () => {
    // Установка занимает секунды, окно вот-вот перезапустится: CTA сразу disabled,
    // состояние/заголовок не меняются (не «прыгаем» в checking).
    updateInstalling = true;
    renderUpdate();
    void bridge.installUpdate();
  });
  checkUpdatesButton?.addEventListener('click', () => {
    beginUpdateCheck();
    void bridge.checkUpdates();
  });
  manageDevicesButton?.addEventListener('click', () => void bridge.openManageDevices());

  // T-CLIENT3: RU/EN — явный выбор языка; main применяет и сохраняет его.
  for (const code of ['ru', 'en'] as const) {
    byId<HTMLButtonElement>(`lang-${code}`)?.addEventListener('click', () => {
      if (code === locale) return;
      void bridge.setLocale(code);
    });
  }

  // T-CLIENT3 (канон §1.4): правый клик по коду устройства (user-select: all)
  // выделяет код, чтобы контекстное меню main предложило «Копировать».
  const deviceCodeValue = byId('device-code-value');
  deviceCodeValue?.addEventListener('contextmenu', () => {
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed) return;
    const range = document.createRange();
    range.selectNodeContents(deviceCodeValue);
    selection.removeAllRanges();
    selection.addRange(range);
  });

  // Тикаем таймер кода и heartbeat/обратный отсчёт раз в секунду.
  window.setInterval(() => {
    const root = byId('device-code');
    if (root && !root.hidden) renderDeviceCode();
    if (received) renderStatusGrid();
  }, 1_000);

  /**
   * T-CLIENT2: авто-опрос статуса/аккаунта — окно переходит в «привязано»
   * без перезагрузки, даже если событие потерялось.
   */
  window.setInterval(() => {
    void bridge
      .getStatus()
      .then((event) => {
        if (event) applyStatus(event);
      })
      .catch(() => undefined);
    void bridge
      .getAccount()
      .then((next) => {
        account = next;
        render();
      })
      .catch(() => undefined);
    void bridge
      .getPlan()
      .then((next) => {
        plan = next;
        render();
      })
      .catch(() => undefined);
  }, 3_000);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.close();
  });
  window.addEventListener('online', render);
  window.addEventListener('offline', render);

  void bridge
    .getRuntimeInfo()
    .then((info) => {
      runtime = info;
      agentRunning = info.agentRunning;
      render();
    })
    .catch(() => undefined);
  void bridge
    .getStatus()
    .then((event) => {
      if (event) applyStatus(event);
      render();
    })
    .catch(() => undefined);
  void bridge
    .getAccount()
    .then((next) => {
      account = next;
      render();
    })
    .catch(() => undefined);
  void bridge
    .getPlan()
    .then((next) => {
      plan = next;
      render();
    })
    .catch(() => undefined);

  render();
}

main();
