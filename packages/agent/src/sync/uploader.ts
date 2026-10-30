import {
  AIRCRAFT_MODEL_SOURCE_MAX,
  flightAggregatesSchema,
  flightCompleteSchema,
  flightCreateSchema,
  flightEventsBatchSchema,
  normalizeAircraftModelText,
  scoreGradeSchema,
  simRunwaySchema,
  trackBatchIngestSchema,
  type FlightAggregatesInput,
  type FlightEvent,
  type FlightCreateInput,
  type ScoreGrade,
  type SimRunway,
  type TrackPoint,
} from '@flightlog/contracts';

import type {
  OutboxBuffer,
  OutboxEventRecord,
  OutboxFlight,
  OutboxPointRecord,
} from '../buffer/types.js';
import {
  findNearestAirportIcao,
  resolveSimRunway,
  type SimTouchdownPoint,
} from '../sim/xplane/apt-dat.js';
import type { SimSourceId } from '../sim/source.js';
import { DEFAULT_AGENT_SOURCE, packageVersion } from '../util/provenance.js';
import type { DeviceAuthClient } from './device-auth.js';
import {
  backoffDelayMs,
  isOkStatus,
  isRetryableStatus,
  parseRetryAfterMs,
  type BackoffOptions,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from './http.js';
import type { StoredTokens, TokenStore } from './token-store.js';

export class SyncError extends Error {
  constructor(
    message: string,
    readonly options: { status?: number; retryable?: boolean; code?: string } = {},
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

export class NotAuthorizedError extends SyncError {
  constructor(message = 'device is not authorized') {
    super(message, { retryable: false, status: 401 });
    this.name = 'NotAuthorizedError';
  }
}

/**
 * CD-6.2: сервер отверг `X-TD-Machine-Id`/`machine_id` (`403 MACHINE_MISMATCH`,
 * ADR-0018 §5). Рантайм по этому классу уходит в `NeedsRepair`: останавливает
 * загрузку, сохраняет буфер и **не** перевыпускает `device/code`.
 */
export class MachineMismatchError extends SyncError {
  constructor(message = 'device machine mismatch (needs repair)') {
    super(message, { retryable: false, status: 403, code: 'MACHINE_MISMATCH' });
    this.name = 'MachineMismatchError';
  }
}

export interface FlushSummary {
  flights_processed: number;
  flights_completed: number;
  /** CD-3.3: `no_flight_evidence`-сессии, отозванные через `/abandon`. */
  flights_abandoned: number;
  points_uploaded: number;
  events_uploaded: number;
  pending_flights: number;
  pending_points: number;
  pending_events: number;
}

/**
 * Финальный балл посадки из ответа `/complete` (авторитетный, ADR-0004 §2).
 * Используется агентом, чтобы после синка перетереть предпросмотр в
 * `lastLanding` (`score-preview.md` §4).
 */
export interface UploadedLandingScore {
  seq: number;
  score: number | null;
  grade: ScoreGrade | null;
  vs_fpm: number | null;
  bounce_count: number | null;
  touchdown_at: string | null;
  touch_and_go: boolean | null;
}

export interface FlightUploaderOptions {
  apiBaseUrl: string;
  http: HttpClient;
  buffer: OutboxBuffer;
  tokenStore: TokenStore;
  auth: Pick<DeviceAuthClient, 'refresh'>;
  /** CD-6.1: источник телеметрии (`agent`/`electron`); default `agent`. */
  source?: string;
  /** CD-6.1: версия клиента; default — версия `package.json`. */
  version?: string;
  /**
   * ADR-0023: канонический id выбранного `SimSource` (`msfs2024`|`xplane12`).
   * Прокидывается в `provenance()` как `sim`, чтобы рейс X-Plane не был подписан
   * дефолтным `msfs2024` (server-side `DEFAULT_FLIGHT_SIM`). `null`/не задан —
   * поле `sim` не отправляется (MSFS-семантика сохраняется).
   */
  sim?: SimSourceId | null;
  /** CD-6.2: локальный `machine_id` для заголовка `X-TD-Machine-Id`. */
  machineId?: string | null;
  batchSize?: number;
  eventBatchSize?: number;
  retry?: BackoffOptions;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface AuthSession {
  access: string;
  deviceId: string;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_EVENT_BATCH_SIZE = 100;
/**
 * Ограничение числа HTTP-попыток на один запрос по умолчанию. Без него
 * бесконечный backoff навсегда «залипает» в одном flush и блокирует
 * последующие (interval/flight_ended). Дозаливка гарантируется следующим
 * flush'ем, а не бесконечным ретраем внутри одного.
 */
export const DEFAULT_SYNC_MAX_ATTEMPTS = 5;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(response: HttpResponse): string | undefined {
  const body = response.body;
  if (typeof body !== 'object' || body === null) return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Батчевая загрузка outbox → API (T10, api.md §4). Идемпотентна на всех шагах:
 * рейс — upsert по `client_flight_id`, точки/события — по client-id, `/complete`
 * повторяем. Успех помечается списком `client_point_id` (ADR-0007), поэтому
 * повторный flush после сбоя безопасен и не создаёт дублей.
 */
export class FlightUploader {
  private readonly batchSize: number;
  private readonly eventBatchSize: number;
  private readonly retry: BackoffOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** CD-6.1: источник/версия, которые уходят во все agent-запросы. */
  private readonly source: string;
  private readonly version: string;
  /** ADR-0023: id источника телеметрии для provenance (`sim`); `null` — не шлём. */
  private readonly sim: SimSourceId | null;
  /** CD-6.2: `machine_id` для заголовка `X-TD-Machine-Id`; `null` — legacy. */
  private readonly machineId: string | null;
  /**
   * `client_flight_id` → серверный `id`, накопленный при upsert рейсов
   * (`score-preview.md` §4). Нужен серверному предпросмотру касания: у агента
   * на руках только клиентский id.
   */
  private readonly serverFlightIds = new Map<string, string>();
  /** Авторитетные посадки из последнего `/complete` по `client_flight_id`. */
  private readonly finalLandings = new Map<string, UploadedLandingScore[]>();
  private inFlight: Promise<FlushSummary> | null = null;

  constructor(private readonly options: FlightUploaderOptions) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.eventBatchSize = options.eventBatchSize ?? DEFAULT_EVENT_BATCH_SIZE;
    this.retry = options.retry ?? {};
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.source = normalize(options.source) ?? DEFAULT_AGENT_SOURCE;
    this.version = normalize(options.version) ?? packageVersion();
    this.sim = options.sim ?? null;
    this.machineId = normalize(options.machineId);
  }

  /** Сериализует параллельные вызовы: одновременно идёт один flush одного буфера. */
  flush(): Promise<FlushSummary> {
    if (this.inFlight) return this.inFlight;
    const promise = this.doFlush().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = promise;
    return promise;
  }

  /**
   * Серверный `id` рейса по `client_flight_id`, если uploader уже создавал его
   * (`POST /v1/flights`). Используется предпросмотром касания; `null` — рейс
   * ещё не выгружался (превью пропускается, клиент показывает «предварительно»).
   */
  resolveServerFlightId(clientFlightId: string): string | null {
    return this.serverFlightIds.get(clientFlightId) ?? null;
  }

  /** Авторитетные посадки из последнего `/complete` (иначе `null`). */
  resolveFinalLandings(clientFlightId: string): readonly UploadedLandingScore[] | null {
    return this.finalLandings.get(clientFlightId) ?? null;
  }

  private async doFlush(): Promise<FlushSummary> {
    const stored = await this.options.tokenStore.load();
    if (!stored) throw new NotAuthorizedError('no stored device tokens');
    const session: AuthSession = { access: stored.access_token, deviceId: stored.device_id };

    let flightsProcessed = 0;
    let flightsCompleted = 0;
    let flightsAbandoned = 0;
    let pointsUploaded = 0;
    let eventsUploaded = 0;

    for (const flight of this.options.buffer.loadFlights()) {
      if (flight.synced_at !== null && flight.status === 'completed') {
        // T4: хвост, дописанный после финального батча, иначе не уедет никогда
        // (рейс уже synced и пропускался). Дозаливаем по keyset `synced_at === null`;
        // при сбое pending остаётся и повторится следующим flush'ем.
        if (!this.hasPendingRows(flight.client_flight_id)) continue;
        let trailingServerId = await this.upsertFlight(flight, session);
        const trailingPoints = await this.recreateFlightOnNotFound(
          trailingServerId,
          flight,
          session,
          (id) => this.uploadPoints(id, flight.client_flight_id, session),
        );
        trailingServerId = trailingPoints.serverId;
        pointsUploaded += trailingPoints.value;
        const trailingEvents = await this.recreateFlightOnNotFound(
          trailingServerId,
          flight,
          session,
          (id) => this.uploadEvents(id, flight.client_flight_id, session),
        );
        eventsUploaded += trailingEvents.value;
        this.options.buffer.markFlightSynced(flight.client_flight_id, this.nowIso());
        continue;
      }
      flightsProcessed += 1;
      let serverId = await this.upsertFlight(flight, session);
      // CD-3.3 (Gap 3.3): сессия без подтверждённого отрыва — не рейс. Отзываем
      // её через `/abandon` (без точек/событий), чтобы она не стала `completed`.
      if (isDiscardedFlight(flight)) {
        await this.recreateFlightOnNotFound(serverId, flight, session, (id) =>
          this.abandonFlight(id, flight, session),
        );
        this.options.buffer.markFlightSynced(flight.client_flight_id, this.nowIso());
        flightsAbandoned += 1;
        continue;
      }
      const points = await this.recreateFlightOnNotFound(serverId, flight, session, (id) =>
        this.uploadPoints(id, flight.client_flight_id, session),
      );
      serverId = points.serverId;
      pointsUploaded += points.value;

      const events = await this.recreateFlightOnNotFound(serverId, flight, session, (id) =>
        this.uploadEvents(id, flight.client_flight_id, session),
      );
      serverId = events.serverId;
      eventsUploaded += events.value;

      if (flight.status === 'completed' && flight.ended_at) {
        await this.recreateFlightOnNotFound(serverId, flight, session, (id) =>
          this.completeFlight(id, flight, session),
        );
        this.options.buffer.markFlightSynced(flight.client_flight_id, this.nowIso());
        flightsCompleted += 1;
      }
    }

    const pending = this.options.buffer.pendingCounts();
    return {
      flights_processed: flightsProcessed,
      flights_completed: flightsCompleted,
      flights_abandoned: flightsAbandoned,
      points_uploaded: pointsUploaded,
      events_uploaded: eventsUploaded,
      pending_flights: pending.pendingFlights,
      pending_points: pending.pendingPoints,
      pending_events: pending.pendingEvents,
    };
  }

  /** T4: есть ли в рейсе несинхронизированные точки/события (keyset по `synced_at`). */
  private hasPendingRows(clientFlightId: string): boolean {
    return (
      this.options.buffer.loadPoints(clientFlightId).some((point) => point.synced_at === null) ||
      this.options.buffer.loadEvents(clientFlightId).some((event) => event.synced_at === null)
    );
  }

  /**
   * CD-6.1: информационное происхождение (`source`/`client_version`, §3.3.3).
   * ADR-0023: `sim` — канонический id фактического источника телеметрии. Уходит
   * в `POST /v1/flights` (и `/complete`), поэтому X-Plane-рейс сохраняется как
   * `xplane12`, а не дефолтным `msfs2024`. Эндпоинты `track/events/abandon`
   * толерантны (`.strip()`) — лишнее поле там отбрасывается.
   */
  private provenance(): { source: string; client_version: string; sim?: SimSourceId } {
    return {
      source: this.source,
      client_version: this.version,
      ...(this.sim ? { sim: this.sim } : {}),
    };
  }

  /**
   * CD-3 (gap-audit §2 CD-3, INC-UPLOAD3a / api.md §13.8): `404 NOT_FOUND` на
   * flight-маршруте (`track/batch`, `events/batch`, `complete`, `abandon`) —
   * серверную запись удалили или перепривязали к другому устройству. Это
   * recoverable: повторный upsert (`POST /v1/flights` с тем же
   * `client_flight_id`) пересоздаёт/перепривязывает рейс, после чего операция
   * повторяется один раз. Буфер не трогаем — pending-строки остаются в outbox,
   * flush не «залипает». Если повтор тоже отдал 404 — ошибка уходит наверх,
   * дозаливка произойдёт следующим flush'ем.
   */
  private async recreateFlightOnNotFound<T>(
    serverId: string,
    flight: OutboxFlight,
    session: AuthSession,
    run: (serverId: string) => Promise<T>,
  ): Promise<{ serverId: string; value: T }> {
    try {
      return { serverId, value: await run(serverId) };
    } catch (error) {
      if (!isMissingFlight(error)) throw error;
      const recreated = await this.upsertFlight(flight, session);
      return { serverId: recreated, value: await run(recreated) };
    }
  }

  private async upsertFlight(flight: OutboxFlight, session: AuthSession): Promise<string> {
    // T-D §5.6: сырая строка модели — обучающая пара для словаря. Опционально:
    // при отсутствии ключ не отправляется (old outbox не ломается).
    const aircraftModelRaw = toAircraftModelRaw(flight.stats.aircraft_model_raw);
    const body: FlightCreateInput = flightCreateSchema.parse({
      client_flight_id: flight.client_flight_id,
      aircraft_icao: flight.aircraft_icao,
      callsign: flight.callsign,
      origin_icao: flight.origin_icao,
      destination_icao: flight.destination_icao,
      started_at: flight.started_at,
      device_id: session.deviceId,
      ...(aircraftModelRaw ? { aircraft_model_raw: aircraftModelRaw } : {}),
      ...this.provenance(),
    });
    const response = await this.sendAuthed(
      { method: 'POST', url: `${this.options.apiBaseUrl}/v1/flights`, body },
      session,
    );
    this.assertOk(response, 'create flight');
    const data = (response.body as { data?: { id?: unknown } } | null)?.data;
    if (!data || typeof data.id !== 'string') {
      throw new SyncError('create flight response is missing data.id', {
        status: response.status,
        retryable: false,
      });
    }
    this.serverFlightIds.set(flight.client_flight_id, data.id);
    return data.id;
  }

  private async uploadPoints(
    serverId: string,
    clientFlightId: string,
    session: AuthSession,
  ): Promise<number> {
    let batchSize = this.batchSize;
    let uploaded = 0;
    for (;;) {
      const pending = this.options.buffer
        .loadPoints(clientFlightId)
        .filter((point) => point.synced_at === null);
      if (pending.length === 0) break;
      const batch = pending.slice(0, batchSize);
      // CD-3.6 (Gap 3.6): сериализуем tolerant-схемой приёма, а не канонической.
      // Историческая «грязная» строка (дробный `vs_fpm`, `null`/`NaN`, выход за
      // диапазон) санитизируется, а не роняет flush и не «залипает» в очереди.
      const payloads = batch.map(toPointPayload);
      const parsed = trackBatchIngestSchema.safeParse({
        points: payloads,
        ...this.provenance(),
      });
      const batchIds = batch.map((point) => point.client_point_id);
      if (!parsed.success) {
        // В батче не осталось ни одной пригодной точки (нет identity/геометрии).
        // Такие строки непринимаемы в принципе — помечаем, чтобы очередь не встала.
        this.options.buffer.markPointsSynced(clientFlightId, batchIds, this.nowIso());
        continue;
      }
      const body = { points: parsed.data.points, ...this.provenance() };
      const response = await this.sendAuthed(
        {
          method: 'POST',
          url: `${this.options.apiBaseUrl}/v1/flights/${serverId}/track/batch`,
          body,
        },
        session,
      );
      if (response.status === 413 && batchSize > 1) {
        batchSize = Math.max(1, Math.floor(batchSize / 2));
        continue;
      }
      this.assertOk(response, 'track batch');
      // Помечаем весь исходный батч (включая поштучно отброшенные сервером/
      // санитайзом непригодные строки) — иначе они зациклят flush навсегда.
      this.options.buffer.markPointsSynced(clientFlightId, batchIds, this.nowIso());
      uploaded += batch.length;
    }
    return uploaded;
  }

  private async uploadEvents(
    serverId: string,
    clientFlightId: string,
    session: AuthSession,
  ): Promise<number> {
    let batchSize = this.eventBatchSize;
    let uploaded = 0;
    for (;;) {
      const pending = this.options.buffer
        .loadEvents(clientFlightId)
        .filter((event) => event.synced_at === null);
      if (pending.length === 0) break;
      const batch = pending.slice(0, batchSize);
      const body = flightEventsBatchSchema.parse({
        events: batch.map(toEventPayload),
        ...this.provenance(),
      });
      const response = await this.sendAuthed(
        {
          method: 'POST',
          url: `${this.options.apiBaseUrl}/v1/flights/${serverId}/events/batch`,
          body,
        },
        session,
      );
      if (response.status === 413 && batchSize > 1) {
        batchSize = Math.max(1, Math.floor(batchSize / 2));
        continue;
      }
      this.assertOk(response, 'events batch');
      this.options.buffer.markEventsSynced(
        clientFlightId,
        batch.map((event) => event.client_event_id),
        this.nowIso(),
      );
      uploaded += batch.length;
    }
    return uploaded;
  }

  /**
   * R1: X-Plane-фолбэк — досчитать `sim_runway` из apt.dat, если рекордер не
   * знал ICAO прилёта. Аэропорт берём из destination или ближайший к касанию.
   */
  private async resolveSimRunwayFromStats(
    stats: Record<string, unknown>,
    destinationIcao: string | null,
  ): Promise<SimRunway | null> {
    if (this.sim !== 'xplane12') return null;
    const touchdown = parseTouchdownGeo(stats.touchdown_geo);
    if (!touchdown) return null;
    try {
      const icao =
        normalize(destinationIcao) ??
        (await findNearestAirportIcao(touchdown.latitude, touchdown.longitude));
      if (!icao) return null;
      return await resolveSimRunway(icao, touchdown);
    } catch {
      return null;
    }
  }

  private async completeFlight(
    serverId: string,
    flight: OutboxFlight,
    session: AuthSession,
  ): Promise<void> {
    const stats = flight.stats;
    // WAVE 4: финализированные FOQA-агрегаты (whitelist) + `landings_analysis`.
    const aggregates = pickClientAggregates(stats);
    // R1: геометрия ВПП от симулятора идёт top-level (не в stats). X-Plane
    // может досчитать её здесь, если в рекордере не было ICAO прилёта.
    const storedSimRunway = simRunwaySchema.safeParse(stats.sim_runway);
    const simRunway =
      (storedSimRunway.success ? storedSimRunway.data : null) ??
      (await this.resolveSimRunwayFromStats(stats, flight.destination_icao));
    const body = flightCompleteSchema.parse({
      ended_at: flight.ended_at,
      client_flight_id: flight.client_flight_id,
      is_partial: optionalBoolean(stats.is_partial),
      paused_total_s: optionalNumber(stats.paused_total_s),
      quality_flags: optionalNumber(stats.quality_flags),
      ...(aggregates ? { stats: aggregates } : {}),
      ...(simRunway ? { sim_runway: simRunway } : {}),
      ...this.provenance(),
    });
    const response = await this.sendAuthed(
      {
        method: 'POST',
        url: `${this.options.apiBaseUrl}/v1/flights/${serverId}/complete`,
        body,
      },
      session,
    );
    this.assertOk(response, 'complete flight');
    this.rememberFinalLandings(flight.client_flight_id, response.body);
  }

  /**
   * CD-3.3 (Gap 3.3): `POST /v1/flights/{id}/abandon` для сессии без
   * подтверждённого отрыва. Тело — `client_flight_id` + информационное
   * происхождение (аналог `/complete` без `ended_at`; сервер ставит `ended_at`
   * и переводит рейс в `abandoned`). Идемпотентно.
   */
  private async abandonFlight(
    serverId: string,
    flight: OutboxFlight,
    session: AuthSession,
  ): Promise<void> {
    const discardReason =
      flight.stats.discard_reason === 'no_flight_evidence' ? 'no_flight_evidence' : undefined;
    const response = await this.sendAuthed(
      {
        method: 'POST',
        url: `${this.options.apiBaseUrl}/v1/flights/${serverId}/abandon`,
        body: {
          client_flight_id: flight.client_flight_id,
          ...(discardReason ? { discard_reason: discardReason } : {}),
          ...this.provenance(),
        },
      },
      session,
    );
    this.assertOk(response, 'abandon flight');
  }

  /**
   * Запоминает авторитетные посадки из ответа `/complete` по `client_flight_id`
   * (`score-preview.md` §4). Толерантно к отсутствию `data.landings` (старый
   * сервер/моки): тогда карта не пополняется и `lastLanding` не трогается.
   */
  private rememberFinalLandings(clientFlightId: string, body: unknown): void {
    const data =
      typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
    const landings =
      typeof data === 'object' && data !== null
        ? (data as { landings?: unknown }).landings
        : undefined;
    if (!Array.isArray(landings)) return;
    const mapped = landings.flatMap((entry) => {
      const parsed = toUploadedLandingScore(entry);
      return parsed ? [parsed] : [];
    });
    if (mapped.length > 0) this.finalLandings.set(clientFlightId, mapped);
  }

  private async sendAuthed(request: HttpRequest, session: AuthSession): Promise<HttpResponse> {
    const withAuth = (token: string): HttpRequest => ({
      ...request,
      headers: {
        ...(request.headers ?? {}),
        authorization: `Bearer ${token}`,
        ...(this.machineId ? { 'x-td-machine-id': this.machineId } : {}),
      },
    });

    let response = await this.requestWithRetry(withAuth(session.access));
    if (response.status === 401) {
      const refreshed = await this.options.auth.refresh();
      session.access = refreshed.access_token;
      session.deviceId = refreshed.device_id;
      response = await this.requestWithRetry(withAuth(session.access));
    }
    return response;
  }

  private async requestWithRetry(request: HttpRequest): Promise<HttpResponse> {
    const maxAttempts = this.retry.maxAttempts ?? Number.POSITIVE_INFINITY;
    let attempt = 0;
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.options.http.request(request);
      } catch (error) {
        if (attempt >= maxAttempts - 1) {
          throw new SyncError(`network failure: ${String(error)}`, { retryable: true });
        }
        await this.sleep(this.nextDelay(attempt));
        attempt += 1;
        continue;
      }

      if (isRetryableStatus(response.status)) {
        if (attempt >= maxAttempts - 1) {
          throw new SyncError(
            `request failed with HTTP ${response.status} after ${attempt + 1} attempts`,
            { status: response.status, retryable: true, code: errorCode(response) },
          );
        }
        const retryAfter = parseRetryAfterMs(response.headers, this.now());
        await this.sleep(retryAfter ?? this.nextDelay(attempt));
        attempt += 1;
        continue;
      }
      return response;
    }
  }

  private nextDelay(attempt: number): number {
    return backoffDelayMs(attempt, this.retry);
  }

  private assertOk(response: HttpResponse, context: string): void {
    if (response.status === 401) throw new NotAuthorizedError();
    if (isOkStatus(response.status)) return;
    const code = errorCode(response);
    // CD-6.2: явный сигнал сервера — устройство привязано к другой машине.
    if (response.status === 403 && code === 'MACHINE_MISMATCH') {
      throw new MachineMismatchError(`${context}: MACHINE_MISMATCH`);
    }
    throw new SyncError(
      `${context} failed with HTTP ${response.status}${code ? ` (${code})` : ''}`,
      { status: response.status, retryable: false, code },
    );
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }
}

/** Отбрасывает локальные outbox-поля перед отправкой строгой схеме батча. */
function toPointPayload(record: OutboxPointRecord): TrackPoint {
  const { client_flight_id: _clientFlightId, synced_at: _syncedAt, ...point } = record;
  return point;
}

function toEventPayload(record: OutboxEventRecord): FlightEvent {
  const { client_flight_id: _clientFlightId, synced_at: _syncedAt, ...event } = record;
  return event;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * WAVE 4: whitelist скалярных FOQA-ключей, которые клиент шлёт в
 * `/complete.stats` (сервер вливает их в `flights.stats` без mass assignment).
 * `landings_analysis` обрабатывается отдельно (раскладывается по `landings`).
 * Значения `null` пропускаются — отсутствие ключа и есть «измерения нет».
 */
const CLIENT_AGGREGATE_KEYS = [
  'landing_weight_kg',
  'landing_weight_source',
  'atc_runway_missing',
  'phases',
  'stability',
  'events',
  'config_at_1000ft',
  'config_at_500ft',
  'ap_disconnect_agl_ft',
  'at_disconnect_agl_ft',
  'flare_height_ft',
  'flare_duration_s',
  // FOQA-DATUM-1: датум-калибровка AGL и высоты колёс (аддитивно).
  'agl_datum_offset_ft',
  'agl_datum_version',
  'height_datum_calibrated',
  'flare_height_wheel_ft',
  'wheel_height_touchdown_ft',
  'ils',
  'aoa_touchdown_deg',
  'aoa_max_near_touchdown_deg',
  'cg_percent_touchdown',
  'surface_condition',
  'surface_type',
  'touchdown_point',
  'radio_height_touchdown_ft',
  // ENGINE-MODE: двигатели представительной посадки (аддитивно).
  'engine_touchdown',
  'engine_rollout',
  'wind_shear',
] as const;

/**
 * Выбирает из `stats` только whitelisted FOQA-агрегаты и `landings_analysis`,
 * валидирует схемой `flightAggregatesSchema`. Возвращает `undefined`, если
 * отправлять нечего или данные не проходят схему (загрузка `/complete` не
 * должна падать из-за аналитики — она аддитивна).
 */
export function pickClientAggregates(
  stats: Record<string, unknown>,
): FlightAggregatesInput | undefined {
  const candidate: Record<string, unknown> = {};
  for (const key of CLIENT_AGGREGATE_KEYS) {
    const value = stats[key];
    if (value !== undefined && value !== null) candidate[key] = value;
  }
  const landingsAnalysis = stats.landings_analysis;
  if (
    typeof landingsAnalysis === 'object' &&
    landingsAnalysis !== null &&
    !Array.isArray(landingsAnalysis) &&
    Object.keys(landingsAnalysis).length > 0
  ) {
    candidate.landings_analysis = landingsAnalysis;
  }
  if (Object.keys(candidate).length === 0) return undefined;
  const parsed = flightAggregatesSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * T-D §5.6: `stats.aircraft_model_raw` → `aircraft_model_raw` тела ingest.
 * Нормализует (`upper/trim/collapse`) и обрезает до 128 символов, чтобы строка
 * из старого outbox не уронила `flightCreateSchema.parse`. Пустая → `undefined`
 * (поле не отправляется).
 */
function toAircraftModelRaw(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = normalizeAircraftModelText(value).slice(0, AIRCRAFT_MODEL_SOURCE_MAX);
  return normalized.length > 0 ? normalized : undefined;
}

/** CD-3.3: рекордер помечает сессию без подтверждённого отрыва (`discarded`). */
function isDiscardedFlight(flight: OutboxFlight): boolean {
  return flight.stats.no_flight_evidence === true;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Локальный `stats.touchdown_geo` рекордера → точка для apt.dat-матчинга. */
function parseTouchdownGeo(value: unknown): SimTouchdownPoint | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const latitude = finiteOrNull(record.latitude);
  const longitude = finiteOrNull(record.longitude);
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude, headingDeg: finiteOrNull(record.heading_deg) };
}

/** Толерантный парсер одной посадки из ответа `/complete` (без throw). */
function toUploadedLandingScore(value: unknown): UploadedLandingScore | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const seq = finiteOrNull(record.seq);
  if (seq === null) return null;
  const metrics =
    typeof record.metrics === 'object' && record.metrics !== null
      ? (record.metrics as Record<string, unknown>)
      : {};
  const grade = scoreGradeSchema.safeParse(record.grade);
  return {
    seq,
    score: finiteOrNull(record.score),
    grade: grade.success ? grade.data : null,
    vs_fpm: finiteOrNull(metrics.vs_fpm),
    bounce_count: finiteOrNull(metrics.bounce_count),
    touchdown_at: typeof record.touchdown_at === 'string' ? record.touchdown_at : null,
    touch_and_go: typeof record.touch_and_go === 'boolean' ? record.touch_and_go : null,
  };
}

/**
 * CD-3: признак «сервер не знает рейс» — `404 NOT_FOUND` (api.md §13.8). Любой
 * 404 на flight-маршруте считаем recoverable (рейс удалён/чужое устройство).
 */
function isMissingFlight(error: unknown): boolean {
  return (
    error instanceof SyncError &&
    error.options.status === 404 &&
    (error.options.code === undefined || error.options.code === 'NOT_FOUND')
  );
}

/** Тримит непустую строку, иначе `null` (для опциональных origin/`machine_id`). */
function normalize(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type { StoredTokens };
