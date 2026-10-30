/** Результат ручной/фоновой проверки обновлений (main → renderer). */
export type UpdateStatusKind =
  | 'checking'
  | 'not-available'
  | 'available'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  kind: UpdateStatusKind;
  version?: string;
  message?: string;
}

/** IPC-канал событий апдейтера (окна status/about слушают через preload). */
export const UPDATE_STATUS_CHANNEL = 'desktop:update-status';
