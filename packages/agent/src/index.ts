/**
 * `@flightlog/agent` — тонкий read-only модуль SimConnect для MSFS 2024 (T8/T9/T33)
 * и офлайн-синхронизация через device flow (`sync/`, T10).
 *
 * Жёсткие ограничения (AGENTS.md): подключение к симулятору ТОЛЬКО read-only и
 * только с явного разрешения владельца. Модуль не меняет переменные сима,
 * не ставит/снимает паузу и не вмешивается в активный полёт.
 */
import { packageVersion } from './util/provenance.js';

export const AGENT_PACKAGE_VERSION = packageVersion();

export type {
  SimConnectAdapter,
  SimConnectAdapterEvents,
  SimConnectOpenInfo,
  TelemetrySample,
} from './sim/types.js';
export {
  DEFAULT_SIM_SOURCE_ID,
  DEFAULT_SIM_SOURCE_PREFERENCE,
  KNOWN_SIM_SOURCE_PREFERENCES,
  SIM_SOURCE_ENV,
  type SimSource,
  type SimSourceCapabilities,
  type SimSourceDiagnostics,
  type SimSourceEvents,
  type SimSourceId,
  type SimSourceOpenInfo,
  type SimSourcePreference,
} from './sim/source.js';
export {
  createSimSource,
  createSimSourceResolver,
  discoverSimSourceId,
  listRegisteredSimSources,
  parseSimSourcePreference,
  probeSimSourceId,
  registerSimSource,
  registerXPlaneSimSource,
  resolveSimSourceId,
  unregisterSimSource,
  type DiscoverSimSourceOptions,
  type ParsedSimSourcePreference,
  type ResolveSimSourceIdOptions,
  type SimSourceCreateContext,
  type SimSourceFactory,
  type SimSourceLogger,
  type SimSourceResolver,
  type SimSourceResolverOptions,
} from './sim/registry.js';
export {
  DEFAULT_REDISCOVERY_COOLDOWN_MS,
  SimSession,
  type SimRediscoveryOutcome,
  type SimRediscoveryReason,
  type SimRediscoveryStatus,
  type SimSessionDiscovery,
  type SimSessionOptions,
  type SimSessionSnapshot,
} from './sim/session.js';
export { packageVersion, resolveProvenance, DEFAULT_AGENT_SOURCE } from './util/provenance.js';
export { generateMachineId, parseMachineId, resolveMachineId } from './sync/machine-id.js';
export {
  NodeSimConnectAdapter,
  DEFAULT_CLIENT_NAME,
  DEFAULT_PROTOCOL,
  BASE_SIMVAR_DEFINITION,
  SIMVAR_DEFINITION,
  FOQA_GROUP_ORDER,
  FOQA_SIMVAR_GROUPS,
  FOQA_SIMVARS_ENV,
  ENABLED_FOQA_GROUPS,
  UNKNOWN_FOQA_GROUPS,
  buildSimVarDefinition,
  parseFoqaGroups,
  findFoqaGroupForField,
  describeSimVarDefinition,
  expectedSimVarLayoutSize,
  buildSimVarSendIdMap,
  selectRejectedSimVar,
  describeRejectedSimVar,
  parseSample,
  probeSimConnectAvailability,
  type FoqaGroupSelection,
  type FoqaSimVarGroup,
  type NodeSimConnectAdapterOptions,
  type RejectedSimVar,
  type SimConnectAdapterLogger,
  type SimConnectExceptionLike,
  type SimVarDefinition,
  type SimVarDefinitionDiagnostics,
  type SimVarField,
  type SimVarReader,
  type SimVarSendIdEntry,
} from './sim/node-simconnect-adapter.js';
export {
  MOCK_OPEN_INFO,
  MockSimConnectAdapter,
  type MockSimConnectAdapterOptions,
} from './sim/mock-adapter.js';

