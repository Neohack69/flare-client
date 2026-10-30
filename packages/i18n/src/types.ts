/**
 * Типы словаря `@flightlog/i18n` (desktop-client.md §7.1). Пакет листовой:
 * локальные union-типы вместо зависимости от `@flightlog/contracts`, чтобы
 * main/renderer/web подключали один словарь без цикла.
 */

export type DesktopLocale = 'ru' | 'en';

export const DESKTOP_LOCALES: readonly DesktopLocale[] = ['ru', 'en'];

/** Состояния, которые понимает UI (desktop-client.md §3). */
export type AgentStatusKind =
  | 'auth_required'
  | 'sim_waiting'
  | 'connected_idle'
  | 'recording'
  | 'touchdown'
  | 'syncing'
  | 'sync_ok'
  | 'sync_error'
  | 'sync_error_fatal'
  | 'agent_error'
  | 'not_started';

export const AGENT_STATUS_KINDS: readonly AgentStatusKind[] = [
  'auth_required',
  'sim_waiting',
  'connected_idle',
  'recording',
  'touchdown',
  'syncing',
  'sync_ok',
  'sync_error',
  'sync_error_fatal',
  'agent_error',
  'not_started',
];

/** Значения подстановки в шаблоны (`{name}`). */
export type TemplateValues = Record<string, string | number>;

/** Грейды посадки (зеркало `scoreGradeSchema`; пакет листовой). */
export type ScoreGrade = 'butter' | 'good' | 'firm' | 'hard' | 'crash';

export const SCORE_GRADES: readonly ScoreGrade[] = ['butter', 'good', 'firm', 'hard', 'crash'];

export interface StatusCopy {
  title: string;
  message: string;
}

export interface AboutMessages {
  title: string;
  heading: string;
  version: string;
  /** W1b: версия ядра записи (без служебной терминологии в UI). */
  agentVersion: string;
  device: string;
  /** iter77: строка «План» в About (значение показывается только если известно). */
  plan: string;
  download: string;
  copyLog: string;
  sendDiagnostics: string;
  checkUpdates: string;
  licenses: string;
  closeHint: string;
  logCopied: string;
  updatesChecking: string;
  /** FIX-UPDATE-CHECK-FEEDBACK: результат ручной проверки обновлений. */
  updateLatest: string;
  updateAvailable: string;
  updateError: string;
  errorReporting: string;
  errorReportingHint: string;
  errorReportingConnected: string;
  errorReportingNotConfigured: string;
  errorReportingOff: string;
  diagnosticsConsentHint: string;
  diagnosticsSending: string;
  diagnosticsSent: string;
  diagnosticsFailed: string;
}

/**
 * Формы счётного существительного: RU — one/few/many, EN — one/many
 * (`few` в EN не используется, но обязателен для единого типа).
 */
export interface CountForms {
  one: string;
  few: string;
  many: string;
}

export interface NotificationMessages {
  touchdownGenericTitle: string;
  touchdownTitle: string;
  touchdownBody: string;
  touchdownBodyNoBounce: string;
  touchdownBounce: string;
  landingNoBounce: string;
  landingBounce: string;
  touchAndGo: string;
  /** score-preview.md §4: суффикс тоста, пока сервер не подтвердил балл. */
  touchdownPreliminarySuffix: string;
  authConfirmedTitle: string;
  authConfirmedBody: string;
  syncErrorTitle: string;
  syncErrorBody: string;
  syncErrorFatalTitle: string;
  syncErrorFatalBody: string;
  updateTitle: string;
  updateBody: string;
  updateBodyReady: string;
  agentStoppedTitle: string;
  agentStoppedBody: string;
  deviceCodeTitle: string;
  deviceCodeBody: string;
  /** CD-4.3: лимит устройств / несовпадение машины + ссылка на управление. */
  deviceLimitTitle: string;
  deviceLimitBody: string;
  machineMismatchTitle: string;
  machineMismatchBody: string;
  manageDevices: string;
}

