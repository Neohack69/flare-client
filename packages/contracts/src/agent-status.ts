import type { AgentStatusEvent } from './desktop.js';
import type { ScoreGrade } from './scoring.js';

/**
 * `agentStatusMap` — единый источник истины «состояние агента → цвет/иконка/
 * i18n-ключ/tray-глиф/severity/действие» (desktop-client.md §3).
 *
 * Живёт в `contracts` (листовой пакет без React/Electron), чтобы его одинаково
 * использовали main (трей, уведомления), локальные страницы renderer и сайт.
 * Цвет — никогда не единственный носитель смысла: всегда иконка + текст.
 */

export const AGENT_STATUS_ICONS = [
  'log-in',
  'radar',
  'plug',
  'circle-dot',
  'plane-landing',
  'refresh-cw',
  'cloud-check',
  'cloud-off',
  'triangle-alert',
  'octagon-alert',
  'power',
] as const;
export type AgentStatusIcon = (typeof AGENT_STATUS_ICONS)[number];

export const AGENT_STATUS_SEVERITIES = [
  'muted',
  'info',
  'success',
  'active',
  'caution',
  'danger',
  'grade',
] as const;
export type AgentStatusSeverity = (typeof AGENT_STATUS_SEVERITIES)[number];

export type AgentStatusAction =
  | 'none'
  | 'open-site'
  | 'start-agent'
  | 'stop-agent'
  | 'sync-now';

/**
 * Состояния, которые понимает UI. `not_started`/`agent_error` — производные от
 * рантайма хоста, `sync_error_fatal` — `sync_error` с `quality === 'fatal'`.
 */
export const AGENT_STATUS_KINDS = [
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
] as const;
export type AgentStatusKind = (typeof AGENT_STATUS_KINDS)[number];

/** Состояния, которые умеет рисовать иконка трея (без производного fatal-алиаса). */
export type TrayStatusKind = Exclude<AgentStatusKind, 'sync_error_fatal'>;

export interface AgentStatusDescriptor {
  /** CSS-переменная токена (для renderer/сайта). */
  token: string;
  /** Hex для main-процесса (иконки/меню/уведомлений) — зеркало токена. */
  hex: string;
  icon: AgentStatusIcon;
  /** Цвет status dot трея (совпадает с `hex`). */
  trayGlyph: string;
  i18nKey: string;
  severity: AgentStatusSeverity;
  action: AgentStatusAction;
}

/** Grade → цвет (desktop-client.md §3). */
export const GRADE_HEX: Record<ScoreGrade, string> = {
  butter: '#ffd86b',
  good: '#56e39f',
  firm: '#a78bfa',
  hard: '#ff9558',
  crash: '#ff5c6c',
};

/** Неизвестный/неполный балл — не красим в grade. */
export const GRADE_UNKNOWN_HEX = '#7a88a6';

export function gradeHex(grade: ScoreGrade | null | undefined): string {
  return grade ? GRADE_HEX[grade] : GRADE_UNKNOWN_HEX;
}

