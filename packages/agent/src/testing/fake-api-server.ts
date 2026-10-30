import type { HttpClient, HttpRequest, HttpResponse } from '../sync/http.js';

interface StoredFlight {
  id: string;
  client_flight_id: string;
}

type Hook = (request: HttpRequest, calls: readonly HttpRequest[]) => HttpResponse | null;

function randomId(seed: number): string {
  const hex = (seed + 1).toString(16).padStart(12, '0').slice(-12);
  return `aaaaaaaa-aaaa-4aaa-8aaa-${hex}`;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body };
}

/**
 * Мини-эмуляция API для тестов uploader: идемпотентность по `client_point_id`/
 * `client_event_id`, upsert рейса, `/complete`. Позволяет инжектить сбои через
 * `hook` (исключение = сетевая ошибка, `HttpResponse` = ответ сервера).
 */
export class FakeApiServer {
  readonly flights = new Map<string, StoredFlight>();
  readonly points = new Map<string, unknown>();
  readonly events = new Map<string, unknown>();
  readonly completed = new Set<string>();
  /** CD-3.3: рейсы, отозванные через `POST .../abandon`. */
  readonly abandoned = new Set<string>();
  readonly calls: HttpRequest[] = [];
  duplicatePoints = 0;
  duplicateEvents = 0;
  hook: Hook | null = null;

  private nextId = 0;

  asHttpClient(): HttpClient {
    return {
      request: (request) => Promise.resolve(this.handle(request)),
    };
  }

  handle(request: HttpRequest): HttpResponse {
    this.calls.push(request);
    const injected = this.hook?.(request, this.calls);
    if (injected) return injected;
    return this.route(request);
  }

  private route(request: HttpRequest): HttpResponse {
    const path = new URL(request.url).pathname;
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (request.method === 'POST' && path === '/v1/flights') {
      const clientFlightId = String(body.client_flight_id);
      let flight = this.flights.get(clientFlightId);
      if (!flight) {
        this.nextId += 1;
        flight = { id: randomId(this.nextId), client_flight_id: clientFlightId };
        this.flights.set(clientFlightId, flight);
      }
      return json(200, { data: { id: flight.id, client_flight_id: clientFlightId } });
    }

    const pointsMatch = path.match(/^\/v1\/flights\/([^/]+)\/track\/batch$/);
    if (request.method === 'POST' && pointsMatch) {
      const flightId = pointsMatch[1] ?? '';
      const points = Array.isArray(body.points)
        ? (body.points as Array<{ client_point_id: string }>)
        : [];
      let accepted = 0;
      for (const point of points) {
        const key = `${flightId}:${point.client_point_id}`;
        if (this.points.has(key)) {
          this.duplicatePoints += 1;
          continue;
        }
        this.points.set(key, point);
        accepted += 1;
      }
      return json(200, {
        data: {
          accepted,
          duplicates: points.length - accepted,
          rejected: 0,
          server_max_seq: points.length,
          next_expected_seq: points.length + 1,
        },
      });
    }

    const eventsMatch = path.match(/^\/v1\/flights\/([^/]+)\/events\/batch$/);
    if (request.method === 'POST' && eventsMatch) {
      const flightId = eventsMatch[1] ?? '';
      const events = Array.isArray(body.events)
        ? (body.events as Array<{ client_event_id: string }>)
        : [];
      let accepted = 0;
      for (const event of events) {
        const key = `${flightId}:${event.client_event_id}`;
        if (this.events.has(key)) {
          this.duplicateEvents += 1;
          continue;
        }
        this.events.set(key, event);
        accepted += 1;
      }
      return json(200, { data: { accepted, duplicates: events.length - accepted } });
    }

    const completeMatch = path.match(/^\/v1\/flights\/([^/]+)\/complete$/);
    if (request.method === 'POST' && completeMatch) {
      const flightId = completeMatch[1] ?? '';
      this.completed.add(flightId);
      return json(200, { data: { status: 'completed', score: { score: 90 } } });
    }

    const abandonMatch = path.match(/^\/v1\/flights\/([^/]+)\/abandon$/);
    if (request.method === 'POST' && abandonMatch) {
      const flightId = abandonMatch[1] ?? '';
      this.abandoned.add(flightId);
      return json(200, { data: { status: 'abandoned' } });
    }

    return json(404, { code: 'NOT_FOUND', detail: `no route for ${request.method} ${path}` });
  }
}
