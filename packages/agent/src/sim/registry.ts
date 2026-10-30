import {
  DEFAULT_PROTOCOL,
  NodeSimConnectAdapter,
  probeSimConnectAvailability,
  type SimConnectAdapterLogger,
  type SimConnectProtocolName,
} from './node-simconnect-adapter.js';
import { createXPlaneSimSource, probeXPlaneAvailable } from './xplane/index.js';
import {
  DEFAULT_SIM_SOURCE_ID,
  DEFAULT_SIM_SOURCE_PREFERENCE,
  KNOWN_SIM_SOURCE_PREFERENCES,
  SIM_SOURCE_ENV,
  type SimSource,
  type SimSourceId,
  type SimSourcePreference,
} from './source.js';

/** Логгер, достаточный источнику (совместим с `Logger` из `cli/logger`). */
export type SimSourceLogger = SimConnectAdapterLogger;

/** Контекст создания источника (наполняется composition root'ом). */
export interface SimSourceCreateContext {
  logger?: SimSourceLogger;
  maxSampleHz?: number;
  protocol?: SimConnectProtocolName;
}

/** Фабрика одной реализации `SimSource` (по одной на сим). */
export interface SimSourceFactory {
  readonly id: SimSourceId;
  /** Человекочитаемая метка для логов/диагностики. */
  readonly label: string;
  create(context: SimSourceCreateContext): SimSource;
  /**
   * Дешёвая read-only проба «сим запущен» для `auto`-дискавери (ADR-0023 §3).
   * Отсутствие пробы трактуется по-разному: дефолтный источник считается
   * доступным (консервативно), прочие — нет (см. `discoverSimSourceId`).
   */
  probe?(context: SimSourceCreateContext): Promise<boolean>;
}

const registry = new Map<SimSourceId, SimSourceFactory>();

/** Регистрирует (или перезаписывает) реализацию источника. */
export function registerSimSource(factory: SimSourceFactory): void {
  registry.set(factory.id, factory);
}

/** Снимает регистрацию (тесты/диагностика). */
export function unregisterSimSource(id: SimSourceId): void {
  registry.delete(id);
}

/** Зарегистрированные источники в порядке регистрации. */
export function listRegisteredSimSources(): SimSourceId[] {
  return [...registry.keys()];
}

// ---------------------------------------------------------------------------
// Регистрация встроенных источников.
//
// MSFS 2024 — единственный источник v1 (ADR-0023: XP — аддитивная ветка).
// Регистрируется при импорте модуля, поэтому composition root не может «забыть»
// его зарегистрировать; `registerSimSource` идемпотентен (Map.set).
// ---------------------------------------------------------------------------
registerSimSource({
  id: 'msfs2024',
  label: 'MSFS 2024 (SimConnect, read-only)',
  create: (context) =>
    new NodeSimConnectAdapter({
      protocol: context.protocol ?? DEFAULT_PROTOCOL,
      maxSampleHz: context.maxSampleHz,
      logger: context.logger,
    }),
  probe: () => probeSimConnectAvailability(),
});

// ---------------------------------------------------------------------------
// X-Plane 12 (ADR-0023, аддитивная ветка). Регистрируется рядом с MSFS; `auto`
// по-прежнему предпочитает MSFS при «оба запущены» (Решение 3), а при
// единственном живом XP выбирает его (дискавери, `discoverSimSourceId`).
// MSFS-путь не затрагивается: проба MSFS выполняется только если подтверждён XP.
// ---------------------------------------------------------------------------
export function registerXPlaneSimSource(): void {
  registerSimSource({
    id: 'xplane12',
    label: 'X-Plane 12 (Web API/RREF, read-only)',
    create: (context) => createXPlaneSimSource(context),
    probe: () => probeXPlaneAvailable(),
  });
}

registerXPlaneSimSource();

export interface ParsedSimSourcePreference {
  preference: SimSourcePreference;
  /** Неизвестное значение env (для warning'а); `null`, если распознано/пусто. */
  unknown: string | null;
}

/**
 * Разбирает значение `AGENT_SIM_SOURCE`. Пустое/`undefined` → дефолт `auto`.
 * Неизвестное значение не бросает: возвращается `preference = default` + `unknown`
 * (warning эмитит `resolveSimSourceId`).
 */