export const agentStatusMap: Record<AgentStatusKind, AgentStatusDescriptor> = {
  auth_required: {
    token: '--warning',
    hex: '#f5b942',
    icon: 'log-in',
    trayGlyph: '#f5b942',
    i18nKey: 'agent.status.auth_required',
    severity: 'caution',
    action: 'open-site',
  },
  sim_waiting: {
    token: '--info',
    hex: '#4cc3ff',
    icon: 'radar',
    trayGlyph: '#4cc3ff',
    i18nKey: 'agent.status.sim_waiting',
    severity: 'info',
    action: 'none',
  },
  connected_idle: {
    token: '--success',
    hex: '#3ddc97',
    icon: 'plug',
    trayGlyph: '#3ddc97',
    i18nKey: 'agent.status.connected_idle',
    severity: 'success',
    action: 'none',
  },
  recording: {
    token: '--accent-primary',
    hex: '#5b9fd4',
    icon: 'circle-dot',
    trayGlyph: '#5b9fd4',
    i18nKey: 'agent.status.recording',
    severity: 'active',
    action: 'stop-agent',
  },
  touchdown: {
    token: '--grade-good',
    hex: '#56e39f',
    icon: 'plane-landing',
    trayGlyph: '#56e39f',
    i18nKey: 'agent.status.touchdown',
    severity: 'grade',
    action: 'open-site',
  },
  syncing: {
    token: '--info',
    hex: '#4cc3ff',
    icon: 'refresh-cw',
    trayGlyph: '#4cc3ff',
    i18nKey: 'agent.status.syncing',
    severity: 'info',
    action: 'sync-now',
  },
  sync_ok: {
    token: '--success',
    hex: '#3ddc97',
    icon: 'cloud-check',
    trayGlyph: '#3ddc97',
    i18nKey: 'agent.status.sync_ok',
    severity: 'success',
    action: 'none',
  },
  sync_error: {
    token: '--warning',
    hex: '#f5b942',
    icon: 'cloud-off',
    trayGlyph: '#f5b942',
    i18nKey: 'agent.status.sync_error',
    severity: 'caution',
    action: 'sync-now',
  },
  sync_error_fatal: {
    token: '--danger',
    hex: '#ff5c6c',
    icon: 'triangle-alert',
    trayGlyph: '#ff5c6c',
    i18nKey: 'agent.status.sync_error_fatal',
    severity: 'danger',
    action: 'open-site',
  },
  agent_error: {
    token: '--danger',
    hex: '#ff5c6c',
    icon: 'octagon-alert',
    trayGlyph: '#ff5c6c',
    i18nKey: 'agent.status.agent_error',
    severity: 'danger',
    action: 'start-agent',
  },
  not_started: {
    token: '--text-muted',
    hex: '#7a88a6',
    icon: 'power',
    trayGlyph: '#7a88a6',
    i18nKey: 'agent.status.not_started',
    severity: 'muted',
    action: 'start-agent',
  },
};

/** Приоритет доминирующего состояния (desktop-client.md §3). */
export const AGENT_STATUS_PRIORITY: readonly AgentStatusKind[] = [
  'agent_error',
  'not_started',
  'auth_required',
  'recording',
  'touchdown',
  'syncing',
  'sync_error_fatal',
  'sync_error',
  'sync_ok',
  'connected_idle',
  'sim_waiting',
];

export interface AgentStatusContext {
  agentRunning: boolean;
  recording: boolean;
  agentError?: boolean;
}

/**
 * Одно доминирующее состояние из последнего события и рантайм-флагов.
 * `recording` важнее `syncing`/`sync_error` (те — вторичный индикатор); при
 * записи сохраняем `touchdown` как транзиентную вспышку.
 */
export function resolveStatusKind(
  event: AgentStatusEvent | null,
  context: AgentStatusContext,
): AgentStatusKind {
  if (context.agentError) return 'agent_error';
  if (!context.agentRunning) return 'not_started';
  if (!event) return 'sim_waiting';
  if (event.state === 'auth_required') return 'auth_required';
  if (context.recording && event.state !== 'touchdown') return 'recording';
  if (event.state === 'sync_error' && event.quality === 'fatal') return 'sync_error_fatal';
  // `authorized` транзиентное и не доминирует: показываем как «подключено».
  if (event.state === 'authorized') return 'connected_idle';
  return event.state;
}

/** Дескриптор состояния с учётом grade (только для `touchdown`). */
export function statusDescriptor(
  kind: AgentStatusKind,
  grade?: ScoreGrade | null,
): AgentStatusDescriptor {
  const base = agentStatusMap[kind];
  if (kind !== 'touchdown' || grade == null) return base;
  const hex = gradeHex(grade);
  return { ...base, hex, trayGlyph: hex };
}
