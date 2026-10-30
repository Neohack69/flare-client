/** Renderer → main: пересчитать высоту окна статуса по фактическому контенту (CSS px). */
export const STATUS_FIT_CHANNEL = 'desktop:status-fit';

/** Debounce re-fit (как в about): окно не дёргается на каждом кадре раскладки. */
export const STATUS_FIT_DEBOUNCE_MS = 120;

/** Реагируем только на реальную разницу высот, иначе ResizeObserver зацикливается. */
export const STATUS_FIT_EPSILON_PX = 8;