export function parseSimSourcePreference(
  raw: string | null | undefined,
): ParsedSimSourcePreference {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { preference: DEFAULT_SIM_SOURCE_PREFERENCE, unknown: null };
  }
  const value = raw.trim().toLowerCase();
  if (value === 'auto' || value === 'msfs2024' || value === 'xplane12') {
    return { preference: value, unknown: null };
  }
  return { preference: DEFAULT_SIM_SOURCE_PREFERENCE, unknown: raw.trim() };
}

export interface ResolveSimSourceIdOptions {
  preference?: SimSourcePreference;
  /** Неизвестное значение env (см. `parseSimSourcePreference`). */
  unknown?: string | null;
  /** Доступные источники; по умолчанию — зарегистрированные. */
  available?: readonly SimSourceId[];
  logger?: SimSourceLogger;
}

/**
 * Разрешает id источника по предпочтению (ADR-0023, Решение 3).
 * - `auto` → MSFS (приоритет при «оба запущены»), иначе первый зарегистрированный;
 * - явный id, если он зарегистрирован;
 * - неизвестное значение env или незарегистрированный id → warning + дефолт.
 */
export function resolveSimSourceId(options: ResolveSimSourceIdOptions = {}): SimSourceId {
  const available = options.available ?? listRegisteredSimSources();
  if (available.length === 0) {
    throw new Error('resolveSimSourceId: no SimSource registered');
  }
  const first = available[0];
  if (first === undefined) {
    throw new Error('resolveSimSourceId: no SimSource registered');
  }
  const fallback = available.includes(DEFAULT_SIM_SOURCE_ID) ? DEFAULT_SIM_SOURCE_ID : first;

  const unknown = options.unknown ?? null;
  if (unknown !== null) {
    options.logger?.warn(
      `${SIM_SOURCE_ENV}: unknown value '${unknown}' ` +
        `(known: ${KNOWN_SIM_SOURCE_PREFERENCES.join(', ')}); ` +
        `falling back to '${DEFAULT_SIM_SOURCE_PREFERENCE}' -> '${fallback}'`,
      { source_env: SIM_SOURCE_ENV, requested: unknown, fallback },
    );
    return fallback;
  }

  const preference = options.preference ?? DEFAULT_SIM_SOURCE_PREFERENCE;
  if (preference === 'auto' || available.includes(preference)) {
    return preference === 'auto' ? fallback : preference;
  }

  options.logger?.warn(
    `${SIM_SOURCE_ENV}: source '${preference}' is not registered yet ` +
      `(registered: ${available.join(', ')}); falling back to '${fallback}'`,
    { source_env: SIM_SOURCE_ENV, requested: preference, fallback },
  );
  return fallback;
}

export interface DiscoverSimSourceOptions {
  /** Доступные источники; по умолчанию — зарегистрированные. */
  available?: readonly SimSourceId[];
  context?: SimSourceCreateContext;
  logger?: SimSourceLogger;
  /** Инъекция проб (тесты); по умолчанию — `factory.probe` с консервативным дефолтом. */
  probe?: (id: SimSourceId) => Promise<boolean>;
}

function defaultProbe(id: SimSourceId, context: SimSourceCreateContext): Promise<boolean> {
  const factory = registry.get(id);
  if (!factory || !factory.probe) {
    // Нет пробы: дефолтный источник считаем доступным (консервативно), прочие — нет.
    return Promise.resolve(id === DEFAULT_SIM_SOURCE_ID);
  }
  return factory.probe(context);
}

/** Создаёт новый инстанс зарегистрированного источника (re-discovery/switch). */
export function createSimSource(id: SimSourceId, context: SimSourceCreateContext = {}): SimSource {
  const factory = registry.get(id);
  if (!factory) throw new Error(`SimSource '${id}' is not registered`);
  return factory.create(context);
}

/** Дешёвая read-only проба зарегистрированного источника (re-discovery). */
export function probeSimSourceId(
  id: SimSourceId,
  context: SimSourceCreateContext = {},
): Promise<boolean> {
  return defaultProbe(id, context);
}

async function safeProbe(
  probe: (id: SimSourceId) => Promise<boolean>,
  id: SimSourceId,
): Promise<boolean> {
  try {
    return await probe(id);
  } catch {
    return false;
  }
}

