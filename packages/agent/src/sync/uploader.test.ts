import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FlightEvent, TrackPoint } from '@flightlog/contracts';
import { flightAggregatesSchema } from '@flightlog/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryOutboxBuffer } from '../buffer/memory-buffer.js';
import { SqliteOutboxBuffer } from '../buffer/sqlite-buffer.js';
import type { OutboxBuffer } from '../buffer/types.js';
import { toFlightEvent, toTrackPoint } from '../flight/build.js';
import { FlightRecorder } from '../flight/recorder.js';
import { MockSimConnectAdapter } from '../sim/mock-adapter.js';
import { BASE_MS, isoAt, makeSample } from '../testing/telemetry-fixture.js';
import { FakeApiServer } from '../testing/fake-api-server.js';
import { seededUuidGenerator } from '../util/id.js';
import { MemoryTokenStore, type StoredTokens } from './token-store.js';
import {
  FlightUploader,
  MachineMismatchError,
  NotAuthorizedError,
  pickClientAggregates,
  type FlightUploaderOptions,
} from './uploader.js';

const DEVICE_ID = '99999999-9999-4999-8999-999999999999';
const TOKENS: StoredTokens = {
  access_token: 'access-1',
  device_token: 'device-1',
  device_id: DEVICE_ID,
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function seedFlight(
  buffer: OutboxBuffer,
  options: { points?: number; events?: number; stats?: Record<string, unknown> } = {},
): { flightId: string; points: TrackPoint[]; events: FlightEvent[] } {
  const ids = seededUuidGenerator();
  const flightId = ids();
  const extraStats = options.stats ?? {};
  buffer.upsertFlight({
    client_flight_id: flightId,
    aircraft_icao: 'B738',
    callsign: null,
    origin_icao: null,
    destination_icao: null,
    device_id: null,
    started_at: isoAt(BASE_MS, 0),
    ended_at: null,
    status: 'in_progress',
    stats: { ...extraStats },
    created_at: isoAt(BASE_MS, 0),
    updated_at: isoAt(BASE_MS, 0),
    synced_at: null,
  });

  const points: TrackPoint[] = [];
  for (let i = 0; i < (options.points ?? 3); i += 1) {
    points.push(
      toTrackPoint(makeSample(isoAt(BASE_MS, i * 1000)), i + 1, { clientPointId: ids() }),
    );
  }
  buffer.appendPoints(flightId, points);

  const events: FlightEvent[] = [
    toFlightEvent('touchdown', makeSample(isoAt(BASE_MS, 1000)), { vs_fpm: -150 }, ids()),
  ];
  buffer.appendEvents(flightId, events);
  buffer.finalizeFlight(
    flightId,
    isoAt(BASE_MS, 60_000),
    'completed',
    { is_partial: false, paused_total_s: 0, quality_flags: 0, ...extraStats },
    isoAt(BASE_MS, 60_000),
  );
  return { flightId, points, events };
}

function makeUploader(
  server: FakeApiServer,
  buffer: OutboxBuffer,
  overrides: Partial<FlightUploaderOptions> = {},
): { uploader: FlightUploader; store: MemoryTokenStore; refresh: ReturnType<typeof vi.fn> } {
  const store = new MemoryTokenStore(TOKENS);
  const refresh = vi.fn(async () => ({ ...TOKENS, access_token: 'access-2' }));
  const uploader = new FlightUploader({
    apiBaseUrl: 'https://api.test',
    http: server.asHttpClient(),
    buffer,
    tokenStore: store,
    auth: { refresh },
    now: () => BASE_MS,
    ...overrides,
    retry: { random: () => 1, ...(overrides.retry ?? {}) },
  });
  return { uploader, store, refresh };
}

function validLandingAnalysis(): Record<string, unknown> {
  return {
    version: 'analysis/1',
    config_at_1000ft: null,
    config_at_500ft: null,
    ap_disconnect_agl_ft: 800,
    at_disconnect_agl_ft: 800,
    flare_height_ft: 50,
    flare_duration_s: 1,
    ils: null,
    aoa_touchdown_deg: 5,
    aoa_max_near_touchdown_deg: 5.2,
    cg_percent_touchdown: 31,
    surface_condition: 1,
    surface_type: 2,
    on_any_runway: true,
    touchdown_point: null,
    radio_height_touchdown_ft: 0,
    wind_shear: null,
    series: { ils_cdi: [], ils_gsi: [], aoa_deg: [], flaps_percent: [] },
  };
}

describe('FlightUploader (T10)', () => {
  it('загружает рейс, точки, события и завершает его', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 4, events: 1 });
    const delays: number[] = [];
    const { uploader } = makeUploader(server, buffer, {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const summary = await uploader.flush();

    expect(summary).toMatchObject({
      flights_processed: 1,
      flights_completed: 1,
      points_uploaded: 4,
      events_uploaded: 1,
      pending_points: 0,
      pending_events: 0,
      pending_flights: 0,
    });
    expect(server.points.size).toBe(4);
    expect(server.events.size).toBe(1);
    expect(server.completed.size).toBe(1);
    expect(delays).toEqual([]);
  });

  it('T4: хвост точек/событий completed+synced рейса дозаливается следующим flush (идемпотентно)', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    const { flightId } = seedFlight(buffer, { points: 3, events: 1 });
    const { uploader } = makeUploader(server, buffer);

    await uploader.flush();
    expect(buffer.pendingCounts()).toMatchObject({ pendingPoints: 0, pendingEvents: 0 });
    expect(server.points.size).toBe(3);

    const trailingIds = seededUuidGenerator(1_000);
    buffer.appendPoints(flightId, [
      toTrackPoint(makeSample(isoAt(BASE_MS, 90_000)), 4, {
        clientPointId: trailingIds(),
      }),
    ]);
    buffer.appendEvents(flightId, [
      toFlightEvent(
        'touchdown',
        makeSample(isoAt(BASE_MS, 90_000)),
        { vs_fpm: -120 },
        trailingIds(),
      ),
    ]);
    expect(buffer.pendingCounts()).toMatchObject({ pendingPoints: 1, pendingEvents: 1 });

    const summary = await uploader.flush();

    expect(summary).toMatchObject({ points_uploaded: 1, events_uploaded: 1 });
    expect(summary.pending_points).toBe(0);
    expect(summary.pending_events).toBe(0);
    expect(server.points.size).toBe(4);
    expect(server.events.size).toBe(2);

    const again = await uploader.flush();
    expect(again.points_uploaded).toBe(0);
    expect(again.events_uploaded).toBe(0);
    expect(server.points.size).toBe(4);
    expect(server.events.size).toBe(2);
  });

  it('score-preview: resolveServerFlightId + final landings из /complete (score-preview.md §4)', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    const { flightId } = seedFlight(buffer, { points: 2, events: 1 });
    server.hook = (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path.endsWith('/complete')) {
        return {
          status: 200,
          headers: {},
          body: {
            data: {
              status: 'completed',
              landings: [
                {
                  seq: 1,
                  score: 88,
                  grade: 'good',
                  touchdown_at: isoAt(BASE_MS, 1000),
                  touch_and_go: false,
                  metrics: { vs_fpm: -120, g_force: 1.2, bounce_count: 0 },
                },
              ],
            },
          },
        };
      }
      return null;
    };
    const { uploader } = makeUploader(server, buffer);
    expect(uploader.resolveServerFlightId(flightId)).toBeNull();

    await uploader.flush();

    expect(uploader.resolveServerFlightId(flightId)).toBe(server.flights.get(flightId)?.id);
    const landings = uploader.resolveFinalLandings(flightId);
    expect(landings).toHaveLength(1);
    expect(landings?.[0]).toMatchObject({ seq: 1, score: 88, grade: 'good', vs_fpm: -120 });
  });

  it('score-preview: /complete без landings (старый сервер) → final landings недоступны', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    const { flightId } = seedFlight(buffer, { points: 1, events: 1 });
    server.hook = (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path.endsWith('/complete')) {
        return { status: 200, headers: {}, body: { data: { status: 'completed' } } };
      }
      return null;
    };
    const { uploader } = makeUploader(server, buffer);

    await uploader.flush();

    expect(uploader.resolveFinalLandings(flightId)).toBeNull();
  });

  it('WAVE 4: /complete несёт finalized FOQA-агрегаты (whitelist + landings_analysis)', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, {
      points: 2,
      events: 1,
      stats: {
        landing_weight_kg: 62000,
        landing_weight_source: 'sim',
        landings_analysis: { '1': validLandingAnalysis() },
        // Не whitelisted — не должно уйти на сервер.
        aircraft_model_raw: 'SHOULD-NOT-BE-SENT',
      },
    });

    await makeUploader(server, buffer).uploader.flush();

    const complete = server.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/complete'),
    );
    expect(complete).toBeDefined();
    const stats = (complete?.body as { stats?: Record<string, unknown> } | undefined)?.stats;
    expect(stats?.landing_weight_kg).toBe(62000);
    expect(stats?.landing_weight_source).toBe('sim');
    expect(stats?.landings_analysis).toBeDefined();
    expect(stats).not.toHaveProperty('aircraft_model_raw');
  });

  it('R1: /complete несёт sim_runway top-level (не в stats)', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    const simRunway = {
      ident: '03R',
      threshold: { lat: 40.10036, lon: 32.98973, elev_ft: 3125 },
      end: { lat: 40.12762, lon: 33.01571, elev_ft: 3125 },
      width_m: 45,
      length_m: 3755.3,
      heading_deg: 36.1,
      surface_code: 37,
    };
    seedFlight(buffer, { points: 1, events: 1, stats: { sim_runway: simRunway } });

    await makeUploader(server, buffer, { sim: 'xplane12' }).uploader.flush();

    const complete = server.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/complete'),
    );
    const body = complete?.body as Record<string, unknown> | undefined;
    expect(body?.sim_runway).toEqual(simRunway);
    expect((body?.stats as Record<string, unknown> | undefined)?.sim_runway).toBeUndefined();
  });

  it('WAVE 4: без FOQA-агрегатов /complete шлётся как раньше (без stats)', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 1, events: 1 });

    await makeUploader(server, buffer).uploader.flush();

    const complete = server.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/complete'),
    );
    const body = complete?.body as Record<string, unknown> | undefined;
    expect(body).toBeDefined();
    expect(body).not.toHaveProperty('stats');
  });

  it('WAVE 4 conformance: pickClientAggregates не теряет ни одного ключа flightAggregatesSchema', () => {
    // Регрессия на «дрейф имён»: контракт — единственный источник истины, а
    // whitelist агента обязан покрывать все его скалярные ключи.
    const stats: Record<string, unknown> = {
      landing_weight_kg: 62000,
      landing_weight_source: 'sim',
      atc_runway_missing: true,
      phases: {
        takeoff: { vs_mean_fpm: 1800, pitch_mean_deg: 9.5 },
        climb: { avg_ias_kt: 250, avg_vs_fpm: 2100 },
        cruise: { altitude_ft: 35000, avg_gs_kt: 470 },
        descent: { avg_vs_fpm: -1800, max_ias_kt: 280 },
        approach: {
          avg_gs_kt: 138,
          gs_at_1000ft_kt: 138,
          gs_at_500ft_kt: 134,
          sink_rate_1000_500_fpm: -720,
        },
      },
      stability: {
        stabilized_by_1000ft: true,
        stabilized_by_500ft: true,
        gs_variation_kt_1000_500: 4,
        vertical_speed_variation_fpm: 60,
        bank_excursions_count: 0,
      },
      events: [{ type: 'gear_down', at_sec_from_touchdown: -35 }],
      config_at_1000ft: {
        flaps_percent: 30,
        spoilers_percent: 0,
        spoilers_armed: true,
        gear_down: true,
        autopilot_master: true,
        autothrottle_active: true,
      },
      config_at_500ft: {
        flaps_percent: 40,
        spoilers_percent: 0,
        spoilers_armed: true,
        gear_down: true,
        autopilot_master: true,
        autothrottle_active: false,
      },
      ap_disconnect_agl_ft: 812.5,
      at_disconnect_agl_ft: 824,
      flare_height_ft: 42.5,
      flare_duration_s: 3.1,
      ils: {
        samples: 128,
        max_abs_cdi: 0.42,
        max_abs_gsi: 0.55,
        min_glide_slope_error_deg: -0.6,
        max_glide_slope_error_deg: 0.4,
        cdi_valid: true,
        gsi_valid: true,
        has_localizer: true,
      },
      aoa_touchdown_deg: 4.2,
      aoa_max_near_touchdown_deg: 5.1,
      cg_percent_touchdown: 31.4,
      surface_condition: 1,
      surface_type: 2,
      touchdown_point: {
        relative_x_m: 5,
        relative_z_m: -150,
        aiming_x_m: 0,
        aiming_z_m: 300,
        start_distance_m: 150,
        end_distance_m: 2850,
        heading_deg_true: 245,
        length_m: 3000,
        width_m: 45,
      },
      radio_height_touchdown_ft: 0,
      engine_touchdown: {
        mode: 'idle',
        samples: 5,
        n1_mean_percent: 30,
        n1_max_percent: 32,
        throttle_mean_percent: 8,
        throttle_max_percent: 8,
        reverse_engaged: false,
        reverse_duration_s: null,
        fuel_flow_pph_mean: 1400,
        fuel_flow_pph_max: 1500,
        duration_s: null,
      },
      engine_rollout: {
        mode: 'reverse',
        samples: 12,
        n1_mean_percent: 42.5,
        n1_max_percent: 61.2,
        throttle_mean_percent: 8,
        throttle_max_percent: 18,
        reverse_engaged: true,
        reverse_duration_s: 7.4,
        fuel_flow_pph_mean: 2100,
        fuel_flow_pph_max: 2600,
        duration_s: 22.1,
      },
      // FOQA-DATUM-1: датум-калибровка и высоты колёс (аддитивные ключи).
      agl_datum_offset_ft: 10,
      agl_datum_version: 'agl-datum/1',
      height_datum_calibrated: true,
      flare_height_wheel_ft: 32.5,
      wheel_height_touchdown_ft: 2.2,
      wind_shear: { samples: 20, max_wind_speed_delta_kt: 4.5, max_wind_dir_delta_deg: 18 },
      landings_analysis: { '1': validLandingAnalysis() },
      // Не whitelisted — не должно попасть в выборку.
      aircraft_model_raw: 'SHOULD-NOT-BE-SENT',
    };

    expect(flightAggregatesSchema.safeParse(stats).success).toBe(true);
    const picked = pickClientAggregates(stats);
    expect(picked).toBeDefined();
    for (const key of Object.keys(flightAggregatesSchema.shape)) {
      expect(picked).toHaveProperty(key);
    }
    expect(picked).not.toHaveProperty('aircraft_model_raw');
  });

  it('повторный upload backfill-батча не создаёт дублей (по client_point_id)', async () => {
    const server = new FakeApiServer();

    const first = new MemoryOutboxBuffer();
    seedFlight(first, { points: 5, events: 1 });
    await makeUploader(server, first).uploader.flush();

    // «Краш» после отправки, но до пометки синка: буфер восстановлен заново.
    const restored = new MemoryOutboxBuffer();
    seedFlight(restored, { points: 5, events: 1 });
    await makeUploader(server, restored).uploader.flush();

    expect(server.flights.size).toBe(1);
    expect(server.points.size).toBe(5);
    expect(server.events.size).toBe(1);
    expect(server.duplicatePoints).toBe(5);
    expect(server.duplicateEvents).toBe(1);
  });

  it('не переотправляет уже синхронизированные точки', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 3, events: 1 });
    const { uploader } = makeUploader(server, buffer);

    await uploader.flush();
    const callsAfterFirst = server.calls.length;
    await uploader.flush();

    expect(server.calls.length).toBe(callsAfterFirst);
    expect(server.points.size).toBe(3);
  });

  it('сетевой сбой ретраится с экспоненциальным backoff без потерь', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 3, events: 1 });

    let failures = 2;
    server.hook = (request) => {
      if (request.method === 'POST' && request.url.includes('/track/batch') && failures > 0) {
        failures -= 1;
        throw new Error('ECONNRESET');
      }
      return null;
    };

    const delays: number[] = [];
    const { uploader } = makeUploader(server, buffer, {
      retry: { maxAttempts: 5, baseDelayMs: 1000 },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const summary = await uploader.flush();

    expect(delays).toEqual([1000, 2000]);
    expect(summary.pending_points).toBe(0);
    expect(server.points.size).toBe(3);
  });

  it('429 учитывает Retry-After', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 2, events: 0 });

    let first = true;
    server.hook = (request) => {
      if (request.method === 'POST' && request.url.includes('/track/batch') && first) {
        first = false;
        return { status: 429, headers: { 'retry-after': '7' }, body: { code: 'RATE_LIMITED' } };
      }
      return null;
    };

    const delays: number[] = [];
    const { uploader } = makeUploader(server, buffer, {
      retry: { maxAttempts: 3 },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await uploader.flush();
    expect(delays).toEqual([7000]);
  });

  it('истёкший access-токен обновляется через device refresh и запрос повторяется', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 2, events: 1 });

    let expired = false;
    server.hook = (request) => {
      if (request.method === 'POST' && request.url === 'https://api.test/v1/flights' && !expired) {
        expired = true;
        return { status: 401, headers: {}, body: { code: 'UNAUTHORIZED' } };
      }
      return null;
    };

    const { uploader, refresh } = makeUploader(server, buffer);
    const summary = await uploader.flush();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(summary.pending_points).toBe(0);
    expect(server.completed.size).toBe(1);
  });

  it('413 уменьшает размер батча вдвое и повторяет', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 4, events: 0 });

    let triggered = false;
    server.hook = (request) => {
      if (request.method === 'POST' && request.url.includes('/track/batch') && !triggered) {
        triggered = true;
        return { status: 413, headers: {}, body: { code: 'PAYLOAD_TOO_LARGE' } };
      }
      return null;
    };

    const { uploader } = makeUploader(server, buffer, { batchSize: 4 });
    await uploader.flush();

    const trackCalls = server.calls.filter((call) => call.url.includes('/track/batch'));
    const sizes = trackCalls.map((call) => (call.body as { points: unknown[] }).points.length);
    expect(sizes[0]).toBe(4);
    expect(sizes[1]).toBe(2);
    expect(sizes.slice(1).reduce((sum, size) => sum + size, 0)).toBe(4);
    expect(server.points.size).toBe(4);
  });

  it('без сохранённого device-токена требует авторизацию', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 1, events: 0 });
    const { uploader } = makeUploader(server, buffer, { tokenStore: new MemoryTokenStore(null) });

    await expect(uploader.flush()).rejects.toBeInstanceOf(NotAuthorizedError);
    expect(server.calls).toHaveLength(0);
  });

  it('буфер переживает рестарт SQLite: flush после reopen доставляет всё', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flightlog-upload-'));
    dirs.push(dir);
    const path = join(dir, 'outbox.sqlite');

    const first = new SqliteOutboxBuffer(path);
    const { flightId } = seedFlight(first, { points: 3, events: 1 });
    first.close();

    const restored = new SqliteOutboxBuffer(path);
    try {
      const server = new FakeApiServer();
      await makeUploader(server, restored).uploader.flush();
      const pending = restored.pendingCounts();

      expect(server.points.size).toBe(3);
      expect(server.completed.size).toBe(1);
      expect(pending.pendingPoints).toBe(0);
      expect(pending.pendingFlights).toBe(0);
      expect(flightId).toBeDefined();
    } finally {
      restored.close();
    }
  });

  it('CD-6.1/CD-6.2: каждый agent-запрос несёт source/client_version и X-TD-Machine-Id', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 2, events: 1 });
    const { uploader } = makeUploader(server, buffer, {
      source: 'electron',
      version: '0.2.0',
      machineId: 'machine-abcdefghijkl',
    });

    await uploader.flush();

    const posts = server.calls.filter((call) => call.method === 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(4);
    for (const call of posts) {
      expect(call.headers?.['x-td-machine-id']).toBe('machine-abcdefghijkl');
      const body = call.body as Record<string, unknown>;
      expect(body.source).toBe('electron');
      expect(body.client_version).toBe('0.2.0');
    }
  });

  it('ADR-0023: resolved sim уходит в provenance рейса (X-Plane не подписывается msfs2024)', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 2, events: 0 });
    const { uploader } = makeUploader(server, buffer, { sim: 'xplane12' });

    await uploader.flush();

    const post = (suffix: string) =>
      server.calls.find((call) => call.method === 'POST' && call.url.endsWith(suffix));
    expect((post('/v1/flights')?.body as Record<string, unknown>).sim).toBe('xplane12');
    expect((post('/complete')?.body as Record<string, unknown>).sim).toBe('xplane12');
  });

  it('ADR-0023: без resolved sim поле `sim` не отправляется (серверный дефолт msfs2024)', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 1, events: 0 });
    const { uploader } = makeUploader(server, buffer);

    await uploader.flush();

    const create = server.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/v1/flights'),
    );
    expect(create).toBeDefined();
    expect((create?.body as Record<string, unknown>).sim).toBeUndefined();
  });

  it('CD-6.2: 403 MACHINE_MISMATCH → MachineMismatchError без refresh', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 1, events: 0 });
    server.hook = (request) =>
      request.url.endsWith('/v1/flights')
        ? { status: 403, headers: {}, body: { code: 'MACHINE_MISMATCH' } }
        : null;

    const { uploader, refresh } = makeUploader(server, buffer);
    await expect(uploader.flush()).rejects.toBeInstanceOf(MachineMismatchError);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('CD-3.6: грязный батч (NaN/null/дробный vs_fpm) санитизируется и не залипает', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    const ids = seededUuidGenerator();
    const { flightId } = seedFlight(buffer, { points: 0, events: 0 });
    const dirty = {
      client_point_id: ids(),
      seq: 1,
      ts: isoAt(BASE_MS, 0),
      lat: 55.9,
      lon: 37.4,
      alt_ft: Number.NaN,
      agl_ft: null,
      gs_kt: 140.7,
      ias_kt: null,
      vs_fpm: -150.7,
      heading_deg: 370,
      pitch_deg: 3.2,
      bank_deg: 0,
      g: 1.25,
      on_ground: false,
      quality: 0,
    } as unknown as TrackPoint;
    buffer.appendPoints(flightId, [dirty]);

    const { uploader } = makeUploader(server, buffer);
    const summary = await uploader.flush();

    expect(summary.pending_points).toBe(0);
    const stored = [...server.points.values()][0] as Record<string, number>;
    expect(stored.vs_fpm).toBe(-151);
    expect(stored.heading_deg).toBe(10);
    expect(Number.isFinite(stored.alt_ft)).toBe(true);
  });

  it('CD-3.6: полностью непригодный батч сбрасывается, flush не залипает', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    const { flightId } = seedFlight(buffer, { points: 0, events: 0 });
    buffer.appendPoints(flightId, [
      {
        client_point_id: 'not-a-uuid',
        seq: 1,
        ts: isoAt(BASE_MS, 0),
        lat: 'x',
        lon: 'y',
      } as unknown as TrackPoint,
    ]);

    const { uploader } = makeUploader(server, buffer);
    const summary = await uploader.flush();

    expect(summary.pending_points).toBe(0);
    expect(server.points.size).toBe(0);
  });

  it('CD-3.3: сессия без отрыва уходит в /abandon, а не в /complete', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    const { flightId } = seedFlight(buffer, { points: 0, events: 0 });
    buffer.finalizeFlight(
      flightId,
      isoAt(BASE_MS, 60_000),
      'completed',
      { no_flight_evidence: true },
      isoAt(BASE_MS, 60_000),
    );

    const { uploader } = makeUploader(server, buffer);
    const summary = await uploader.flush();

    expect(summary.flights_abandoned).toBe(1);
    expect(summary.flights_completed).toBe(0);
    expect(server.completed.size).toBe(0);
    expect(server.abandoned.size).toBe(1);
    const [flight] = [...server.flights.values()];
    expect(flight).toBeDefined();
    expect(flight && server.abandoned.has(flight.id)).toBe(true);
    expect(buffer.pendingCounts().pendingFlights).toBe(0);
    expect(server.points.size).toBe(0);
  });

  it('CD-3: 404 NOT_FOUND на track/batch пересоздаёт рейс и доставляет буфер', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 3, events: 1 });

    let dropped = false;
    server.hook = (request) => {
      if (request.method === 'POST' && request.url.includes('/track/batch') && !dropped) {
        dropped = true;
        // Серверную запись удалили (или перепривязали к другому устройству).
        server.flights.clear();
        return { status: 404, headers: {}, body: { code: 'NOT_FOUND', detail: 'flight not found' } };
      }
      return null;
    };

    const { uploader } = makeUploader(server, buffer);
    const summary = await uploader.flush();

    expect(summary).toMatchObject({
      pending_points: 0,
      pending_events: 0,
      pending_flights: 0,
      flights_completed: 1,
    });
    expect(server.points.size).toBe(3);
    expect(server.events.size).toBe(1);
    expect(server.completed.size).toBe(1);
    // Recovery = повторный upsert тем же client_flight_id.
    const flightPosts = server.calls.filter(
      (call) => call.method === 'POST' && call.url.endsWith('/v1/flights'),
    );
    expect(flightPosts).toHaveLength(2);
  });

  it('CD-3: 404 NOT_FOUND на events/batch пересоздаёт рейс и доставляет события', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 0, events: 1 });

    let dropped = false;
    server.hook = (request) => {
      if (request.method === 'POST' && request.url.includes('/events/batch') && !dropped) {
        dropped = true;
        server.flights.clear();
        return { status: 404, headers: {}, body: { code: 'NOT_FOUND' } };
      }
      return null;
    };

    const { uploader } = makeUploader(server, buffer);
    const summary = await uploader.flush();

    expect(summary.pending_events).toBe(0);
    expect(summary.pending_flights).toBe(0);
    expect(server.events.size).toBe(1);
    expect(server.completed.size).toBe(1);
  });

  it('CD-3: 404 NOT_FOUND на /complete пересоздаёт рейс и завершает его', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 0, events: 0 });

    let dropped = false;
    server.hook = (request) => {
      if (request.method === 'POST' && request.url.endsWith('/complete') && !dropped) {
        dropped = true;
        server.flights.clear();
        return { status: 404, headers: {}, body: { code: 'NOT_FOUND' } };
      }
      return null;
    };

    const { uploader } = makeUploader(server, buffer);
    const summary = await uploader.flush();

    expect(summary.flights_completed).toBe(1);
    expect(server.completed.size).toBe(1);
    expect(buffer.pendingCounts().pendingFlights).toBe(0);
  });

  it('CD-3: 404 без recovery-условия (5xx) не пересоздаёт рейс и не глотается', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { points: 1, events: 0 });

    server.hook = (request) =>
      request.method === 'POST' && request.url.includes('/track/batch')
        ? { status: 500, headers: {}, body: { code: 'INTERNAL' } }
        : null;

    const { uploader } = makeUploader(server, buffer, {
      retry: { maxAttempts: 1 },
    });

    await expect(uploader.flush()).rejects.toThrowError();
    // Буфер сохранён, рейс не пересоздавался.
    expect(buffer.pendingCounts().pendingPoints).toBe(1);
    const flightPosts = server.calls.filter(
      (call) => call.method === 'POST' && call.url.endsWith('/v1/flights'),
    );
    expect(flightPosts).toHaveLength(1);
  });

  it('T-D §5.6: recorder → uploader: create несёт aircraft_model_raw из ATC MODEL', async () => {
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
        atc_model: '  Some Custom Plane  ',
        atc_type: null,
        title: null,
      }),
    );
    await recorder.stop();

    const server = new FakeApiServer();
    await makeUploader(server, buffer).uploader.flush();

    const create = server.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/v1/flights'),
    );
    expect(create).toBeDefined();
    expect((create?.body as Record<string, unknown>).aircraft_model_raw).toBe('SOME CUSTOM PLANE');
  });

  it('T-D §5.6: aircraft_model_raw нормализуется, прочие stats в тело не утекают', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, {
      stats: {
        aircraft_model_raw: '  pmdg 777-200lr  ',
        pilot_name: 'Ivan Ivanov',
        user_email: 'ivan@example.com',
      },
    });

    await makeUploader(server, buffer).uploader.flush();

    const create = server.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/v1/flights'),
    );
    const body = create?.body as Record<string, unknown>;
    expect(body.aircraft_model_raw).toBe('PMDG 777-200LR');
    // PII/прочие stats не пересылаются: в тело уходит только whitelisted поле.
    expect(body).not.toHaveProperty('pilot_name');
    expect(body).not.toHaveProperty('user_email');
  });

  it('T-D §5.6: без сырой строки поле не отправляется', async () => {
    const server = new FakeApiServer();
    const buffer = new MemoryOutboxBuffer();
    seedFlight(buffer, { stats: {} });

    await makeUploader(server, buffer).uploader.flush();

    const create = server.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/v1/flights'),
    );
    const body = create?.body as Record<string, unknown>;
    expect('aircraft_model_raw' in body).toBe(false);
  });
});
