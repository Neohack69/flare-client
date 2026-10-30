import { QUALITY_BITS } from '@flightlog/contracts';
import { describe, expect, it, vi } from 'vitest';

import { MemoryOutboxBuffer } from '../buffer/memory-buffer.js';
import { MockSimConnectAdapter } from '../sim/mock-adapter.js';
import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';
import { seededUuidGenerator } from '../util/id.js';
import type { Clock } from '../util/clock.js';
import type {
  SimConnectAdapter,
  SimConnectAdapterEvents,
  SimConnectOpenInfo,
  TelemetrySample,
} from '../sim/types.js';
import { FlightRecorder, type FlightEndedInfo, type FlightRecorderOptions } from './recorder.js';

const OPEN_INFO: SimConnectOpenInfo = {
  applicationName: 'Microsoft Flight Simulator 2024',
  applicationVersion: '1.39.9.0',
  simConnectVersion: '0.0.0.0',
};

/** Адаптер со счётчиком обработчиков — для проверки отсутствия listener-leak. */
class CountingAdapter implements SimConnectAdapter {
  connected = false;
  private readonly handlers = new Map<
    keyof SimConnectAdapterEvents,
    Set<(payload: unknown) => void>
  >();

  async connect(): Promise<SimConnectOpenInfo> {
    this.connected = true;
    return OPEN_INFO;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  on<K extends keyof SimConnectAdapterEvents>(event: K, handler: SimConnectAdapterEvents[K]): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as unknown as (payload: unknown) => void);
  }

  off<K extends keyof SimConnectAdapterEvents>(
    event: K,
    handler: SimConnectAdapterEvents[K],
  ): void {
    this.handlers.get(event)?.delete(handler as unknown as (payload: unknown) => void);
  }

  listenerCount(event: keyof SimConnectAdapterEvents): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  push(sample: TelemetrySample): void {
    for (const handler of this.handlers.get('sample') ?? []) handler(sample);
  }
}

/** Мутируемые часы для детерминированной проверки watchdog. */
function mutableClock(startIso: string): Clock & { advance(ms: number): void } {
  let ms = Date.parse(startIso);
  return {
    nowMs: () => ms,
    nowIso: () => new Date(ms).toISOString(),
    advance: (delta) => {
      ms += delta;
    },
  };
}

/** Плотный участок: `hz` Гц на протяжении [fromS, toS] секунд. */
function dense(
  at: (offsetS: number, overrides?: Parameters<typeof makeSample>[1]) => void,
  fromS: number,
  toS: number,
  hz: number,
  overrides: Parameters<typeof makeSample>[1] = {},
): void {
  const step = 1 / hz;
  for (let t = fromS; t <= toS + 1e-9; t += step) at(Number(t.toFixed(6)), overrides);
}

function buildTimeline(): TelemetrySample[] {
  const samples: TelemetrySample[] = [];
  const at = (offsetS: number, overrides: Parameters<typeof makeSample>[1] = {}) => {
    samples.push(makeSample(isoAt(BASE_MS, offsetS * 1000), overrides));
  };

  at(0, { gs_kt: 0, on_ground: true, engine_running: true, alt_ft: 600 });
  at(2, { gs_kt: 15, on_ground: true, alt_ft: 600 });
  at(6, { gs_kt: 60, on_ground: true, alt_ft: 600 });
  at(8, { gs_kt: 100, on_ground: false, agl_ft: 30, vs_fpm: 800, alt_ft: 650 });
  // Набор высоты идёт по кадрам: скачок >5 000 ft за один сэмпл — телепорт.
  for (let s = 9; s <= 15; s += 1) {
    at(s, {
      gs_kt: 250,
      on_ground: false,
      agl_ft: 4_500 * (s - 8) + 30,
      vs_fpm: 2_500,
      alt_ft: 650 + 4_500 * (s - 8),
      ias_kt: 200,
    });
  }
  for (let s = 16; s <= 40; s += 1) {
    at(s, { gs_kt: 440, on_ground: false, agl_ft: 30_000, vs_fpm: 0, alt_ft: 30_600, ias_kt: 250 });
  }
  // Снижение также по кадрам (скачок >5 000 ft за сэмпл — телепорт).
  for (let s = 41; s <= 44; s += 1) {
    at(s, {
      gs_kt: 300,
      on_ground: false,
      agl_ft: 30_600 - 5_000 * (s - 40) - 600,
      vs_fpm: -3_000,
      alt_ft: 30_600 - 5_000 * (s - 40),
      ias_kt: 250,
    });
  }
  at(44.5, { gs_kt: 200, on_ground: false, agl_ft: 5_000, vs_fpm: -1_500, alt_ft: 5_600, ias_kt: 180 });
  at(45, { gs_kt: 150, on_ground: false, agl_ft: 400, vs_fpm: -700, alt_ft: 1_000, ias_kt: 145 });
  for (let i = 0; i < 10; i += 1) {
    at(46 + i * 0.1, {
      gs_kt: 140,
      on_ground: false,
      agl_ft: 80 - i * 8,
      vs_fpm: -450,
      ias_kt: 140,
      g: 1.05,
    });
  }
  at(47, { gs_kt: 120, on_ground: true, agl_ft: 0, vs_fpm: -180, g: 1.35, ias_kt: 120 });
  at(48, { gs_kt: 60, on_ground: true, agl_ft: 0, vs_fpm: 0, g: 1.0 });
  at(60, { gs_kt: 0, on_ground: true, vs_fpm: 0, engine_running: false });
  at(63, { gs_kt: 0, on_ground: true, vs_fpm: 0, engine_running: false });
  at(64, { gs_kt: 0, on_ground: true, vs_fpm: 0, engine_running: false });
  return samples;
}

function createRecorder(options: { endEngineOffS?: number } = {}) {
  const adapter = new MockSimConnectAdapter();
  const buffer = new MemoryOutboxBuffer();
  const recorder = new FlightRecorder({
    loadQuarantineS: 0,
    adapter,
    buffer,
    idGenerator: seededUuidGenerator(),
    endEngineOffS: options.endEngineOffS ?? 3,
    endStationaryS: 600,
    aircraftIcao: 'B738',
  });
  return { adapter, buffer, recorder };
}

/** Чистая посадка 10 Гц (касание t=39) и пробег без выключения двигателя. */
function cleanLandingSamples(): TelemetrySample[] {
  const samples: TelemetrySample[] = [];
  const at = (offsetS: number, overrides: Parameters<typeof makeSample>[1] = {}) => {
    samples.push(makeSample(isoAt(BASE_MS, offsetS * 1000), overrides));
  };
  at(0, { gs_kt: 0, on_ground: true, engine_running: true });
  for (let t = 1; t <= 8; t += 1) at(t, { gs_kt: 25, on_ground: true, engine_running: true });
  dense(at, 9, 38, 10, {
    on_ground: false,
    agl_ft: 300,
    vs_fpm: -500,
    gs_kt: 150,
    ias_kt: 140,
    g: 1.05,
  });
  at(39, { on_ground: true, agl_ft: 0, vs_fpm: -180, g: 1.3, gs_kt: 120 });
  at(40, { on_ground: true, gs_kt: 60, vs_fpm: 0 });
  at(41, { on_ground: true, gs_kt: 20, vs_fpm: 0 });
  return samples;
}

