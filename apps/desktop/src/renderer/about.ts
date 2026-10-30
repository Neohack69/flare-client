import type { AgentMePlan, DesktopLocale, DesktopRuntimeInfo } from '@flightlog/contracts';

import { getDesktopMessages, interpolate } from '../shared/i18n.js';
import type { UpdateStatus } from '../shared/update-status.js';
import { iconSvg } from './icons.js';
import { applyPlanChip, planChipView, planView } from '../shared/plan.js';

/** FIX-UPDATE-CHECK-FEEDBACK: не даём кнопке «зависнуть» без ответа. */
const UPDATE_CHECK_TIMEOUT_MS = 15_000;

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setText(id: string, value: string): void {
  const el = byId(id);
  if (el) el.textContent = value;
}

function setAttr(id: string, name: string, value: string): void {
  byId(id)?.setAttribute(name, value);
}

function setIcon(id: string, icon: Parameters<typeof iconSvg>[0], size = 18): void {
  const el = byId(id);
  if (el) el.innerHTML = iconSvg(icon, size);
}

function main(): void {
  const bridge = window.flightlog;
  if (!bridge) return;

  let locale: DesktopLocale = bridge.locale;
  let messages = getDesktopMessages(locale);
  let about = messages.about;
  let runtime: DesktopRuntimeInfo | null = null;
  let plan: AgentMePlan | null = null;
  let errorReporting = { configured: false, enabled: false };
  let updateChecking = false;
  let updateCheckResult: UpdateStatus | null = null;
  let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
  const updatesButton = byId<HTMLButtonElement>('button-updates');

  const brand = byId('brand');
  if (brand) brand.innerHTML = iconSvg('brand', 40);
  setIcon('titlebar-mark', 'brand', 16);
  setIcon('icon-close', 'close', 16);
  setIcon('plan-chip-icon', 'clock', 12);

  const consent = byId<HTMLInputElement>('consent-checkbox');
  const diagnosticsButton = byId<HTMLButtonElement>('button-diagnostics');
  const toast = byId('toast');
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let sendingDiagnostics = false;
  const titlebar = byId('titlebar');
  const aboutContent = document.querySelector<HTMLElement>('.about');
  let fitTimer: ReturnType<typeof setTimeout> | null = null;

  /** Авто-высота: сообщаем main высоту titlebar + фактического контента (CSS px). */
  function scheduleFit(): void {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = null;
      if (!bridge || !titlebar || !aboutContent) return;
      const height = titlebar.getBoundingClientRect().height + aboutContent.scrollHeight;
      if (Number.isFinite(height) && height > 0) bridge.fitAboutWindow(height);
    }, 120);
  }

  if (aboutContent && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(scheduleFit).observe(aboutContent);
  }

  function renderDiagnosticsAvailability(): void {
    const checked = consent?.checked === true;
    if (diagnosticsButton) diagnosticsButton.disabled = !checked || sendingDiagnostics;
    setText('diagnostics-hint', checked ? '' : about.diagnosticsConsentHint);
    const hint = byId('diagnostics-hint');
    if (hint) hint.hidden = checked;
    scheduleFit();
  }

  async function sendDiagnostics(): Promise<void> {
    if (!bridge || consent?.checked !== true || sendingDiagnostics) return;
    sendingDiagnostics = true;
    setText('diagnostics-status', about.diagnosticsSending);
    renderDiagnosticsAvailability();
    let sent = false;
    try {
      sent = await bridge.sendDiagnostics();
    } catch {
      sent = false;
    }
    sendingDiagnostics = false;
    setText('diagnostics-status', sent ? about.diagnosticsSent : about.diagnosticsFailed);
    renderDiagnosticsAvailability();
  }

  function showToast(text: string): void {
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add('toast--visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('toast--visible'), 2_000);
  }

  function renderErrorReportingStatus(): void {
    setText(
      'consent-status',
      !errorReporting.configured
        ? about.errorReportingNotConfigured
        : errorReporting.enabled
          ? about.errorReportingConnected
          : about.errorReportingOff,
    );
  }

  /** FIX-UPDATE-CHECK-FEEDBACK: строка результата проверки обновлений. */
  function renderUpdateStatus(): void {
    if (updateChecking) {
      setText('update-status', about.updatesChecking);
      scheduleFit();
      return;
    }
    switch (updateCheckResult?.kind) {
      case 'not-available':
        setText('update-status', about.updateLatest);
        break;
      case 'available':
      case 'downloaded':
        setText(
          'update-status',
          interpolate(about.updateAvailable, { version: updateCheckResult.version ?? '' }),
        );
        break;
      case 'error':
        setText('update-status', about.updateError);
        break;
      default:
        setText('update-status', '');
        break;
    }
    scheduleFit();
  }

  function finishUpdateCheck(): void {
    updateChecking = false;
    if (updateCheckTimer) {
      clearTimeout(updateCheckTimer);
      updateCheckTimer = null;
    }
    if (updatesButton) {
      updatesButton.disabled = false;
      updatesButton.classList.remove('dbtn--spinning');
    }
  }

  function beginUpdateCheck(): void {
    const api = bridge;
    if (!api) return;
    updateChecking = true;
    updateCheckResult = null;
    if (updatesButton) {
      updatesButton.disabled = true;
      updatesButton.classList.add('dbtn--spinning');
    }
    renderUpdateStatus();
    if (updateCheckTimer) clearTimeout(updateCheckTimer);
    updateCheckTimer = setTimeout(() => {
      updateCheckTimer = null;
      if (!updateChecking) return;
      updateCheckResult = { kind: 'error' };
      finishUpdateCheck();
      renderUpdateStatus();
    }, UPDATE_CHECK_TIMEOUT_MS);
    void api.checkUpdates();
  }

  /** Фоновые (периодические) проверки UI не трогают — только явный клик. */
  function applyUpdateStatus(status: UpdateStatus): void {
    if (!updateChecking || status.kind === 'checking') return;
    updateCheckResult = status;
    finishUpdateCheck();
    renderUpdateStatus();
  }

  /** T-CLIENT3: статические подписи — при старте и при каждой смене языка. */
  function renderPlan(): void {
    const view = planView(plan);
    const chip = planChipView(plan, messages, { about: true });
    const root = document.documentElement;
    if (view.skin) root.dataset.plan = view.skin;
    else delete root.dataset.plan;
    if (view.line === 'trial') root.dataset.trial = 'true';
    else delete root.dataset.trial;

    const label = byId('label-plan');
    const value = byId('plan-name');
    if (!label || !value) return;
    const known = chip.visible || chip.freeText !== null;
    label.hidden = !known;
    value.hidden = !known;

    applyPlanChip(chip, {
      chip: byId('plan-chip'),
      text: byId('plan-chip-text'),
      icon: byId('plan-chip-icon'),
      bar: byId('plan-chip-bar'),
    });
    const free = byId('plan-free');
    if (free) {
      free.hidden = chip.freeText === null;
      free.textContent = chip.freeText ?? '';
    }
  }

  function applyMessages(): void {
    about = messages.about;
    setText('label-plan', about.plan);
    renderPlan();
    document.title = about.title;
    document.documentElement.lang = locale;
    setText('label-agent', about.agentVersion);
    setText('label-device', about.device);
    setText('link-download', about.download);
    setText('link-licenses', about.licenses);
    setText('button-logs', about.copyLog);
    setText('button-diagnostics', about.sendDiagnostics);
    setText('button-updates', about.checkUpdates);
    setText('close-hint', about.closeHint);
    setText('consent-label', about.errorReporting);
    setText('consent-hint', about.errorReportingHint);
    setAttr('button-close', 'aria-label', messages.windowControls.close);
    setAttr('button-close', 'title', messages.windowControls.close);
    renderErrorReportingStatus();
    renderUpdateStatus();
    renderDiagnosticsAvailability();
    scheduleFit();
  }

  function render(info: DesktopRuntimeInfo): void {
    runtime = info;
    setText('app-version', `v${info.appVersion}`);
    setText('agent-version', info.agentVersion ?? '-');
    setText('device', info.deviceName ?? '-');
    errorReporting = info.errorReporting;
    if (consent) consent.checked = info.errorReporting.enabled;
    renderErrorReportingStatus();
    renderDiagnosticsAvailability();
    scheduleFit();
  }

  consent?.addEventListener('change', () => {
    errorReporting = { ...errorReporting, enabled: consent.checked };
    renderErrorReportingStatus();
    renderDiagnosticsAvailability();
    void bridge.setErrorReporting(consent.checked);
  });
  byId('button-logs')?.addEventListener('click', () => {
    void bridge.copyLogs();
    showToast(about.logCopied);
  });
  diagnosticsButton?.addEventListener('click', () => void sendDiagnostics());
  byId('button-updates')?.addEventListener('click', () => beginUpdateCheck());
  byId('button-close')?.addEventListener('click', () => void bridge.closeWindow());

  // FIX-UPDATE-CHECK-FEEDBACK: ход/итог ручной проверки обновлений.
  bridge.onUpdateStatus(applyUpdateStatus);

  // T-CLIENT3: смена языка из окна статуса мгновенно переводит и About.
  bridge.onLocale((next) => {
    locale = next;
    messages = getDesktopMessages(locale);
    applyMessages();
    if (runtime) render(runtime);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.close();
  });

  applyMessages();
  // Сбой `getRuntimeInfo` → версия остаётся «—» (честно), без unhandled rejection.
  void bridge
    .getRuntimeInfo()
    .then(render)
    .catch(() => undefined);
  void bridge
    .getPlan()
    .then((next) => {
      plan = next;
      renderPlan();
    })
    .catch(() => undefined);
}

main();