/**
 * Runtime-дискавери источника для `auto` (ADR-0023 §3, порядок детерминирован):
 * сначала дешёвая проба не-дефолтных источников (XP), затем — только при её
 * успехе — проба дефолтного (MSFS). «Оба запущены» → дефолт (MSFS) + лог;
 * «только XP» → XP; «только MSFS»/«ничего» → дефолт (без пробы MSFS, что
 * сохраняет поведение MSFS-only пользователя).
 */
export async function discoverSimSourceId(
  options: DiscoverSimSourceOptions = {},
): Promise<SimSourceId> {
  const available = options.available ?? listRegisteredSimSources();
  if (available.length === 0) {
    throw new Error('discoverSimSourceId: no SimSource registered');
  }
  const first = available[0];
  if (first === undefined) {
    throw new Error('discoverSimSourceId: no SimSource registered');
  }
  const defaultId = available.includes(DEFAULT_SIM_SOURCE_ID) ? DEFAULT_SIM_SOURCE_ID : first;
  const context = options.context ?? {};
  const probe = options.probe ?? ((id: SimSourceId) => defaultProbe(id, context));

  for (const id of available.filter((candidate) => candidate !== defaultId)) {
    if (!(await safeProbe(probe, id))) continue;
    if (await safeProbe(probe, defaultId)) {
      options.logger?.info(
        'simulator discovery: both simulators detected; preferring the default source',
        { chosen: defaultId, also_running: id },
      );
      return defaultId;
    }
    options.logger?.info('simulator discovery: selected non-default source', { chosen: id });
    return id;
  }
  return defaultId;
}

export interface SimSourceResolverOptions {
  /** Прямое значение env; при `undefined` читается `process.env[AGENT_SIM_SOURCE]`. */
  envRaw?: string | null;
  /** Явное предпочтение (перекрывает env). */
  preference?: SimSourcePreference;
  logger?: SimSourceLogger;
  /** Контекст создания источника. */
  context?: SimSourceCreateContext;
}

/** Резолвер ровно одного источника на рантайм (инвариант «один рекордер — один сим»). */
export interface SimSourceResolver {
  /** Возвращает единственный общий инстанс, создавая его при первом вызове (без дискавери). */
  resolve(): SimSource;
  /**
   * То же, но для `auto` выполняет runtime-дискавери (ADR-0023 §3): выбирает
   * реально запущенный сим. Явное предпочтение/неизвестный env → статический путь.
   * Ошибка дискавери не фатальна — фолбэк на статический `resolve()`.
   */
  resolveAsync(): Promise<SimSource>;
}

/**
 * Создаёт резолвер источника. Инстанс создаётся **один раз** (лениво) и
 * переиспользуется при повторных `resolve()`/`resolveAsync()`, поэтому второй
 * адаптер к другому симу структурно невозможен в рамках одного рантайма/bootstrap.
 */
export function createSimSourceResolver(options: SimSourceResolverOptions = {}): SimSourceResolver {
  const context = options.context ?? {};
  const logger = options.logger ?? context.logger;
  let instance: SimSource | null = null;

  const resolvePreference = (): ParsedSimSourcePreference => {
    const rawEnv =
      options.envRaw !== undefined ? options.envRaw : (process.env[SIM_SOURCE_ENV] ?? null);
    return options.preference
      ? { preference: options.preference, unknown: null }
      : parseSimSourcePreference(rawEnv);
  };

  const createFor = (id: SimSourceId): SimSource => createSimSource(id, context);

  const resolveSync = (): SimSource => {
    if (instance !== null) return instance;
    const parsed = resolvePreference();
    instance = createFor(resolveSimSourceId({ ...parsed, logger }));
    return instance;
  };

  return {
    resolve(): SimSource {
      return resolveSync();
    },
    async resolveAsync(): Promise<SimSource> {
      if (instance !== null) return instance;
      const parsed = resolvePreference();
      if (parsed.unknown !== null || parsed.preference !== 'auto') {
        return resolveSync();
      }
      try {
        const id = await discoverSimSourceId({ logger, context });
        instance = createFor(id);
        return instance;
      } catch (error) {
        logger?.warn('simulator discovery failed; falling back to the default source', {
          error: error instanceof Error ? error.message : String(error),
        });
        return resolveSync();
      }
    },
  };
}