describe('FlightRecorder (T8/T9, моки SimConnect)', () => {
  it('записывает полный рейс: фазы, события, точки и предпросмотр балла', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const started = vi.fn();
    const ended = vi.fn();
    const scores = vi.fn();
    const eventTypes: string[] = [];
    recorder.on('flight_started', started);
    recorder.on('flight_ended', ended);
    recorder.on('score', scores);
    recorder.on('event', (event) => eventTypes.push(event.type));

    await recorder.start();
    for (const sample of buildTimeline()) adapter.pushSample(sample);

    expect(started).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(scores).toHaveBeenCalledTimes(1);

    for (const type of ['engine_start', 'taxi', 'takeoff', 'touchdown', 'engine_stop', 'landing']) {
      expect(eventTypes).toContain(type);
    }

    const flightId = recorder.state.client_flight_id;
    expect(flightId).not.toBeNull();
    expect(recorder.state.recording).toBe(false);
    expect(recorder.state.phase).toBe('on_ground');
    expect(recorder.state.score_preview).not.toBeNull();
    expect(recorder.state.metrics?.vs_fpm).toBeLessThan(0);

    const flights = buffer.loadFlights();
    expect(flights).toHaveLength(1);
    expect(flights[0]?.status).toBe('completed');
    expect(flights[0]?.stats.end_reason).toBe('engine_stop');

    const points = buffer.loadPoints(flightId ?? '');
    expect(points.length).toBeGreaterThan(30);
    expect(points.map((point) => point.seq)).toEqual(points.map((_, index) => index + 1));
    for (const point of points) expect(point.client_flight_id).toBe(flightId);

    await recorder.stop();
  });

  it('backfill высокочастотного окна добавляет точки без дублей', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    await recorder.start();
    for (const sample of buildTimeline()) adapter.pushSample(sample);

    const flightId = recorder.state.client_flight_id ?? '';
    const points = buffer.loadPoints(flightId);
    const uniqueTs = new Set(points.map((point) => point.ts));
    expect(uniqueTs.size).toBe(points.length);
    // Окно касания (10 Гц) должно быть плотнее круиза (1 Гц).
    const dense = points.filter(
      (point) => point.ts >= isoAt(BASE_MS, 46_000) && point.ts <= isoAt(BASE_MS, 47_000),
    );
    expect(dense.length).toBeGreaterThanOrEqual(10);
    await recorder.stop();
  });

  it('FOQA-fidelity: кадр касания материализуется в трек, даже если 1 Гц-запись его пропустила', async () => {
    // Регрессия инцидента 2026-10-15 (A220-300 / BCS3): на заходе сэмплер пишет
    // ~1 Гц, окно 10 Гц включается только на касании. Кадр перехода `air→ground`
    // приходил <900 мс после предыдущей 1 Гц-записи, поэтому `push` его не
    // записывал, а backfill окна намеренно исключает якорь → серверная
    // `segmentLandings` брала СЛЕДУЮЩую наземную точку (+166 мс) и VS выходил
    // мягче (−111 вместо −114). Кадр касания обязан быть в треке.
    const { adapter, buffer, recorder } = createRecorder();
    const scores = vi.fn();
    recorder.on('score', scores);
    await recorder.start();

    const samples: TelemetrySample[] = [];
    const at = (offsetS: number, overrides: Parameters<typeof makeSample>[1] = {}) => {
      samples.push(makeSample(isoAt(BASE_MS, offsetS * 1000), overrides));
    };
    at(0, { gs_kt: 0, on_ground: true, engine_running: true });
    for (let t = 1; t <= 8; t += 1) at(t, { gs_kt: 25, on_ground: true, engine_running: true });
    // 10 Гц заход: 1 Гц-запись ложится на 9.0, 9.9, …, 37.8.
    dense(at, 9, 38, 10, {
      on_ground: false,
      agl_ft: 300,
      vs_fpm: -500,
      gs_kt: 150,
      ias_kt: 140,
      g: 1.05,
    });
    // Флаер: VS растёт по модулю к касанию; кадр касания t=38.3 (vs −114)
    // отстоит от 1 Гц-записи 37.8 на 500 мс → обычный `push` его пропускает.
    at(38.1, { on_ground: false, agl_ft: 20, vs_fpm: -120, gs_kt: 130, ias_kt: 135 });
    at(38.2, { on_ground: false, agl_ft: 10, vs_fpm: -171, gs_kt: 128, ias_kt: 134 });
    const contactTs = isoAt(BASE_MS, 38_300);
    at(38.3, { on_ground: true, agl_ft: 0, vs_fpm: -114, g: 1.14, gs_kt: 120 });
    // Следующая наземная точка (+100 мс) — её раньше и брал сервер (мягче).
    at(38.4, { on_ground: true, vs_fpm: -111, gs_kt: 110 });
    at(38.5, { on_ground: true, vs_fpm: -100, gs_kt: 90 });
    at(41, { on_ground: true, vs_fpm: 0, gs_kt: 0 });
    at(45, { on_ground: true, vs_fpm: 0, gs_kt: 0, engine_running: false });
    at(48, { on_ground: true, vs_fpm: 0, gs_kt: 0, engine_running: false });

    for (const sample of samples) adapter.pushSample(sample);

    const flightId = recorder.state.client_flight_id ?? '';
    const points = buffer.loadPoints(flightId);
    const contactPoint = points.find((point) => point.ts === contactTs);
    expect(contactPoint).toBeDefined();
    expect(contactPoint?.on_ground).toBe(true);
    expect(contactPoint?.vs_fpm).toBe(-114);
    // Следующая наземная точка тоже на месте — сервер не «съезжает» на неё.
    expect(points.find((p) => p.ts === isoAt(BASE_MS, 38_400))?.vs_fpm).toBe(-111);
    // Клиентский предпросмотр (сырой кадр перехода) совпадает с кадром в треке.
    expect(recorder.state.metrics?.vs_fpm).toBe(-114);
    await recorder.stop();
  });

  it('не начинает рейс на стоянке с выключенным двигателем', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const started = vi.fn();
    recorder.on('flight_started', started);
    await recorder.start();
    for (let i = 0; i < 5; i += 1) {
      adapter.pushSample(
        makeSample(isoAt(BASE_MS, i * 1000), { engine_running: false, gs_kt: 0, on_ground: true }),
      );
    }
    expect(started).not.toHaveBeenCalled();
    expect(buffer.loadFlights()).toHaveLength(0);
    await recorder.stop();
  });

  it('разрыв соединения завершает рейс и не оставляет in_progress', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const ended = vi.fn();
    recorder.on('flight_ended', ended);
    await recorder.start();
    adapter.pushSample(makeSample(isoAt(BASE_MS, 0), { gs_kt: 20, on_ground: true }));
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 1000), { on_ground: false, agl_ft: 1000, gs_kt: 200, vs_fpm: 900 }),
    );
    adapter.simulateDisconnect('sim closed');

    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]?.[0]).toMatchObject({ reason: 'sim_disconnected' });
    expect(recorder.state.recording).toBe(false);
    expect(buffer.loadFlights()[0]?.status).toBe('completed');
    // Обрыв до касания — данных о посадке нет, рейс неполный (T99).
    expect(ended.mock.calls[0]?.[0]).toMatchObject({
      is_partial: true,
      leaderboard_eligible: false,
    });
    await recorder.stop();
  });

  it('обрыв соединения после подтверждённой посадки → не partial и допуск в лидерборд (T99)', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const ended = vi.fn();
    recorder.on('flight_ended', ended);
    await recorder.start();
    for (const sample of cleanLandingSamples()) adapter.pushSample(sample);
    adapter.simulateDisconnect('sim closed after landing');

    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]?.[0]).toMatchObject({
      reason: 'sim_disconnected',
      is_partial: false,
      leaderboard_eligible: true,
    });
    const flight = buffer.loadFlights()[0];
    expect(flight?.stats.is_partial).toBe(false);
    expect(flight?.stats.leaderboard_eligible).toBe(true);
    expect(flight?.stats.end_reason).toBe('sim_disconnected');
    await recorder.stop();
  });

  it('WAVE 3b: посадочная масса (TOTAL WEIGHT, lb→кг) попадает в stats', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const ended = vi.fn();
    recorder.on('flight_ended', ended);
    await recorder.start();
    for (const sample of cleanLandingSamples()) {
      adapter.pushSample({ ...sample, total_weight_lb: 143_300 });
    }
    await recorder.stop();

    expect(ended).toHaveBeenCalledTimes(1);
    const flight = buffer.loadFlights()[0];
    // 143 300 lb ≈ 65 000 кг (точно: 0.45359237 кг/фунт).
    expect(flight?.stats.landing_weight_kg).toBe(65_000);
    expect(flight?.stats.landing_weight_source).toBe('sim');
  });

  it('WAVE 3b: без TOTAL WEIGHT масса остаётся null, источник null', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    await recorder.start();
    for (const sample of cleanLandingSamples()) adapter.pushSample(sample);
    await recorder.stop();

    const flight = buffer.loadFlights()[0];
    expect(flight?.stats.landing_weight_kg).toBeNull();
    expect(flight?.stats.landing_weight_source).toBeNull();
  });

  it('WAVE 4: FOQA-агрегаты (фазы/стабильность/события) и landings_analysis в stats', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    await recorder.start();
    for (const sample of cleanLandingSamples()) {
      adapter.pushSample({
        ...sample,
        gear_down: true,
        flaps_percent: 30,
        spoilers_armed: true,
        incidence_alpha_rad: 0.05,
        cg_percent: 31.5,
        surface_condition: 1,
        surface_type: 2,
        on_any_runway: true,
        radio_height_ft: sample.on_ground ? 0 : 20,
        hsi_has_localizer: true,
        hsi_cdi_needle: 0.3,
        hsi_cdi_needle_valid: true,
        hsi_gsi_needle: -0.1,
        hsi_gsi_needle_valid: true,
        nav_glide_slope_error_deg: -0.2,
        atc_runway_relative_z_m: -200,
        atc_runway_heading_deg: 245,
        atc_runway_length_m: 3000,
        n1_percent: [60, 60, null, null],
        throttle_percent: [8, 8, null, null],
        fuel_flow_pph: [2000, 2000, null, null],
        reverse_percent: [0, 0, null, null],
        reverse_engaged: false,
        engine_mode: 'idle',
      });
    }
    await recorder.stop();

    const stats = buffer.loadFlights()[0]?.stats as Record<string, unknown>;
    expect(stats.phases).toBeDefined();
    const phases = stats.phases as { approach: { avg_gs_kt: number | null } };
    expect(phases.approach.avg_gs_kt).toBe(150);
    expect(stats.stability).toBeDefined();
    expect(Array.isArray(stats.events)).toBe(true);

    const landingsAnalysis = stats.landings_analysis as Record<string, Record<string, unknown>>;
    const first = landingsAnalysis['1'];
    expect(first?.version).toBe('analysis/1');
    expect(first?.aoa_touchdown_deg).toBeCloseTo((0.05 * 180) / Math.PI, 1);
    expect(first?.cg_percent_touchdown).toBe(31.5);
    expect(first?.surface_condition).toBe(1);
    expect(first?.radio_height_touchdown_ft).toBe(0);
    expect(first?.touchdown_point).toMatchObject({ relative_z_m: -200, heading_deg_true: 245 });
    expect(stats.cg_percent_touchdown).toBe(31.5);
    expect(stats.radio_height_touchdown_ft).toBe(0);
    // ENGINE-MODE: агрегаты есть и в per-landing analysis, и в stats.
    expect(first?.engine_touchdown).toMatchObject({ mode: 'idle', n1_max_percent: 60 });
    expect(stats.engine_touchdown).toMatchObject({ mode: 'idle', n1_max_percent: 60 });
  });

  it('state отражает фазу, частоту и счётчики во время полёта', async () => {
    const { adapter, recorder } = createRecorder();
    await recorder.start();
    adapter.pushSample(makeSample(isoAt(BASE_MS, 0), { gs_kt: 0, on_ground: true }));
    adapter.pushSample(makeSample(isoAt(BASE_MS, 2000), { gs_kt: 15, on_ground: true }));
    const state = recorder.state;
    expect(state.recording).toBe(true);
    expect(state.phase).toBe('taxi');
    expect(state.rate_hz).toBe(1);
    expect(state.point_count).toBeGreaterThan(0);
    await recorder.stop();
  });

  it('watchdog no_data на наземной сессии отбрасывает её (не рейс, без landing)', async () => {
    const adapter = new MockSimConnectAdapter();
    const buffer = new MemoryOutboxBuffer();
    const clock = mutableClock(isoAt(BASE_MS, 0));
    const recorder = new FlightRecorder({
      loadQuarantineS: 0,
      adapter,
      buffer,
      clock,
      idGenerator: seededUuidGenerator(),
      autoWatchdog: false,
      endNoDataS: 120,
    });
    const ended = vi.fn();
    const eventTypes: string[] = [];
    recorder.on('flight_ended', ended);
    recorder.on('event', (event) => eventTypes.push(event.type));
    await recorder.start();
    adapter.pushSample(makeSample(isoAt(BASE_MS, 0), { gs_kt: 0, on_ground: true }));
    expect(recorder.state.recording).toBe(true);

    clock.advance(119_000);
    recorder.tick();
    expect(ended).not.toHaveBeenCalled();

    clock.advance(2_000);
    recorder.tick();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]?.[0]).toMatchObject({
      reason: 'no_data',
      landings_count: 0,
      discarded: true,
    });
    // Земляная сессия не эмитит landing и помечена как «без полёта» (сервер удалит).
    expect(buffer.loadFlights()[0]?.stats.no_flight_evidence).toBe(true);
    expect(eventTypes).not.toContain('landing');
    await recorder.stop();
  });

  it('watchdog no_data после подтверждённой посадки → не partial (T99)', async () => {
    const adapter = new MockSimConnectAdapter();
    const buffer = new MemoryOutboxBuffer();
    const clock = mutableClock(isoAt(BASE_MS, 0));
    const recorder = new FlightRecorder({
      loadQuarantineS: 0,
      adapter,
      buffer,
      clock,
      idGenerator: seededUuidGenerator(),
      autoWatchdog: false,
      endNoDataS: 120,
      aircraftIcao: 'B738',
    });
    const ended = vi.fn();
    recorder.on('flight_ended', ended);

    await recorder.start();
    for (const sample of cleanLandingSamples()) adapter.pushSample(sample);

    clock.advance(121_000);
    recorder.tick();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]?.[0]).toMatchObject({
      reason: 'no_data',
      is_partial: false,
      leaderboard_eligible: true,
    });
    await recorder.stop();
  });

  it('абандон-сценарий: контакт vs=0, g=1.00 → рейс завершается с посадкой (vs=null)', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const ended = vi.fn();
    const eventTypes: string[] = [];
    recorder.on('flight_ended', ended);
    recorder.on('event', (event) => eventTypes.push(event.type));
    await recorder.start();

    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 0), { gs_kt: 0, on_ground: true, engine_running: true }),
    );
    for (let t = 1; t <= 8; t += 1) {
      adapter.pushSample(
        makeSample(isoAt(BASE_MS, t * 1000), {
          gs_kt: 25,
          on_ground: true,
          engine_running: true,
        }),
      );
    }
    for (let t = 9; t <= 38; t += 1) {
      adapter.pushSample(
        makeSample(isoAt(BASE_MS, t * 1000), {
          on_ground: false,
          agl_ft: 300,
          vs_fpm: -500,
          gs_kt: 150,
          ias_kt: 140,
          g: 1.05,
        }),
      );
    }
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 39_000), {
        on_ground: true,
        agl_ft: 0,
        vs_fpm: 0,
        g: 1.0,
        gs_kt: 120,
      }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 40_000), { on_ground: true, gs_kt: 0, engine_running: false }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 43_000), { on_ground: true, gs_kt: 0, engine_running: false }),
    );

    expect(ended).toHaveBeenCalledTimes(1);
    const info = ended.mock.calls[0]?.[0] as FlightEndedInfo;
    expect(info).toMatchObject({
      reason: 'engine_stop',
      discarded: false,
      landings_count: 1,
    });
    expect(info.metrics?.vs_fpm).toBeNull();
    expect(info.metrics?.g_force).toBe(1);
    expect(info.landings[0]?.metrics.vs_fpm).toBeNull();
    expect(buffer.loadFlights()[0]?.stats.no_flight_evidence).toBe(false);
    expect(eventTypes).toContain('touchdown');
    expect(eventTypes).toContain('landing');
    await recorder.stop();
  });

  it('низкий FPS в окне касания → LOW_RATE_WINDOW, но допуск сохраняется', async () => {
    const samples: TelemetrySample[] = [];
    const at = (offsetS: number, overrides: Parameters<typeof makeSample>[1] = {}) => {
      samples.push(makeSample(isoAt(BASE_MS, offsetS * 1000), overrides));
    };
    at(0, { gs_kt: 0, on_ground: true, engine_running: true });
    for (let t = 1; t <= 8; t += 1) at(t, { gs_kt: 25, on_ground: true, engine_running: true });
    dense(at, 9, 38, 4, { on_ground: false, agl_ft: 300, vs_fpm: -500, gs_kt: 150, ias_kt: 140 });
    at(39, { on_ground: true, agl_ft: 0, vs_fpm: -180, g: 1.3, gs_kt: 120 });
    at(40, { on_ground: true, gs_kt: 0, vs_fpm: 0, engine_running: false });
    at(43, { on_ground: true, gs_kt: 0, engine_running: false });

    const { adapter, buffer, recorder } = createRecorder();
    const ended = vi.fn();
    recorder.on('flight_ended', ended);
    await recorder.start();
    for (const sample of samples) adapter.pushSample(sample);

    expect(ended).toHaveBeenCalledTimes(1);
    const info = ended.mock.calls[0]?.[0];
    expect(info?.leaderboard_eligible).toBe(true);
    expect(info?.quality_flags & QUALITY_BITS.LOW_RATE_WINDOW).toBe(QUALITY_BITS.LOW_RATE_WINDOW);
    expect(info?.confidence).toBeLessThan(1);

    const flagged = buffer
      .loadPoints(recorder.state.client_flight_id ?? '')
      .filter((point) => (point.quality & QUALITY_BITS.LOW_RATE_WINDOW) !== 0);
    expect(flagged.length).toBeGreaterThan(0);
    await recorder.stop();
  });

  it('гэп в окне касания → is_partial и GAP_BEFORE, но допуск сохраняется', async () => {
    const samples: TelemetrySample[] = [];
    const at = (offsetS: number, overrides: Parameters<typeof makeSample>[1] = {}) => {
      samples.push(makeSample(isoAt(BASE_MS, offsetS * 1000), overrides));
    };
    at(0, { gs_kt: 0, on_ground: true, engine_running: true });
    for (let t = 1; t <= 8; t += 1) at(t, { gs_kt: 25, on_ground: true, engine_running: true });
    dense(at, 9, 30, 10, { on_ground: false, agl_ft: 200, vs_fpm: -450, gs_kt: 150, ias_kt: 140 });
    dense(at, 33, 38, 10, { on_ground: false, agl_ft: 100, vs_fpm: -450, gs_kt: 145, ias_kt: 135 });
    at(39, { on_ground: true, agl_ft: 0, vs_fpm: -190, g: 1.3, gs_kt: 120 });
    at(40, { on_ground: true, gs_kt: 0, vs_fpm: 0, engine_running: false });
    at(43, { on_ground: true, gs_kt: 0, engine_running: false });

    const { adapter, recorder } = createRecorder();
    const ended = vi.fn();
    recorder.on('flight_ended', ended);
    await recorder.start();
    for (const sample of samples) adapter.pushSample(sample);

    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]?.[0]).toMatchObject({
      is_partial: true,
      leaderboard_eligible: true,
    });
    const flags = ended.mock.calls[0]?.[0]?.quality_flags ?? 0;
    expect(flags & QUALITY_BITS.GAP_BEFORE).toBe(QUALITY_BITS.GAP_BEFORE);
    await recorder.stop();
  });

  it('до-резолвит aircraft_icao, если первый кадр без ATC MODEL/TYPE', async () => {
    const adapter = new MockSimConnectAdapter();
    const buffer = new MemoryOutboxBuffer();
    const recorder = new FlightRecorder({
      loadQuarantineS: 0,
      adapter,
      buffer,
      idGenerator: seededUuidGenerator(),
      autoWatchdog: false,
      endEngineOffS: 3,
      endStationaryS: 600,
    });
    const started = vi.fn();
    const ended = vi.fn();
    recorder.on('flight_started', started);
    recorder.on('flight_ended', ended);
    await recorder.start();

    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 0), {
        on_ground: true,
        gs_kt: 0,
        atc_model: null,
        atc_type: null,
      }),
    );
    expect(started.mock.calls[0]?.[0]).toMatchObject({
      aircraft_icao: 'ZZZZ',
      aircraft_icao_source: 'unknown',
    });

    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 1_000), { on_ground: true, gs_kt: 0, atc_type: 'A320' }),
    );
    const flightId = recorder.state.client_flight_id ?? '';
    expect(buffer.getFlight(flightId)?.aircraft_icao).toBe('A320');

    // Реальный отрыв, чтобы сессия считалась рейсом (иначе она отбрасывается).
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 2_000), {
        on_ground: false,
        agl_ft: 100,
        gs_kt: 120,
        vs_fpm: 500,
        atc_type: 'A320',
      }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 3_000), {
        on_ground: true,
        gs_kt: 0,
        vs_fpm: -120,
        engine_running: true,
        atc_type: 'A320',
      }),
    );

    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 10_000), {
        on_ground: true,
        gs_kt: 0,
        engine_running: false,
        atc_type: 'A320',
      }),
    );
    expect(ended).toHaveBeenCalledTimes(1);
    expect(buffer.getFlight(flightId)?.stats.aircraft_icao_source).toBe('atc_type');
    await recorder.stop();
  });

  it('старт на земле: транзиентный on_ground=false не даёт ложный touchdown', async () => {
    const { adapter, recorder } = createRecorder();
    const ended = vi.fn();
    const touchdown = vi.fn();
    recorder.on('flight_ended', ended);
    recorder.on('event', (event) => {
      if (event.type === 'touchdown' || event.type === 'bounce') touchdown(event);
    });
    await recorder.start();

    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 0), {
        on_ground: false,
        agl_ft: 0,
        vs_fpm: 0,
        gs_kt: 0,
        engine_running: true,
      }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 1_000), {
        on_ground: true,
        agl_ft: 0,
        vs_fpm: 0,
        gs_kt: 0,
        engine_running: true,
      }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 2_000), { on_ground: true, gs_kt: 5, engine_running: true }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 5_000), { on_ground: true, gs_kt: 0, engine_running: false }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 9_000), { on_ground: true, gs_kt: 0, engine_running: false }),
    );

    expect(ended).toHaveBeenCalledTimes(1);
    expect(touchdown).not.toHaveBeenCalled();
    const info = ended.mock.calls[0]?.[0] as FlightEndedInfo;
    expect(info).toMatchObject({ landings_count: 0, touch_and_go_count: 0, score_preview: null });
    expect(info.landings).toEqual([]);
    await recorder.stop();
  });

  it('наземная сессия (без отрыва) не сохраняется как рейс и не эмитит landing', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const ended = vi.fn();
    const eventTypes: string[] = [];
    recorder.on('flight_ended', ended);
    recorder.on('event', (event) => eventTypes.push(event.type));
    await recorder.start();

    // Руление по перрону: двигатель работает, но ВС не отрывается.
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 0), { on_ground: true, gs_kt: 0, engine_running: true }),
    );
    for (let t = 1; t <= 5; t += 1) {
      adapter.pushSample(
        makeSample(isoAt(BASE_MS, t * 1000), { on_ground: true, gs_kt: 3.9, engine_running: true }),
      );
    }
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 10_000), { on_ground: true, gs_kt: 0, engine_running: false }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 14_000), { on_ground: true, gs_kt: 0, engine_running: false }),
    );

    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]?.[0]).toMatchObject({ discarded: true, landings_count: 0 });
    // Помечена как «без полёта» для серверной очистки, но landing не эмитится.
    const flights = buffer.loadFlights();
    expect(flights).toHaveLength(1);
    expect(flights[0]?.stats.no_flight_evidence).toBe(true);
    expect(eventTypes).not.toContain('landing');
    await recorder.stop();
  });

  it('руление с подскоком on_ground=false без отрыва → discarded, не completed', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const ended = vi.fn();
    const eventTypes: string[] = [];
    recorder.on('flight_ended', ended);
    recorder.on('event', (event) => eventTypes.push(event.type));
    await recorder.start();

    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 0), { on_ground: true, gs_kt: 0, engine_running: true, agl_ft: 0 }),
    );
    for (let t = 1; t <= 4; t += 1) {
      adapter.pushSample(
        makeSample(isoAt(BASE_MS, t * 1000), {
          on_ground: true,
          gs_kt: 15,
          engine_running: true,
          agl_ft: 0,
        }),
      );
    }
    // Кочка/подскок на рулении: один кадр on_ground=false с всплеском vs при
    // низком AGL. Это НЕ отрыв — сессия не должна стать completed.
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 5_000), {
        on_ground: false,
        gs_kt: 15,
        engine_running: true,
        agl_ft: 3,
        vs_fpm: 320,
      }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 7_000), {
        on_ground: true,
        gs_kt: 0,
        engine_running: false,
        agl_ft: 0,
      }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 11_000), {
        on_ground: true,
        gs_kt: 0,
        engine_running: false,
        agl_ft: 0,
      }),
    );

    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]?.[0]).toMatchObject({
      reason: 'engine_stop',
      discarded: true,
      landings_count: 0,
    });
    expect(buffer.loadFlights()[0]?.stats.no_flight_evidence).toBe(true);
    expect(eventTypes).not.toContain('landing');
    expect(eventTypes).not.toContain('takeoff');
    await recorder.stop();
  });

  it('slew-телепорт на земле не сохраняется как рейс (discarded, landings_count 0)', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const ended = vi.fn();
    const eventTypes: string[] = [];
    recorder.on('flight_ended', ended);
    recorder.on('event', (event) => eventTypes.push(event.type));
    await recorder.start();

    // Стоянка: сессия стартует на земле.
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 0), { on_ground: true, gs_kt: 0, engine_running: true }),
    );
    // Slew: ВС перенесено в воздух в другой точке (кадры с IS SLEW ACTIVE).
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 1_000), {
        slew: true,
        on_ground: false,
        agl_ft: 5000,
        vs_fpm: 2000,
        gs_kt: 220,
        lat: 40,
        lon: -74,
        engine_running: true,
      }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 2_000), {
        slew: true,
        on_ground: false,
        agl_ft: 3000,
        vs_fpm: -1500,
        gs_kt: 180,
        lat: 40.1,
        lon: -74.1,
        engine_running: true,
      }),
    );
    // Slew off: ВС на земле в новой точке (позиция уже ушла, флаг сброшен).
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 3_000), {
        on_ground: true,
        gs_kt: 0,
        agl_ft: 0,
        lat: 40.2,
        lon: -74.2,
        engine_running: true,
      }),
    );
    // Полная остановка с выключением двигателя завершает сессию.
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 6_000), {
        on_ground: true,
        gs_kt: 0,
        engine_running: false,
        lat: 40.2,
        lon: -74.2,
      }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 10_000), {
        on_ground: true,
        gs_kt: 0,
        engine_running: false,
        lat: 40.2,
        lon: -74.2,
      }),
    );

    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]?.[0]).toMatchObject({
      discarded: true,
      landings_count: 0,
      touch_and_go_count: 0,
    });
    expect(eventTypes).not.toContain('landing');
    expect(eventTypes).not.toContain('touchdown');
    expect(eventTypes).not.toContain('takeoff');
    const flight = buffer.loadFlights()[0];
    expect(flight?.stats.slew_seen).toBe(true);
    expect(flight?.stats.no_flight_evidence).toBe(true);
    await recorder.stop();
  });

  it('наземная сессия + slew в воздух + посадка → discarded без landing/touchdown/takeoff (BUG-1)', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const ended = vi.fn();
    const eventTypes: string[] = [];
    recorder.on('flight_ended', ended);
    recorder.on('event', (event) => eventTypes.push(event.type));
    await recorder.start();

    // Стоянка: сессия стартует на земле.
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 0), { on_ground: true, gs_kt: 0, engine_running: true, agl_ft: 0 }),
    );
    // Короткий slew: ВС мгновенно оказывается в воздухе (флаг сброшен, позиция ушла).
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 1_000), {
        slew: true,
        on_ground: false,
        agl_ft: 5000,
        vs_fpm: 2000,
        gs_kt: 220,
        lat: 40,
        lon: -74,
        engine_running: true,
      }),
    );
    // Остаётся в воздухе — отрыва так и не было.
    for (let t = 2; t <= 10; t += 1) {
      adapter.pushSample(
        makeSample(isoAt(BASE_MS, t * 1000), {
          on_ground: false,
          agl_ft: 5000,
          vs_fpm: 0,
          gs_kt: 220,
          lat: 40,
          lon: -74,
          engine_running: true,
        }),
      );
    }
    // Возврат на землю: без подтверждённого отрыва посадка не регистрируется.
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 11_000), {
        on_ground: true,
        agl_ft: 0,
        vs_fpm: -150,
        gs_kt: 60,
        lat: 40,
        lon: -74,
        engine_running: true,
      }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 12_000), {
        on_ground: true,
        gs_kt: 0,
        vs_fpm: 0,
        lat: 40,
        lon: -74,
        engine_running: true,
      }),
    );
    // Полная остановка с выключением двигателя завершает сессию.
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 16_000), {
        on_ground: true,
        gs_kt: 0,
        engine_running: false,
        lat: 40,
        lon: -74,
      }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 20_000), {
        on_ground: true,
        gs_kt: 0,
        engine_running: false,
        lat: 40,
        lon: -74,
      }),
    );

    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]?.[0]).toMatchObject({
      discarded: true,
      landings_count: 0,
      touch_and_go_count: 0,
    });
    expect(eventTypes).not.toContain('landing');
    expect(eventTypes).not.toContain('touchdown');
    expect(eventTypes).not.toContain('takeoff');
    const flight = buffer.loadFlights()[0];
    expect(flight?.stats.slew_seen).toBe(true);
    expect(flight?.stats.no_flight_evidence).toBe(true);
    await recorder.stop();
  });

  it('replay-кадры не создают рейс, точки, события и фазу', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const started = vi.fn();
    const eventTypes: string[] = [];
    recorder.on('flight_started', started);
    recorder.on('event', (event) => eventTypes.push(event.type));
    await recorder.start();

    // Повтор посадки: воздух и земля, работающий и выключенный двигатель.
    for (let i = 0; i < 10; i += 1) {
      adapter.pushSample(
        makeSample(isoAt(BASE_MS, i * 1000), {
          replay: true,
          on_ground: false,
          agl_ft: 1000,
          vs_fpm: -500,
          gs_kt: 140,
          engine_running: true,
        }),
      );
    }
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 11_000), {
        replay: true,
        on_ground: true,
        agl_ft: 0,
        vs_fpm: -180,
        gs_kt: 120,
        engine_running: true,
      }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 12_000), {
        replay: true,
        on_ground: true,
        gs_kt: 0,
        engine_running: false,
      }),
    );

    expect(started).not.toHaveBeenCalled();
    expect(recorder.state.recording).toBe(false);
    expect(recorder.state.client_flight_id).toBeNull();
    expect(eventTypes).toEqual([]);
    expect(buffer.loadFlights()).toHaveLength(0);

    // Реальный полёт после повтора стартует со своего кадра, а не с replay.
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 20_000), {
        on_ground: false,
        agl_ft: 500,
        vs_fpm: 800,
        gs_kt: 160,
        engine_running: true,
      }),
    );
    expect(started).toHaveBeenCalledTimes(1);
    expect(started.mock.calls[0]?.[0]).toMatchObject({ started_at: isoAt(BASE_MS, 20_000) });
    const points = buffer.loadPoints(recorder.state.client_flight_id ?? '');
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((point) => point.ts >= isoAt(BASE_MS, 20_000))).toBe(true);
    await recorder.stop();
  });

  it('replay в середине записи не закрывает и не продлевает рейс', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const ended = vi.fn();
    recorder.on('flight_ended', ended);
    await recorder.start();

    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 0), { on_ground: true, gs_kt: 0, engine_running: true }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 1_000), {
        on_ground: false,
        agl_ft: 1000,
        vs_fpm: 900,
        gs_kt: 180,
        engine_running: true,
      }),
    );
    const flightId = recorder.state.client_flight_id;
    expect(flightId).not.toBeNull();
    const pointsBefore = recorder.state.point_count;
    const eventsBefore = recorder.state.event_count;
    const phaseBefore = recorder.state.phase;

    // Повтор «далеко в будущем»: на земле, двигатель выключен. При обработке
    // такие кадры закрыли бы рейс (`engine_stop`/`parked`).
    for (let t = 5; t <= 15; t += 1) {
      adapter.pushSample(
        makeSample(isoAt(BASE_MS, t * 60_000), {
          replay: true,
          on_ground: true,
          gs_kt: 0,
          engine_running: false,
          agl_ft: 0,
        }),
      );
    }

    expect(ended).not.toHaveBeenCalled();
    expect(recorder.state.recording).toBe(true);
    expect(recorder.state.client_flight_id).toBe(flightId);
    expect(recorder.state.point_count).toBe(pointsBefore);
    expect(recorder.state.event_count).toBe(eventsBefore);
    expect(recorder.state.phase).toBe(phaseBefore);
    expect(buffer.loadFlights()).toHaveLength(1);
    expect(buffer.loadFlights()[0]?.status).toBe('in_progress');
    await recorder.stop();
  });

  it('арм-окно: bogus-airborne с большим AGL не стартует рейс и не пишет точки (DA62)', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const started = vi.fn();
    const touchdown = vi.fn();
    recorder.on('flight_started', started);
    recorder.on('event', (event) => {
      if (event.type === 'touchdown' || event.type === 'bounce') touchdown(event);
    });
    await recorder.start();

    // Первые кадры SimConnect: на полосе, но on_ground=false с большим AGL/alt,
    // gs=0, vs=0. Рейс не должен стартовать, точки — записываться.
    for (let i = 0; i < 5; i += 1) {
      adapter.pushSample(
        makeSample(isoAt(BASE_MS, i * 800), {
          on_ground: false,
          agl_ft: 204,
          alt_ft: 221,
          gs_kt: 0,
          vs_fpm: 0,
          engine_running: true,
        }),
      );
    }
    expect(started).not.toHaveBeenCalled();
    expect(recorder.state.recording).toBe(false);

    // Телеметрия устоялась: ВС на ВПП.
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 4_000), {
        on_ground: true,
        agl_ft: 3,
        alt_ft: 80,
        gs_kt: 0,
        vs_fpm: 0,
        engine_running: true,
      }),
    );
    expect(started).toHaveBeenCalledTimes(1);
    const flightId = recorder.state.client_flight_id ?? '';
    // Bogus-кадры отброшены: записана только стартовая settled-точка.
    expect(buffer.loadPoints(flightId)).toHaveLength(1);
    expect(touchdown).not.toHaveBeenCalled();
    await recorder.stop();
  });

  it('detect engine-off только когда выключены все двигатели', async () => {
    const { adapter, recorder } = createRecorder();
    const ended = vi.fn();
    recorder.on('flight_ended', ended);
    await recorder.start();

    adapter.pushSample(makeSample(isoAt(BASE_MS, 0), { gs_kt: 0, on_ground: true }));
    for (const t of [10, 20, 40]) {
      adapter.pushSample(
        makeSample(isoAt(BASE_MS, t * 1000), {
          gs_kt: 0,
          on_ground: true,
          engine_running: true,
          engines_running: 1,
        }),
      );
    }
    // Один из четырёх двигателей ещё работает — рейс не завершается.
    expect(ended).not.toHaveBeenCalled();

    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 70_000), {
        gs_kt: 0,
        on_ground: true,
        engine_running: false,
        engines_running: 0,
      }),
    );
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]?.[0]).toMatchObject({ reason: 'engine_stop' });
    await recorder.stop();
  });

  it('T-D §5.6: пишет сырую строку модели (ATC MODEL) в stats рейса', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    await recorder.start();
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 0), {
        on_ground: true,
        gs_kt: 0,
        atc_model: '  Some Custom Plane  ',
        atc_type: null,
        title: null,
      }),
    );
    const flightId = recorder.state.client_flight_id ?? '';
    expect(buffer.getFlight(flightId)?.stats.aircraft_model_raw).toBe('SOME CUSTOM PLANE');
    await recorder.stop();
    // `finalizeFlight` замещает stats целиком — строка должна пережить финализацию.
    expect(buffer.getFlight(flightId)?.stats.aircraft_model_raw).toBe('SOME CUSTOM PLANE');
  });

  it('T-D §5.6: берёт сырую строку из TITLE, если тип не распознан', async () => {
    const adapter = new MockSimConnectAdapter();
    const buffer = new MemoryOutboxBuffer();
    const recorder = new FlightRecorder({
      loadQuarantineS: 0,
      adapter,
      buffer,
      idGenerator: seededUuidGenerator(),
      autoWatchdog: false,
      endEngineOffS: 3,
      endStationaryS: 600,
    });
    await recorder.start();
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 0), {
        on_ground: true,
        gs_kt: 0,
        atc_model: null,
        atc_type: null,
        title: null,
      }),
    );
    // Строка модели появляется позже; тип всё ещё не распознан — это и есть пара.
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 1_000), {
        on_ground: true,
        gs_kt: 0,
        atc_model: null,
        atc_type: null,
        title: 'Some Custom Plane',
      }),
    );
    await recorder.stop();
    const flight = buffer.loadFlights()[0];
    expect(flight?.aircraft_icao).toBe('ZZZZ');
    expect(flight?.stats.aircraft_model_raw).toBe('SOME CUSTOM PLANE');
  });

  it('T-D §5.6: без строки модели поле не появляется в stats', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    await recorder.start();
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 0), {
        on_ground: true,
        gs_kt: 0,
        atc_model: null,
        atc_type: null,
        title: null,
      }),
    );
    await recorder.stop();
    expect(buffer.loadFlights()[0]?.stats).not.toHaveProperty('aircraft_model_raw');
  });
});

