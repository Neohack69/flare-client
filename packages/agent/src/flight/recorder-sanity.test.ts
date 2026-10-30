import { describe, expect, it, vi } from 'vitest';

import { MemoryOutboxBuffer } from '../buffer/memory-buffer.js';
import { MockSimConnectAdapter } from '../sim/mock-adapter.js';
import type { SimSourceId } from '../sim/source.js';
import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';
import { seededUuidGenerator } from '../util/id.js';
import { FlightRecorder } from './recorder.js';

/** Тот же mock-источник, но с меткой X-Plane (проверяем source-aware guard). */
class MockXPlaneSource extends MockSimConnectAdapter {
  readonly id: SimSourceId = 'xplane12';
}

/** Живые XP-замеры стоянки (12.4.3): IAS −8.16 kt, AGL −0.46 ft, gs 0, на земле. */
function xpParkedSample(offsetS: number, overrides: Parameters<typeof makeSample>[1] = {}) {
  return makeSample(isoAt(BASE_MS, offsetS * 1_000), {
    lat: 41.2753,
    lon: 28.7519,
    alt_ft: 325,
    agl_ft: -0.46,
    gs_kt: 0,
    ias_kt: -8.16,
    vs_fpm: 0,
    g: 1,
    on_ground: true,
    engine_running: true,
    ...overrides,
  });
}

/**
 * P0 (data integrity): мусорные кадры меню/выбора ВС не должны стартовать
 * рейс, писать точки или порождать посадку. Регресс прод-инцидента:
 * `lat 0 / lon 90`, `alt 16632`, `agl 16415`, `on_ground=false`.
 */
function createRecorder(options: { settleFrames?: number; warn?: ReturnType<typeof vi.fn> } = {}) {
  const adapter = new MockSimConnectAdapter();
  const buffer = new MemoryOutboxBuffer();
  const recorder = new FlightRecorder({
    loadQuarantineS: 0,
    adapter,
    buffer,
    idGenerator: seededUuidGenerator(),
    aircraftIcao: 'B738',
    autoWatchdog: false,
    settleFrames: options.settleFrames ?? 3,
    warn: options.warn as ((message: string, meta?: Record<string, unknown>) => void) | undefined,
  });
  return { adapter, buffer, recorder };
}

/** Кадры меню/загрузки: координаты null island, произвольные высоты. */
function pushMenuGarbage(
  adapter: MockSimConnectAdapter,
  count: number,
  startOffsetS = 0,
): void {
  for (let i = 0; i < count; i += 1) {
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, (startOffsetS + i) * 1000), {
        lat: 0,
        lon: 90,
        alt_ft: 16632,
        agl_ft: 16415,
        on_ground: false,
        gs_kt: 250,
        vs_fpm: 1200,
        ias_kt: 240,
      }),
    );
  }
}