export {
  XPlaneAutoSimSource,
  XPlaneRrefSimSource,
  XPlaneRrefUnavailableError,
  XPlaneRestClient,
  XPlaneWebApiError,
  XPlaneWebApiSimSource,
  createXPlaneSimSource,
  probeXPlaneAvailable,
  probeXPlaneRref,
  probeXPlaneWebApi,
  clearXPlaneAircraftIdentityCache,
  parseAcfIdentity,
  parseLogAircraftPath,
  resolveXPlaneAircraftIdentity,
  defaultDgramSocketFactory,
  defaultXPlaneSocketFactory,
} from './sim/xplane/index.js';
export type {
  DgramSocketFactory,
  DgramSocketLike,
  XPlaneAircraftIdentity,
  XPlaneAircraftIdentityCache,
  XPlaneAircraftIdentityCacheEntry,
  XPlaneAircraftIdentityOptions,
  XPlaneAircraftIdentityStats,
  XPlaneAutoSimSourceOptions,
  XPlaneCapabilities,
  XPlaneDatarefInfo,
  XPlaneRrefSimSourceOptions,
  XPlaneSocket,
  XPlaneSocketFactory,
  XPlaneSubscriptionReport,
  XPlaneWebApiErrorReason,
  XPlaneWebApiSimSourceOptions,
} from './sim/xplane/index.js';
export {
  XPLANE_ALLOWED_DATAREFS,
  XPLANE_CORE_REQUIRED_DATAREFS,
  XPLANE_DATAREFS,
  XPLANE_NO_EQUIVALENT_FIELDS,
  XPLANE_REQUIRED_DATAREFS,
  buildSubscribeMessage,
  buildUnsubscribeMessage,
  buildXPlaneSample,
  decodeRrefResponse,
  decodeRrefValues,
  decodeXPlaneString,
  describeMissingXPlaneDatarefs,
  describeXPlaneSubscription,
  encodeRrefRequest,
  isAllowedXPlaneDataref,
  isLoopbackHost,
  isRrefResponse,
  parseCapabilities,
  parseDatarefList,
  parseLoopbackUrl,
  parseUpdateMessage,
  parseXPlaneTransport,
  planRrefSubscriptions,
  planWebApiSubscriptions,
  readXPlaneBool,
  readXPlaneNumber,
  readXPlaneNumbers,
  setXPlaneValue,
  timeWarpActive,
  toXPlaneWebSocketUrl,
  xplaneDatarefName,
  xplaneDatarefSpec,
  XPlaneNonLoopbackError,
  RREF_POSITION_TOLERANCE_M,
  RREF_REQUEST_BYTES,
  XP_TRANSPORT_ENV,
  XP_WEB_URL_ENV,
} from './sim/xplane/index.js';
export type {
  ParsedXPlaneTransport,
  RrefPair,
  XPlaneDatarefRole,
  XPlaneDatarefSpec,
  XPlaneRawValue,
  XPlaneSubscriptionTarget,
  XPlaneTransportPreference,
  XPlaneValueMap,
  XPlaneValueType,
} from './sim/xplane/index.js';

export {
  FlightPhaseDetector,
  FLIGHT_PHASES,
  type FlightPhase,
  type PhaseDetectorOptions,
  type PhaseTransition,
  type PhaseTransitionReason,
} from './flight/phases.js';
export {
  LandingTracker,
  TouchdownTracker,
  type LandingPreview,
  type LandingTrackerOptions,
  type TouchdownEvent,
  type TouchdownKind,
  type TouchdownTrackerOptions,
} from './flight/touchdown.js';
export {
  AdaptiveSampler,
  decimateSamples,
  type AdaptiveSamplerOptions,
  type SamplerDecision,
} from './flight/adaptive-sampler.js';
export { toFlightEvent, toTrackPoint, normalizeHeading } from './flight/build.js';
export { FlightAnalysis, classifyPhase } from './flight/analysis.js';
export {
  FlightRecorder,
  type FlightEndedInfo,
  type FlightRecorderEvents,
  type FlightRecorderOptions,
  type FlightStartedInfo,
  type RecorderState,
} from './flight/recorder.js';

export type {
  OutboxBuffer,
  OutboxCounts,
  OutboxEventRecord,
  OutboxFlight,
  OutboxFlightStatus,
  OutboxPointRecord,
  OutboxPruneSummary,
  PointQualityUpdate,
} from './buffer/types.js';
export { MemoryOutboxBuffer } from './buffer/memory-buffer.js';
export { SqliteOutboxBuffer } from './buffer/sqlite-buffer.js';