describe('FlightRecorder — edge-cases T12 (пауза / смена ВС / no-score / немонотонный ts)', () => {
  it('пауза вне окна касания: paused_total_s вычитается из duration_s, допуск сохранён', async () => {
    const samples: TelemetrySample[] = [];
    const at = (offsetS: number, overrides: Parameters<typeof makeSample>[1] = {}) => {
      samples.push(makeSample(isoAt(BASE_MS, offsetS * 1000), overrides));
    };

    at(0, { gs_kt: 0, on_ground: true, engine_running: true });
    at(2, { gs_kt: 15, on_ground: true });
    at(6, { gs_kt: 60, on_ground: true });
    at(8, { gs_kt: 120, on_ground: false, agl_ft: 500, vs_fpm: 800, alt_ft: 1100 });
    for (let t = 9; t <= 29; t += 1) {
      at(t, { gs_kt: 440, on_ground: false, agl_ft: 30_000, vs_fpm: 0, ias_kt: 250 });
    }
    // ПАУЗА сима ~10 с (t=30..39 — сэмплы отсутствуют).
    for (let t = 40; t <= 69; t += 1) {
      at(t, { gs_kt: 440, on_ground: false, agl_ft: 30_000, vs_fpm: 0, ias_kt: 250 });
    }
    // Плотное окно касания 10 Гц (t=70..99.9), касание t=100: гэп далеко вне окна ±30 с.
    dense(at, 70, 99.9, 10, {
      gs_kt: 140,
      on_ground: false,
      agl_ft: 200,
      vs_fpm: -450,
      ias_kt: 140,
      g: 1.05,
    });
    at(100, { gs_kt: 120, on_ground: true, agl_ft: 0, vs_fpm: -180, g: 1.35, ias_kt: 120 });
    at(101, { gs_kt: 0, on_ground: true, vs_fpm: 0, engine_running: false });
    at(102, { gs_kt: 0, on_ground: true, vs_fpm: 0, engine_running: false });
    at(103, { gs_kt: 0, on_ground: true, vs_fpm: 0, engine_running: false });
    at(104, { gs_kt: 0, on_ground: true, vs_fpm: 0, engine_running: false });

    const { adapter, buffer, recorder } = createRecorder();
    const ended = vi.fn();
    recorder.on('flight_ended', ended);
    await recorder.start();
    for (const sample of samples) adapter.pushSample(sample);

    expect(ended).toHaveBeenCalledTimes(1);
    const info = ended.mock.calls[0]?.[0];
    expect(info?.paused_total_s).toBeGreaterThanOrEqual(9);
    expect(info?.is_partial).toBe(false);
    expect(info?.leaderboard_eligible).toBe(true);

    const flight = buffer.loadFlights()[0];
    expect(flight?.stats.duration_s).toBe(
      (flight?.stats.elapsed_s as number) - (flight?.stats.paused_total_s as number),
    );
    await recorder.stop();
  });

  it('рейс без касания не получает балл (no_score): score_preview=null, вне лидерборда', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const ended = vi.fn();
    const scores = vi.fn();
    recorder.on('flight_ended', ended);
    recorder.on('score', scores);
    await recorder.start();

    adapter.pushSample(makeSample(isoAt(BASE_MS, 0), { gs_kt: 0, on_ground: true }));
    adapter.pushSample(makeSample(isoAt(BASE_MS, 2000), { gs_kt: 15, on_ground: true }));
    adapter.pushSample(makeSample(isoAt(BASE_MS, 6000), { gs_kt: 60, on_ground: true }));
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 8000), { gs_kt: 120, on_ground: false, agl_ft: 500, vs_fpm: 900 }),
    );
    // Остановка агента в воздухе — касания не было.
    await recorder.stop();

    expect(ended).toHaveBeenCalledTimes(1);
    expect(scores).not.toHaveBeenCalled();
    const info = ended.mock.calls[0]?.[0];
    expect(info).toMatchObject({
      reason: 'agent_stop',
      score_preview: null,
      metrics: null,
      leaderboard_eligible: false,
    });
    expect(buffer.loadFlights()[0]?.stats.score_preview).toBeNull();
  });

  it('смена ВС в полёте не переопределяет зафиксированный aircraft_icao', async () => {
    const adapter = new MockSimConnectAdapter();
    const buffer = new MemoryOutboxBuffer();
    const recorder = new FlightRecorder({
      loadQuarantineS: 0,
      adapter,
      buffer,
      idGenerator: seededUuidGenerator(),
      autoWatchdog: false,
      endEngineOffS: 3,
      endStationaryS: 600,
    });
    const started = vi.fn();
    recorder.on('flight_started', started);
    await recorder.start();

    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 0), {
        gs_kt: 0,
        on_ground: true,
        atc_type: 'A320',
        atc_model: 'Airbus A320',
      }),
    );
    expect(started.mock.calls[0]?.[0]).toMatchObject({
      aircraft_icao: 'A320',
      aircraft_icao_source: 'atc_type',
    });

    // «Смена ВС» в полёте: новый ATC TYPE/MODEL — но ICAO уже зафиксирован на старте.
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 1000), {
        gs_kt: 0,
        on_ground: true,
        atc_type: 'B738',
        atc_model: 'Boeing 737-800',
      }),
    );
    const flightId = recorder.state.client_flight_id ?? '';
    expect(buffer.getFlight(flightId)?.aircraft_icao).toBe('A320');

    await recorder.stop();
  });

  it('немонотонный ts (часы назад) не роняет рекордер и не завершает рейс', async () => {
    const { adapter, recorder } = createRecorder();
    await recorder.start();

    adapter.pushSample(makeSample(isoAt(BASE_MS, 0), { gs_kt: 20, on_ground: true }));
    adapter.pushSample(makeSample(isoAt(BASE_MS, 5000), { gs_kt: 30, on_ground: true }));
    // Часы «прыгнули назад» — не должен падать и не должен ложно завершать/считать паузу.
    adapter.pushSample(makeSample(isoAt(BASE_MS, 3000), { gs_kt: 35, on_ground: true }));
    adapter.pushSample(makeSample(isoAt(BASE_MS, 6000), { gs_kt: 40, on_ground: true }));

    expect(recorder.state.recording).toBe(true);
    await recorder.stop();
  });
});

