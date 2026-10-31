/**
 * X-Plane 12 read-only транспорт (ADR-0023). Точка входа модуля `sim/xplane/**`.
 *
 * Публичная поверхность: фабрика `createXPlaneSimSource` (Web API + RREF fallback),
 * дешёвая проба `probeXPlaneAvailable` для `auto`-дискавери и переиспользуемые
 * чистые части (codec/маппинг/таблица) для probe-скрипта и тестов.
 */
import type { SimConnectAdapterLogger } from '../node-simconnect-adapter.js';
import {
  parseXPlaneTransport,
  readXPlaneRrefPort,
  readXPlaneWebUrl,
  XP_CAPABILITIES_TIMEOUT_MS,
  XP_TRANSPORT_ENV,
} from './config.js';
import { XPLANE_DATAREFS } from './datarefs.js';
import { defaultDgramSocketFactory, XPlaneRrefSimSource, type DgramSocketFactory } from './rref-source.js';
import { encodeRrefRequest, isRrefResponse } from './rref.js';
import { XPlaneRestClient } from './http.js';
import { XPlaneWebApiSimSource } from './web-api-source.js';
import { XPlaneAutoSimSource } from './auto-source.js';

export interface XPlaneSimSourceContext {
  logger?: SimConnectAdapterLogger;
  maxSampleHz?: number;
}

/** Фабрика XP-источника: transport из `AGENT_XP_TRANSPORT` (дефолт `auto`). */
export function createXPlaneSimSource(
  context: XPlaneSimSourceContext = {},
  env: Record<string, string | undefined> = process.env,
): XPlaneAutoSimSource {
  const parsed = parseXPlaneTransport(env[XP_TRANSPORT_ENV]);
  if (parsed.unknown !== null) {
    context.logger?.warn(
      `${XP_TRANSPORT_ENV}: unknown value '${parsed.unknown}' ` +
        `(known: auto, web, rref); falling back to 'auto'`,
      { xp_transport_env: XP_TRANSPORT_ENV, requested: parsed.unknown },
    );
  }
  return new XPlaneAutoSimSource({
    logger: context.logger,
    preference: parsed.preference,
    web: new XPlaneWebApiSimSource({
      logger: context.logger,
      maxSampleHz: context.maxSampleHz,
      baseUrl: readXPlaneWebUrl(env),
    }),
    rref: new XPlaneRrefSimSource({
      logger: context.logger,
      maxSampleHz: context.maxSampleHz,
      port: readXPlaneRrefPort(env),
    }),
  });
}

export interface XPlaneProbeOptions {
  baseUrl?: string;
  host?: string;
  port?: number;
  timeoutMs?: number;
  socketFactory?: DgramSocketFactory;
}

/** Дешёвая read-only проба Web API (`GET /api/capabilities`, ~timeout). */
export async function probeXPlaneWebApi(options: XPlaneProbeOptions = {}): Promise<boolean> {
  try {
    const rest = new XPlaneRestClient({
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs ?? XP_CAPABILITIES_TIMEOUT_MS,
    });
    await rest.getCapabilities();
    return true;
  } catch {
    return false;
  }
}

/** Дешёвая read-only проба UDP RREF (один `RREF`-запрос, ждём ответ). */
export function probeXPlaneRref(options: XPlaneProbeOptions = {}): Promise<boolean> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? readXPlaneRrefPort();
  const timeoutMs = options.timeoutMs ?? 300;
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let socket: ReturnType<DgramSocketFactory> | null = null;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.removeAllListeners?.();
        socket?.close();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = (options.socketFactory ?? defaultDgramSocketFactory)();
      socket.on('error', () => finish(false));
      socket.on('message', (message) => {
        if (isRrefResponse(message)) finish(true);
      });
      socket.send(encodeRrefRequest(XPLANE_DATAREFS.paused.dataref, 1, 0), port, host);
    } catch {
      finish(false);
    }
  });
}

/** `true`, если запущен XP12 (Web API или RREF) — только read-only пробы. */
export async function probeXPlaneAvailable(options: XPlaneProbeOptions = {}): Promise<boolean> {
  if (await probeXPlaneWebApi(options)) return true;
  return probeXPlaneRref(options);
}