export {
  AIRCRAFT_DB_VERSION,
  ATC_MODEL_TO_ICAO,
  getAircraftDictionary,
  resolveAircraftIcao,
  setAircraftDictionary,
  UNKNOWN_AIRCRAFT_ICAO,
  type AircraftIcaoSource,
  type ResolvedAircraftIcao,
} from './flight/aircraft-icao.js';
export {
  buildAircraftDictionary,
  DEFAULT_AIRCRAFT_DICT_TIMEOUT_MS,
  DEFAULT_AIRCRAFT_DICT_URL,
  loadAircraftDictionary,
  type AircraftDictionaryLoadResult,
  type LoadAircraftDictionaryOptions,
} from './flight/aircraft-dictionary.js';
export {
  createAircraftCfgIndex,
  defaultIcaoTypeDesignatorLookup,
  discoverCommunityRoots,
  getDefaultAircraftCfgIndex,
  matchAircraftCfgEntry,
  parseAircraftCfg,
  toAircraftCfgFields,
  type AircraftCfgEntry,
  type AircraftCfgFields,
  type AircraftCfgIndex,
  type AircraftCfgIndexOptions,
  type AircraftCfgQuery,
  type AircraftCfgVirtualFs,
  type IcaoTypeDesignatorLookup,
} from './flight/aircraft-config.js';

export {
  backoffDelayMs,
  FetchHttpClient,
  isOkStatus,
  isRetryableStatus,
  parseRetryAfterMs,
  type BackoffOptions,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from './sync/http.js';
export {
  FileTokenStore,
  MemoryTokenStore,
  type StoredTokens,
  type TokenStore,
} from './sync/token-store.js';
export { DeviceAuthClient, DeviceAuthError, type DeviceAuthOptions } from './sync/device-auth.js';
export {
  DEFAULT_SYNC_MAX_ATTEMPTS,
  FlightUploader,
  MachineMismatchError,
  NotAuthorizedError,
  SyncError,
  pickClientAggregates,
  type FlightUploaderOptions,
  type FlushSummary,
  type UploadedLandingScore,
} from './sync/uploader.js';
export {
  TOUCHDOWN_PREVIEW_TIMEOUT_MS,
  PreviewAbortedError,
  PreviewUnavailableError,
  TouchdownPreviewClient,
  type TouchdownPreviewClientOptions,
} from './sync/touchdown-preview.js';
export {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_FAILURE_WARN_THRESHOLD,
  HEARTBEAT_TIMEOUT_MS,
  HeartbeatClient,
  HeartbeatError,
  HeartbeatScheduler,
  type HeartbeatClientOptions,
  type HeartbeatSchedulerOptions,
} from './sync/heartbeat.js';
export {
  OutboxSyncer,
  pendingTotal,
  type OutboxSyncResult,
  type OutboxSyncerOptions,
  type OutboxUploader,
} from './sync/outbox-syncer.js';

export {
  AgentRuntime,
  type AgentRuntimeDeps,
  type CloseableOutboxBuffer,
  type RuntimeAuth,
  type RuntimeHeartbeat,
  type RuntimePreviewClient,
  type RuntimeRecorder,
  type RuntimeSimAdapter,
  type RuntimeSyncer,
  type RuntimeUploader,
  type ScoreSource,
} from './cli/runtime.js';
export {
  bootstrapAgent,
  bootstrapOutboxSync,
  type BootstrapAgentOptions,
  type BootstrapAuth,
  type BootstrappedAgent,
  type BootstrappedOutboxSync,
  type SyncDependencies,
} from './host/bootstrap.js';
export {
  runManualSync,
  type ManualSyncOptions,
  type ManualSyncOutcome,
} from './cli/manual-sync.js';
export {
  ConfigError,
  loadAgentConfig,
  type AgentConfig,
  type AgentLogLevel,
  type LoadAgentConfigOptions,
} from './cli/config.js';
export {
  createConsoleLogger,
  isLogLevel,
  parseLogLevel,
  redactRecord,
  type ConsoleLoggerOptions,
  type Logger as AgentLogger,
  type LogLevel,
} from './cli/logger.js';

export { fixedClock, systemClock, type Clock } from './util/clock.js';
export { seededUuidGenerator, uuidGenerator, type IdGenerator } from './util/id.js';
export { TypedEmitter } from './util/emitter.js';
