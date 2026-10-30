/**
 * Встречная/боковая составляющие ветра (T-weather). Чистая функция: без I/O,
 * времени и случайности — пригодна и серверу, и агенту.
 *
 * Соглашение по знаку:
 * - `wind_dir_deg` — метеорологическое направление (откуда дует);
 * - `runway_heading_deg` — курс ВПП/ВС (куда движется);
 * - `headwind_kt > 0` — встречный, `< 0` — попутный;
 * - `crosswind_kt > 0` — ветер справа, `< 0` — слева.
 */

export interface WindComponents {
  headwind_kt: number;
  crosswind_kt: number;
}

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function normalizeDeg(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function round1(value: number): number {
  // `+ 0` убирает `-0`, который иначе протекает в JSON/сравнения.
  return Math.round(value * 10) / 10 + 0;
}

/**
 * Проекция ветра на ось ВПП. Возвращает `null`, если направление/скорость ветра
 * или курс ВПП отсутствуют/не конечны (старые рейсы → метрики остаются `null`).
 */
export function computeWindComponents(
  windDirDeg: number | null | undefined,
  windSpeedKt: number | null | undefined,
  runwayHeadingDeg: number | null | undefined,
): WindComponents | null {
  if (
    typeof windDirDeg !== 'number' ||
    !Number.isFinite(windDirDeg) ||
    typeof windSpeedKt !== 'number' ||
    !Number.isFinite(windSpeedKt) ||
    windSpeedKt < 0 ||
    typeof runwayHeadingDeg !== 'number' ||
    !Number.isFinite(runwayHeadingDeg)
  ) {
    return null;
  }
  const delta = toRadians(normalizeDeg(windDirDeg) - normalizeDeg(runwayHeadingDeg));
  return {
    headwind_kt: round1(windSpeedKt * Math.cos(delta)),
    crosswind_kt: round1(windSpeedKt * Math.sin(delta)),
  };
}

/**
 * Круговая средняя направлений ветра (градусы). Обычное среднее ломается на
 * переходе 359°→0°; здесь усредняются векторы. Пустой список → `null`.
 */
export function circularMeanDeg(directions: readonly number[]): number | null {
  let sumSin = 0;
  let sumCos = 0;
  let count = 0;
  for (const dir of directions) {
    if (typeof dir !== 'number' || !Number.isFinite(dir)) continue;
    const rad = toRadians(dir);
    sumSin += Math.sin(rad);
    sumCos += Math.cos(rad);
    count += 1;
  }
  if (count === 0) return null;
  const mean = (Math.atan2(sumSin, sumCos) * 180) / Math.PI;
  const rounded = round1(normalizeDeg(mean));
  // Округление у перехода 0/360 может дать ровно 360 — нормализуем к 0.
  return rounded >= 360 ? 0 : rounded;
}