describe('FlightRecorder — несколько посадок в сессии (ADR-0010)', () => {
  function createRecorderWith(options: Partial<FlightRecorderOptions> = {}) {
    const adapter = new MockSimConnectAdapter();
    const buffer = new MemoryOutboxBuffer();
    const recorder = new FlightRecorder({
      loadQuarantineS: 0,
      adapter,
      buffer,
      idGenerator: seededUuidGenerator(),
      endEngineOffS: 3,
      endStationaryS: 300,
      patternStationaryS: 600,
      aircraftIcao: 'B738',
      ...options,
    });
    return { adapter, buffer, recorder };
  }

  /** Сессия с 3 посадками: 2 touch-and-go и full-stop. */
  function multiLandingTimeline(): TelemetrySample[] {
    const samples: TelemetrySample[] = [];
    const at = (offsetS: number, overrides: Parameters<typeof makeSample>[1] = {}) => {
      samples.push(makeSample(isoAt(BASE_MS, offsetS * 1000), overrides));
    };
    const approach = {
      on_ground: false,
      agl_ft: 200,
      vs_fpm: -450,
      gs_kt: 140,
      ias_kt: 140,
      g: 1.05,
    };
    const cruise = { on_ground: false, agl_ft: 3000, vs_fpm: 0, gs_kt: 200, ias_kt: 160 };

    at(0, { on_ground: true, gs_kt: 0, engine_running: true });
    at(2, { on_ground: true, gs_kt: 30, engine_running: true });
    at(4, { on_ground: true, gs_kt: 80, engine_running: true });
    at(6, { on_ground: false, agl_ft: 50, vs_fpm: 800, gs_kt: 130 });
    for (let t = 8; t <= 14; t += 1) at(t, cruise);
    dense(at, 15, 19.9, 10, approach);
    at(20, { on_ground: true, agl_ft: 0, vs_fpm: -180, g: 1.3, gs_kt: 120 });
    at(21, { on_ground: true, gs_kt: 60, vs_fpm: 0 });
    at(22, { on_ground: true, gs_kt: 20, vs_fpm: 0 });
    at(23, { on_ground: false, agl_ft: 20, gs_kt: 90, vs_fpm: 300 });
    for (let t = 24; t <= 38; t += 1) at(t, cruise);
    dense(at, 40, 44.9, 10, approach);
    at(45, { on_ground: true, agl_ft: 0, vs_fpm: -190, g: 1.25, gs_kt: 120 });
    at(46, { on_ground: true, gs_kt: 60, vs_fpm: 0 });
    at(47, { on_ground: true, gs_kt: 20, vs_fpm: 0 });
    at(48, { on_ground: false, agl_ft: 20, gs_kt: 90, vs_fpm: 300 });
    for (let t = 49; t <= 68; t += 1) at(t, cruise);
    dense(at, 70, 74.9, 10, approach);
    at(75, { on_ground: true, agl_ft: 0, vs_fpm: -170, g: 1.2, gs_kt: 110 });
    at(76, { on_ground: true, gs_kt: 30, vs_fpm: 0 });
    at(77, { on_ground: true, gs_kt: 0, vs_fpm: 0 });
    at(78, { on_ground: true, gs_kt: 0, vs_fpm: 0, engine_running: false });
    at(81, { on_ground: true, gs_kt: 0, vs_fpm: 0, engine_running: false });
    return samples;
  }

  it('не завершает сессию касанием: 3 посадки (2 touch-and-go + full-stop)', async () => {
    const { adapter, buffer, recorder } = createRecorderWith();
    const ended = vi.fn();
    const landingSeqs: unknown[] = [];
    recorder.on('flight_ended', ended);
    recorder.on('event', (event) => {
      if (event.type === 'touchdown') landingSeqs.push(event.data.landing_seq);
    });
    await recorder.start();
    for (const sample of multiLandingTimeline()) adapter.pushSample(sample);

    expect(ended).toHaveBeenCalledTimes(1);
    const info = ended.mock.calls[0]?.[0] as FlightEndedInfo;
    expect(info).toMatchObject({
      reason: 'engine_stop',
      landings_count: 3,
      touch_and_go_count: 2,
    });
    expect(info.landings.map((landing) => landing.seq)).toEqual([1, 2, 3]);
    expect(info.landings.map((landing) => landing.touchAndGo)).toEqual([true, true, false]);
    expect(info.landings[2]?.groundContactS).toBeNull();
    expect(landingSeqs).toEqual([1, 2, 3]);

    const flight = buffer.loadFlights()[0];
    expect(flight?.stats.landings_count).toBe(3);
    expect(flight?.stats.touch_and_go_count).toBe(2);
    expect(info.landings.map((landing) => landing.touchdown_at)).toContain(
      flight?.stats.touchdown_at,
    );
    await recorder.stop();
  });

  it('высокочастотное окно ±30 c записывается вокруг каждой посадки', async () => {
    const { adapter, buffer, recorder } = createRecorderWith();
    await recorder.start();
    for (const sample of multiLandingTimeline()) adapter.pushSample(sample);

    const flightId = recorder.state.client_flight_id ?? '';
    const points = buffer.loadPoints(flightId);
    for (const touchdownS of [20, 45, 75]) {
      const from = isoAt(BASE_MS, (touchdownS - 30) * 1000);
      const to = isoAt(BASE_MS, touchdownS * 1000);
      const windowPoints = points.filter((point) => point.ts >= from && point.ts <= to);
      expect(windowPoints.length).toBeGreaterThanOrEqual(10);
    }
    await recorder.stop();
  });

  it('стоянка 300 c до первого касания закрывает сессию как parked', async () => {
    const { adapter, recorder } = createRecorderWith();
    const ended = vi.fn();
    recorder.on('flight_ended', ended);
    await recorder.start();
    adapter.pushSample(makeSample(isoAt(BASE_MS, 0), { on_ground: true, gs_kt: 0 }));
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 301_000), { on_ground: true, gs_kt: 0, engine_running: true }),
    );

    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]?.[0]).toMatchObject({ reason: 'parked', landings_count: 0 });
    await recorder.stop();
  });

  it('стоянка после касания: 300 c не режет сессию, 600 c — закрывает', async () => {
    const { adapter, recorder } = createRecorderWith();
    const ended = vi.fn();
    recorder.on('flight_ended', ended);
    await recorder.start();
    adapter.pushSample(makeSample(isoAt(BASE_MS, 0), { on_ground: true, gs_kt: 0 }));
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 1_000), { on_ground: false, agl_ft: 100, gs_kt: 120 }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 12_000), { on_ground: true, gs_kt: 50, vs_fpm: -150 }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 13_000), { on_ground: true, gs_kt: 0, engine_running: true }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 313_000), { on_ground: true, gs_kt: 0, engine_running: true }),
    );
    expect(ended).not.toHaveBeenCalled();

    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 613_000), { on_ground: true, gs_kt: 0, engine_running: true }),
    );
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]?.[0]).toMatchObject({ reason: 'parked', landings_count: 1 });
    await recorder.stop();
  });

  it('пишет gear_up/gear_down и touchdown/touch-and-go на каждую посадку', async () => {
    const { adapter, buffer, recorder } = createRecorderWith();
    const types: string[] = [];
    recorder.on('event', (event) => types.push(event.type));
    await recorder.start();
    adapter.pushSample(makeSample(isoAt(BASE_MS, 0), { on_ground: true, gs_kt: 0 }));
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 1_000), {
        on_ground: false,
        agl_ft: 100,
        gs_kt: 120,
        gear_down: false,
      }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 11_000), {
        on_ground: false,
        agl_ft: 20,
        vs_fpm: -300,
        gear_down: false,
      }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 12_000), {
        on_ground: true,
        gs_kt: 60,
        vs_fpm: -150,
        g: 1.2,
        gear_down: true,
      }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 15_000), { on_ground: true, gs_kt: 0, engine_running: false }),
    );
    adapter.pushSample(
      makeSample(isoAt(BASE_MS, 18_000), { on_ground: true, gs_kt: 0, engine_running: false }),
    );

    expect(types).toContain('gear_up');
    expect(types).toContain('gear_down');
    expect(types).toContain('touchdown');
    expect(types).toContain('landing');
    const flightId = recorder.state.client_flight_id ?? '';
    expect(buffer.loadPoints(flightId).some((point) => point.ts === isoAt(BASE_MS, 12_000))).toBe(
      true,
    );
    await recorder.stop();
  });

  it('одиночная посадка ведёт себя как раньше', async () => {
    const { adapter, buffer, recorder } = createRecorder();
    const ended = vi.fn();
    recorder.on('flight_ended', ended);
    await recorder.start();
    for (const sample of buildTimeline()) adapter.pushSample(sample);

    expect(ended).toHaveBeenCalledTimes(1);
    const info = ended.mock.calls[0]?.[0];
    expect(info).toMatchObject({ landings_count: 1, touch_and_go_count: 0 });
    expect(info.landings).toHaveLength(1);
    expect(info.landings[0]).toMatchObject({ seq: 1, touchAndGo: false, groundContactS: null });
    expect(info.score_preview).not.toBeNull();
    expect(buffer.loadFlights()[0]?.stats.landings_count).toBe(1);
    await recorder.stop();
  });
});

describe('FlightRecorder — listener hygiene (CD-3.2, Gap 3.2)', () => {
  it('повторный connect не создаёт дублей listeners', async () => {
    const adapter = new CountingAdapter();
    const buffer = new MemoryOutboxBuffer();
    const recorder = new FlightRecorder({
      loadQuarantineS: 0,
      adapter,
      buffer,
      idGenerator: seededUuidGenerator(),
      autoWatchdog: false,
    });

    await recorder.start();
    await recorder.start();

    expect(adapter.listenerCount('sample')).toBe(1);
    expect(adapter.listenerCount('disconnect')).toBe(1);
    expect(adapter.listenerCount('error')).toBe(1);

    adapter.push(makeSample(isoAt(BASE_MS, 0), { gs_kt: 0, on_ground: true, engine_running: true }));
    expect(recorder.state.point_count).toBe(1);

    await recorder.stop();
  });
});