export { XPlaneAutoSimSource, type XPlaneAutoSimSourceOptions } from './auto-source.js';
export { XPlaneWebApiSimSource, defaultXPlaneSocketFactory } from './web-api-source.js';
export type { XPlaneSocket, XPlaneSocketFactory, XPlaneWebApiSimSourceOptions } from './web-api-source.js';
export {
  XPlaneRrefSimSource,
  XPlaneRrefUnavailableError,
  defaultDgramSocketFactory,
} from './rref-source.js';
export type { DgramSocketFactory, DgramSocketLike, XPlaneRrefSimSourceOptions } from './rref-source.js';
export { XPlaneRestClient, XPlaneWebApiError, parseCapabilities, parseDatarefList } from './http.js';
export type {
  XPlaneCapabilities,
  XPlaneDatarefInfo,
  XPlaneRestClientOptions,
  XPlaneWebApiErrorReason,
} from './http.js';
export { buildSubscribeMessage, buildUnsubscribeMessage, parseUpdateMessage } from './messages.js';
export type { XPlaneDatarefUpdate } from './messages.js';
export {
  XPLANE_ALLOWED_DATAREFS,
  XPLANE_CORE_REQUIRED_DATAREFS,
  XPLANE_DATAREFS,
  XPLANE_NO_EQUIVALENT_FIELDS,
  XPLANE_REQUIRED_DATAREFS,
  isAllowedXPlaneDataref,
  planRrefSubscriptions,
  planWebApiSubscriptions,
  xplaneDatarefName,
  xplaneDatarefSpec,
} from './datarefs.js';
export type {
  XPlaneDatarefRole,
  XPlaneDatarefSpec,
  XPlaneSubscriptionTarget,
  XPlaneValueType,
} from './datarefs.js';
export {
  DEG_TO_RAD,
  KG_PER_SEC_TO_PPH,
  LB_PER_KG,
  METERS_TO_FEET,
  MIN_PLAUSIBLE_RUNNING_ITT_C,
  MPS_TO_KNOTS,
  PASCALS_TO_HPA,
  STATUTE_MILES_TO_METERS,
  buildXPlaneSample,
  decodeXPlaneString,
  readXPlaneBool,
  readXPlaneNumber,
  readXPlaneNumbers,
  replayActive,
  setXPlaneValue,
  timeWarpActive,
} from './values.js';
export type { XPlaneRawValue, XPlaneValueMap } from './values.js';
export {
  RREF_HEADER_BYTES,
  RREF_MAGIC,
  RREF_NAME_BYTES,
  RREF_PAIR_BYTES,
  RREF_POSITION_TOLERANCE_M,
  RREF_REQUEST_BYTES,
  decodeRrefResponse,
  decodeRrefValues,
  encodeRrefRequest,
  isRrefResponse,
} from './rref.js';
export type { RrefPair } from './rref.js';
export { describeMissingXPlaneDatarefs, describeXPlaneSubscription } from './diagnostics.js';
export type { XPlaneSubscriptionReport } from './diagnostics.js';
export {
  XPLANE_ACF_MAX_BYTES,
  XPLANE_AIRCRAFT_IDENTITY_RECHECK_MS,
  XPLANE_LOG_TAIL_MAX_BYTES,
  clearXPlaneAircraftIdentityCache,
  parseAcfIdentity,
  parseLogAircraftPath,
  resolveXPlaneAircraftIdentity,
} from './aircraft-identity.js';
export type {
  XPlaneAircraftIdentity,
  XPlaneAircraftIdentityCache,
  XPlaneAircraftIdentityCacheEntry,
  XPlaneAircraftIdentityOptions,
  XPlaneAircraftIdentityStats,
} from './aircraft-identity.js';
export {
  DEFAULT_XP_TRANSPORT_PREFERENCE,
  KNOWN_XP_TRANSPORT_PREFERENCES,
  XP_CAPABILITIES_TIMEOUT_MS,
  XP_CONNECT_TIMEOUT_MS,
  XP_DEFAULT_MAX_SAMPLE_HZ,
  XP_RREF_DEFAULT_HOST,
  XP_RREF_DEFAULT_PORT,
  XP_RREF_PORT_ENV,
  XP_TRANSPORT_ENV,
  XP_WEB_API_DEFAULT_URL,
  XP_WEB_URL_ENV,
  XPlaneNonLoopbackError,
  isLoopbackHost,
  parseLoopbackUrl,
  parseXPlaneTransport,
  readXPlaneRrefPort,
  readXPlaneWebUrl,
  toXPlaneWebSocketUrl,
} from './config.js';
export type { ParsedXPlaneTransport, XPlaneTransportPreference } from './config.js';