describe('FlightRecorder — правдоподобие телеметрии (P0)', () => {
  it('трек из null island не стартует рейс и не создаёт посадку', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const started = vi.fn();
    const ended = vi.fn();
    const scores = vi.fn();
    recorder.on('flight_started', started);
    recorder.on('flight_ended', ended);
    recorder.on('score', scores);

    await recorder.start();
    pushMenuGarbage(adapter, 40);

    expect(started).not.toHaveBeenCalled();
    expect(recorder.state.recording).toBe(false);
    expect(buffer.loadFlights()).toHaveLength(0);

    await recorder.stop();
    expect(ended).not.toHaveBeenCalled();
    expect(scores).not.toHaveBeenCalled();
    expect(buffer.loadFlights()).toHaveLength(0);
  });

  it('«сим в меню»: рейс не стартует на мусоре, стартует после реальных данных', async () => {
    const warn = vi.fn();
    const { adapter, recorder } = createRecorder({ settleFrames: 3, warn });
    const started = vi.fn();
    recorder.on('flight_started', started);
    await recorder.start();

    // Меню: мусорные кадры. Ни одного старта, лог с причиной (rate-limited).
    pushMenuGarbage(adapter, 5);
    expect(started).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ reason: 'null_island' });

    // Вышли из меню: реальные данные. Первые кадры оседают, третий — старт.
    const real = (offsetS: number, overrides: Parameters<typeof makeSample>[1] = {}) =>
      makeSample(isoAt(BASE_MS, offsetS * 1000), {
        on_ground: true,
        agl_ft: 5,
        alt_ft: 400,
        gs_kt: 12,
        engine_running: true,
        ...overrides,
      });
    adapter.pushSample(real(10));
    adapter.pushSample(real(11));
    expect(started).not.toHaveBeenCalled();
    adapter.pushSample(real(12));
    expect(started).toHaveBeenCalledTimes(1);
    expect(recorder.state.recording).toBe(true);
    await recorder.stop();
  });

  it('чистый старт (без мусора) не ждёт окна оседания — валидный рейс не задержан', async () => {
    const { adapter, recorder } = createRecorder({ settleFrames: 3 });
    const started = vi.fn();
    recorder.on('flight_started', started);
    await recorder.start();

    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 0), {
        on_ground: true,
        agl_ft: 0,
        gs_kt: 0,
        engine_running: true,
      }),
    );
    expect(started).toHaveBeenCalledTimes(1);
    await recorder.stop();
  });

  it('мусорный кадр в полёте не пишется в трек', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    await recorder.start();

    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 0), { on_ground: true, agl_ft: 0, gs_kt: 0, engine_running: true }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 1_000), {
        on_ground: false,
        agl_ft: 800,
        alt_ft: 1_400,
        gs_kt: 160,
        vs_fpm: 700,
      }),
    );
    // Мусорный кадр (null island) посреди записи — в трек попасть не должен.
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 2_000), {
        lat: 0,
        lon: 90,
        on_ground: false,
        agl_ft: 16_415,
        alt_ft: 16_632,
        gs_kt: 250,
        vs_fpm: 1_200,
      }),
    );

    const flightId = recorder.state.client_flight_id ?? '';
    const points = buffer.loadPoints(flightId);
    expect(points.length).toBeGreaterThan(0);
    expect(points.some((point) => point.lat === 0 && point.lon === 90)).toBe(false);
    await recorder.stop();
  });
});

/**
 * Регресс прод-дефекта: на стоянке X-Plane аэродинамика даёт малую
 * отрицательную IAS (≈ −8.16 kt) и отрицательный AGL (≈ −0.46 ft). MSFS-
 * ориентированный guard отвергал такие кадры целиком (`ias_out_of_range`) →
 * запись не начиналась. Source-aware проверка (`sanity.ts`) допускает
 * легитимную полосу X-Plane, не меняя поведение MSFS.
 */
describe('FlightRecorder — X-Plane стоянка/разбег (регресс отрицательной IAS)', () => {
  it('X-Plane: кадры на стоянке стартуют запись, разбег продолжается', async () => {
    const source = new MockXPlaneSource();
    const buffer = new MemoryOutboxBuffer();
    const recorder = new FlightRecorder({
      loadQuarantineS: 0,
      source,
      buffer,
      idGenerator: seededUuidGenerator(),
      aircraftIcao: 'A320',
      autoWatchdog: false,
    });
    const started = vi.fn();
    recorder.on('flight_started', started);
    await recorder.start();

    source.pushSample(xpParkedSample(0));
    expect(started).toHaveBeenCalledTimes(1);
    expect(recorder.state.recording).toBe(true);

    // Разбег: положительная IAS при том же отрицательном AGL — кадр принят.
    source.pushSample(xpParkedSample(1, { ias_kt: 45, gs_kt: 45, agl_ft: -0.16 }));
    expect(recorder.state.recording).toBe(true);

    await recorder.stop();
  });

  it('MSFS: тот же кадр с отрицательной IAS отвергается, рейс не стартует', async () => {
    const adapter = new MockSimConnectAdapter();
    const recorder = new FlightRecorder({
      loadQuarantineS: 0,
      adapter,
      buffer: new MemoryOutboxBuffer(),
      idGenerator: seededUuidGenerator(),
      aircraftIcao: 'B738',
      autoWatchdog: false,
    });
    const started = vi.fn();
    recorder.on('flight_started', started);
    await recorder.start();

    adapter.pushSample(xpParkedSample(0));
    expect(started).not.toHaveBeenCalled();
    expect(recorder.state.recording).toBe(false);

    await recorder.stop();
  });
});