export interface DesktopMessages {
  status: {
    windowTitle: string;
    userCodeMessage: string;
    agentStoppedMessage: string;
    safeStorageUnavailable: string;
    /** Диагностика: offline-страница открыта вне Electron-оболочки. */
    bridgeUnavailable: string;
    loading: StatusCopy;
    copies: Record<AgentStatusKind, StatusCopy>;
    /** T-CLIENT3: переключатель языка окна (RU/EN). */
    language: {
      label: string;
      /** Самоназвание языка (не переводится). */
      ru: string;
      en: string;
    };
    currentFlight: {
      aircraft: string;
      flight: string;
      points: string;
    };
    /**
     * SIM-STATUS-1: компактная строка состояния источника/полёта/данных.
     * Сим-агностичные формулировки: конкретный сим подставляется в `{sim}`.
     */
    simulator: {
      /** W1b: строка только при `simConnected === true`. */
      syncing: string;
      flight: {
        recording: string;
        ended: string;
        none: string;
      };
      data: {
        fresh: string;
        stale: string;
        retrying: string;
        retry: string;
        age: string;
      };
      transport: {
        degraded: string;
      };
      /** T4: очередь — только рейсы, точки/события отдельным уточнением. */
      pendingFlights: CountForms;
      pendingPoints: CountForms;
      pendingEvents: CountForms;
    };
    /** Карточка последней посадки в окне статуса (T115). */
    lastLanding: {
      overline: string;
      seq: string;
      score: string;
      vs: string;
      fpm: string;
      noBounce: string;
      bounce: string;
      touchAndGo: string;
      /** score-preview.md §4: балл ещё не подтверждён сервером. */
      preliminary: string;
      /** Балл пришёл от сервера (предпросмотр/финал). */
      confirmed: string;
      grade: Record<ScoreGrade, string>;
    };
    outbox: {
      title: string;
      lastSync: string;
      /** T-CLIENT3: только подпись строки синка (значение — отдельным mono-узлом). */
      lastSyncLabel: string;
      never: string;
    };
    device: {
      label: string;
    };
    /** T-CLIENT2: состояние привязки ПК к аккаунту. */
    pairing: {
      notLinked: string;
      linked: string;
      account: string;
    };
    /** iter77: план-строка premium-скина (Pro/Lifetime/Trial). */
    plan: {
      pro: string;
      lifetime: string;
      trial: string;
      /** F2: aria-label план-чипа (Pro/Lifetime) в шапке status и в About. */
      chipAria: string;
      /** F2: aria-label trial-чипа (дни и остаток AI-разборов). */
      trialAria: string;
      /** F2: значение строки «План» в About для Free. */
      free: string;
      /** F2: короткий план для чипа в шапке status и префикса трея. */
      lifetimeShort: string;
      /** F2: короткий Plan для префикса статус-строки трея. */
      trialShort: string;
    };
    actions: {
      syncNow: string;
      openSite: string;
      stopAgent: string;
      startAgent: string;
      about: string;
      restartAgent: string;
      openLogs: string;
    };
    banners: {
      offline: string;
      agentError: string;
      connecting: string;
    };
    footer: {
      ago: string;
      now: string;
      justNow: string;
      min: string;
      minAgo: string;
    };
    deviceCode: {
      overline: string;
      pending: string;
      expired: string;
      expiresAt: string;
      copy: string;
      copied: string;
      /** T-CLIENT2: подтверждение — во внешнем браузере. */
      openSite: string;
      openInBrowser: string;
      requestNew: string;
      readOnlyHint: string;
    };
    /** Окно статуса: неинтрузивное обновление (T132, T-CLIENT2). */
    update: {
      ready: string;
      install: string;
      deferred: string;
      check: string;
    };
  };
  tray: {
    prefix: string;
    /** F2: disabled статус-строка меню с планом (`{plan} · {status}`). */
    statusWithPlan: string;
    tooltips: Record<AgentStatusKind, string>;
    menu: {
      openStatus: string;
      openSite: string;
      dashboard: string;
      recentFlights: string;
      /** T-CLIENT3: подменю выбора языка (канон §1.5/§4.3). */
      language: string;
      startAgent: string;
      stopAgent: string;
      syncNow: string;
      syncNowDisabled: string;
      notifications: string;
      notifTouchdown: string;
      notifSyncError: string;
      notifUpdates: string;
      autostart: string;
      /** Трей: переключатель единственного action-required уведомления. */
      authAlertsToggle: string;
      checkUpdates: string;
      updateNone: string;
      updateReady: string;
      updateDeferred: string;
      updateLater: string;
      about: string;
      quit: string;
      recordingConfirmTitle: string;
      recordingConfirmBody: string;
      recordingConfirmStop: string;
      stopConfirmCancel: string;
      copyCode: string;
      openInBrowser: string;
    };
  };
  notifications: NotificationMessages;
  about: AboutMessages;
  /** T-CLIENT3: контекстное меню правого клика для редактируемых полей. */
  editMenu: {
    cut: string;
    copy: string;
    paste: string;
    selectAll: string;
  };
  /** DESKTOP-UX-POLISH: подписи кнопок кастомного тайтлбара (frame:false). */
  windowControls: {
    minimize: string;
    close: string;
  };
}
