/**
 * simvar-probe.mjs — read-only live probe: какие SimVars принимает живой MSFS 2024.
 *
 * Зачем: SimConnect молча отклоняет неизвестное имя переменной, присылая
 * исключение `NAME_UNRECOGNIZED` с `sendId` AddToDataDefinition-пакета. Этот probe
 * регистрирует список кандидатов `(name, unit, type)` ПО ОДНОМУ и печатает для
 * каждого, принят он симом или отвергнут (по `sendId` — 0-based id пакета, как
 * его возвращает `addToDataDefinition`; пакет `_open` = sendId 0).
 *
 * БЕЗОПАСНОСТЬ (hard rule): probe строго read-only — только `addToDataDefinition`
 * + `requestDataOnSimObject` (чтение). Никаких write/pause/set-операций, состояние
 * сима и активного полёта не меняется. Дополнительный SimConnect-клиент безопасен
 * и не трогает уже запущенный клиент Flare.
 *
 * Запуск (после `pnpm --filter @flightlog/agent build`):
 *   pnpm --filter @flightlog/agent simvar:probe                 # таблица кандидатов (engines + 9 mode)
 *   pnpm --filter @flightlog/agent simvar:probe -- --groups all # весь runtime-набор: except-но 0 (1380 Б)
 *   pnpm --filter @flightlog/agent simvar:probe -- --groups engines
 *   pnpm --filter @flightlog/agent simvar:probe -- --groups all --include-unverified
 *                                                               # 90 полей / 1380 Б (флаг — no-op с 2026-10-20)
 *   pnpm --filter @flightlog/agent simvar:probe -- --values     # дамп ЗНАЧЕНИЙ engine-кандидатов
 *
 * `--groups <csv|all>`: вместо кандидатов регистрирует базу + FOQA-группы из
 * `buildSimVarDefinition` (override, как `FLIGHTLOG_FOQA_SIMVARS`) и проверяет,
 * что нет ни одного `NAME_UNRECOGNIZED` и фактический размер буфера == ожидаемому.
 * `--values`: дамп фактических значений engine-кандидатов (температура/топливный
 * расход по индексам двигателей + N1/ambient как sanity). Каждый кандидат
 * регистрируется в СВОЁМ data definition, чтобы отвергнутый SimVar не сдвигал
 * чтение остальных; для каждого печатаются accepted, value и verdict.
 * `SIMVAR_PROBE_WAIT_MS` (default 2500; для `--values` — 4000): сколько ждать
 * исключений/сэмплов.
 */
import {
  buildSimVarDefinition,
  expectedSimVarLayoutSize,
  FOQA_GROUP_ORDER,
} from '../dist/sim/node-simconnect-adapter.js';
import {
  open,
  Protocol,
  SimConnectConstants,
  SimConnectDataType,
  SimConnectPeriod,
} from 'node-simconnect';

const DATA_DEFINITION_ID = 1;
const DATA_REQUEST_ID = 1;
const WAIT_MS = Number.parseInt(process.env.SIMVAR_PROBE_WAIT_MS ?? '2500', 10);
const CLIENT_NAME = 'Flare SimVar Probe (read-only)';

const DATA_TYPE = {
  float64: SimConnectDataType.FLOAT64,
  int32: SimConnectDataType.INT32,
  string256: SimConnectDataType.STRING256,
};

/**
 * Кандидаты: 4 suspects (EGT), unit-vs-name дискриминатор, replacement-кандидаты
 * для EGT и все остальные имена `engines`-группы.
 */
function candidateEntries() {
  const egtSuspects = [1, 2, 3, 4].map((i) => ({
    label: `egt_${i} (suspect)`,
    name: `TURB ENG EXHAUST GAS TEMPERATURE:${i}`,
    unit: 'celsius',
    type: 'float64',
  }));

  return [
    // Контроли: заведомо рабочие имена/units (base + engine).
    { label: 'control: AMBIENT TEMPERATURE', name: 'AMBIENT TEMPERATURE', unit: 'celsius', type: 'float64' },
    { label: 'control: TURB ENG N1:1 (percent)', name: 'TURB ENG N1:1', unit: 'percent', type: 'float64' },
    // unit-vs-name дискриминатор: то же имя, но unit celsius.
    { label: 'discriminator: TURB ENG N1:1 (celsius)', name: 'TURB ENG N1:1', unit: 'celsius', type: 'float64' },
    // 4 suspects.
    ...egtSuspects,
    // Replacement-кандидаты для EGT.
    { label: 'replacement: TURB ENG EGT:1', name: 'TURB ENG EGT:1', unit: 'celsius', type: 'float64' },
    { label: 'replacement: EXHAUST GAS TEMPERATURE:1', name: 'EXHAUST GAS TEMPERATURE:1', unit: 'celsius', type: 'float64' },
    { label: 'replacement: TURB ENG EXHAUST GAS TEMPERATURE:1 (Celsius)', name: 'TURB ENG EXHAUST GAS TEMPERATURE:1', unit: 'Celsius', type: 'float64' },
    { label: 'replacement: TURB ENG ITT:1', name: 'TURB ENG ITT:1', unit: 'celsius', type: 'float64' },
    { label: 'replacement: TURB ENG ITT:2', name: 'TURB ENG ITT:2', unit: 'celsius', type: 'float64' },
    { label: 'replacement: TURB ENG ITT:3', name: 'TURB ENG ITT:3', unit: 'celsius', type: 'float64' },
    { label: 'replacement: TURB ENG ITT:4', name: 'TURB ENG ITT:4', unit: 'celsius', type: 'float64' },
    { label: 'replacement (turb-eng control): TURB ENG OIL TEMPERATURE:1', name: 'TURB ENG OIL TEMPERATURE:1', unit: 'celsius', type: 'float64' },
    // Остальные имена engines-группы.
    { label: 'engines: TURB ENG N1:2', name: 'TURB ENG N1:2', unit: 'percent', type: 'float64' },
    { label: 'engines: TURB ENG N1:3', name: 'TURB ENG N1:3', unit: 'percent', type: 'float64' },
    { label: 'engines: TURB ENG N1:4', name: 'TURB ENG N1:4', unit: 'percent', type: 'float64' },
    { label: 'engines: TURB ENG FUEL FLOW PPH:1', name: 'TURB ENG FUEL FLOW PPH:1', unit: 'pph', type: 'float64' },
    { label: 'engines: TURB ENG FUEL FLOW PPH:2', name: 'TURB ENG FUEL FLOW PPH:2', unit: 'pph', type: 'float64' },
    { label: 'engines: TURB ENG FUEL FLOW PPH:3', name: 'TURB ENG FUEL FLOW PPH:3', unit: 'pph', type: 'float64' },
    { label: 'engines: TURB ENG FUEL FLOW PPH:4', name: 'TURB ENG FUEL FLOW PPH:4', unit: 'pph', type: 'float64' },
    { label: 'engines: ELEVATOR POSITION', name: 'ELEVATOR POSITION', unit: 'percent', type: 'float64' },
    { label: 'engines: AILERON POSITION', name: 'AILERON POSITION', unit: 'percent', type: 'float64' },
    { label: 'engines: RUDDER POSITION', name: 'RUDDER POSITION', unit: 'percent', type: 'float64' },
    { label: 'engines: BRAKE LEFT POSITION', name: 'BRAKE LEFT POSITION', unit: 'percent', type: 'float64' },
    { label: 'engines: BRAKE RIGHT POSITION', name: 'BRAKE RIGHT POSITION', unit: 'percent', type: 'float64' },
    // ENGINE-MODE: все 9 имён; verified live on MSFS 2024 (2026-10-20).
    ...[1, 2, 3, 4].map((engine) => ({
      label: `engine mode: GENERAL ENG THROTTLE LEVER POSITION:${engine}`,
      name: `GENERAL ENG THROTTLE LEVER POSITION:${engine}`,
      unit: 'percent',
      type: 'float64',
    })),
    ...[1, 2, 3, 4].map((engine) => ({
      label: `engine mode: TURB ENG REVERSE NOZZLE PERCENT:${engine}`,
      name: `TURB ENG REVERSE NOZZLE PERCENT:${engine}`,
      unit: 'percent',
      type: 'float64',
    })),
    {
      label: 'engine mode: GENERAL ENG REVERSE THRUST ENGAGED',
      name: 'GENERAL ENG REVERSE THRUST ENGAGED',
      unit: 'Bool',
      type: 'int32',
    },
  ];
}

/**
 * Кандидаты для дампа значений (`--values`): температура и топливный расход
 * турбинных двигателей по индексам + sanity-контроли (N1, ambient).
 *
 * `engine` — индекс SimVar-суффикса (`:n`), не позиция в массиве.
 * Каждый кандидат тестируется на живом симе read-only; значение и accepted
 * печатаются в таблице. `AMBIENT TEMPERATURE` нужен для verdict `ambient`.
 */
function engineValueCandidates() {
  const entries = [];

  const tempTemplates = [
    ['ITT', 'TURB ENG ITT', ['celsius', 'rankine', 'fahrenheit', 'kelvin']],
    ['EGT (turb-eng)', 'TURB ENG EGT', ['celsius']],
    ['EGT (bare)', 'EXHAUST GAS TEMPERATURE', ['celsius']],
    [
      'EGT (turb-eng, accepted-on-probe?)',
      'TURB ENG EXHAUST GAS TEMPERATURE',
      ['celsius', 'rankine'],
    ],
    ['OIL', 'TURB ENG OIL TEMPERATURE', ['celsius']],
    ['CYL HEAD (control)', 'TURB ENG CYLINDER HEAD TEMPERATURE', ['celsius']],
    ['CYL HEAD bare (control)', 'CYLINDER HEAD TEMPERATURE', ['celsius']],
  ];
  for (const [group, name, units] of tempTemplates) {
    for (const unit of units) {
      for (const engine of [1, 2, 3]) {
        entries.push({ label: `${group} eng${engine}`, name: `${name}:${engine}`, unit, type: 'float64', engine, kind: 'temperature' });
      }
    }
  }

  const flowTemplates = [
    ['FF PPH', 'TURB ENG FUEL FLOW PPH', ['pph', 'gph', 'pounds per hour', 'kg/hour']],
    ['FF GPH', 'TURB ENG FUEL FLOW GPH', ['gph', 'pph', 'gallons per hour']],
    ['FF SSL', 'TURB ENG FUEL FLOW PPH SSL', ['pph']],
    ['ENG FF PPH', 'ENG FUEL FLOW PPH', ['pph']],
    ['ENG FF GPH', 'ENG FUEL FLOW GPH', ['gph']],
    ['GENERAL FF', 'GENERAL ENG FUEL FLOW', ['pph', 'gph']],
    ['FF percent', 'TURB ENG FUEL FLOW PPH', ['percent']],
  ];
  for (const [group, name, units] of flowTemplates) {
    for (const unit of units) {
      for (const engine of [1, 2, 3]) {
        entries.push({ label: `${group} eng${engine}`, name: `${name}:${engine}`, unit, type: 'float64', engine, kind: 'fuel_flow' });
      }
    }
  }

  // Sanity-контроли: N1 (percent) должен быть ~98 % в крейсе FL370.
  for (const engine of [1, 2, 3]) {
    entries.push({ label: `N1 eng${engine}`, name: `TURB ENG N1:${engine}`, unit: 'percent', type: 'float64', engine, kind: 'n1' });
  }
  entries.push({ label: 'AMBIENT TEMPERATURE', name: 'AMBIENT TEMPERATURE', unit: 'celsius', type: 'float64', engine: null, kind: 'ambient' });
  entries.push({ label: 'FUEL TOTAL QUANTITY', name: 'FUEL TOTAL QUANTITY', unit: 'gallons', type: 'float64', engine: null, kind: 'fuel_qty' });

  return entries;
}

function parseGroups(value) {
  if (!value) return null;
  const tokens = value
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.includes('all')) return [...FOQA_GROUP_ORDER];
  return FOQA_GROUP_ORDER.filter((group) => tokens.includes(group));
}

function definitionEntries(groups, withUnverified = false) {
  return buildSimVarDefinition(groups, { includeUnverified: withUnverified }).map((def, index) => ({
    label: `#${index} ${def.field}`,
    name: def.name,
    unit: def.unit,
    type: def.type,
  }));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pad(value, width) {
  return String(value ?? '').padEnd(width);
}

/**
 * Регистрирует `entries` в одном data definition, собирает исключения по sendId
 * и (в групповом режиме) фактический размер буфера первого сэмпла.
 */
async function probe(entries, { checkBuffer }) {
  const expectedBytes = checkBuffer
    ? expectedSimVarLayoutSize(entries.map((entry) => entry))
    : null;

  const { recvOpen, handle } = await open(CLIENT_NAME, Protocol.SunRise);
  console.log(
    `[probe] connected: ${recvOpen.applicationName} ` +
      `${recvOpen.applicationVersionMajor}.${recvOpen.applicationVersionMinor} ` +
      `(SimConnect ${recvOpen.simConnectVersionMajor}.${recvOpen.simConnectVersionMinor})`,
  );

  const sendIdToEntry = new Map();
  const exceptions = [];
  let actualBytes = null;

  handle.on('exception', (exception) => {
    exceptions.push({
      sendId: exception.sendId,
      exception: exception.exception,
      exceptionName: exception.exceptionName,
      index: exception.index,
    });
  });

  handle.on('simObjectData', (recv) => {
    if (recv.requestID !== DATA_REQUEST_ID) return;
    if (actualBytes === null && typeof recv.data.remaining === 'function') {
      actualBytes = recv.data.remaining();
    }
  });

  handle.on('error', (error) => console.error('[probe] connection error:', error?.message ?? error));

  for (const entry of entries) {
    const sendId = handle.addToDataDefinition(
      DATA_DEFINITION_ID,
      entry.name,
      entry.unit,
      DATA_TYPE[entry.type] ?? SimConnectDataType.FLOAT64,
    );
    sendIdToEntry.set(sendId, entry);
  }

  handle.requestDataOnSimObject(
    DATA_REQUEST_ID,
    DATA_DEFINITION_ID,
    SimConnectConstants.OBJECT_ID_USER,
    SimConnectPeriod.SIM_FRAME,
  );

  await wait(WAIT_MS);
  handle.close();

  const rejectedBySendId = new Map();
  for (const exception of exceptions) {
    rejectedBySendId.set(exception.sendId, exception);
  }

  const rows = [];
  for (const [sendId, entry] of sendIdToEntry) {
    const exception = rejectedBySendId.get(sendId);
    rows.push({
      entry,
      sendId,
      rejected: Boolean(exception),
      exceptionName: exception?.exceptionName ?? null,
    });
  }
  rows.sort((a, b) => a.sendId - b.sendId);

  return { rows, exceptions, actualBytes, expectedBytes };
}

function printTable(rows) {
  console.log('');
  console.log(
    `${pad('verdict', 9)}  ${pad('sendId', 6)}  ${pad('unit', 10)}  ${pad('type', 9)}  name  [label]`,
  );
  for (const row of rows) {
    const verdict = row.rejected ? 'REJECT' : 'accept';
    const suffix = row.rejected ? `  <- ${row.exceptionName}` : '';
    console.log(
      `${pad(verdict, 9)}  ${pad(row.sendId, 6)}  ${pad(row.entry.unit ?? '-', 10)}  ` +
        `${pad(row.entry.type, 9)}  ${row.entry.name}  [${row.entry.label}]${suffix}`,
    );
  }
}

function summarize(rows) {
  const rejected = rows.filter((row) => row.rejected);
  const accepted = rows.length - rejected.length;
  console.log('');
  console.log(`SUMMARY: ${accepted} accepted, ${rejected.length} rejected (of ${rows.length})`);
  for (const row of rejected) {
    console.log(
      `  REJECTED: '${row.entry.name}' (${row.entry.unit ?? '-'}, sendId ${row.sendId}) ` +
        `— ${row.exceptionName ?? 'unknown'}`,
    );
  }
  return { accepted, rejected };
}

/**
 * Регистрирует каждый кандидат в СВОЁМ data definition + request (read-only) и
 * собирает фактическое значение. Изоляция по definition-id нужна, потому что
 * отвергнутый SimVar выпадает из layout и сдвигает чтение всех последующих
 * полей общего definition (см. layout-mismatch инцидент).
 */
async function probeValues(entries) {
  const { recvOpen, handle } = await open(CLIENT_NAME, Protocol.SunRise);
  console.log(
    `[probe] connected: ${recvOpen.applicationName} ` +
      `${recvOpen.applicationVersionMajor}.${recvOpen.applicationVersionMinor} ` +
      `(SimConnect ${recvOpen.simConnectVersionMajor}.${recvOpen.simConnectVersionMinor})`,
  );

  const byDefId = new Map();
  const sendIdToEntry = new Map();
  const values = new Map();
  const exceptions = [];
  let frames = 0;

  handle.on('exception', (exception) => {
    exceptions.push({
      sendId: exception.sendId,
      exception: exception.exception,
      exceptionName: exception.exceptionName,
      index: exception.index,
    });
  });

  handle.on('simObjectData', (recv) => {
    const entry = byDefId.get(recv.defineID);
    if (!entry) return;
    frames += 1;
    let value;
    let remaining = null;
    try {
      if (typeof recv.data.remaining === 'function') remaining = recv.data.remaining();
      if (entry.type === 'float64') value = recv.data.readFloat64();
      else if (entry.type === 'int32') value = recv.data.readInt32();
      else value = recv.data.readString256();
    } catch (error) {
      value = `ERR:${error?.message ?? error}`;
    }
    values.set(recv.defineID, { value, remaining });
  });

  handle.on('error', (error) => console.error('[probe] connection error:', error?.message ?? error));

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const defId = index + 1; // dataDefinitionId, 1-based
    byDefId.set(defId, entry);
    const sendId = handle.addToDataDefinition(
      defId,
      entry.name,
      entry.unit,
      DATA_TYPE[entry.type] ?? SimConnectDataType.FLOAT64,
    );
    sendIdToEntry.set(sendId, entry);
  }
  for (let index = 0; index < entries.length; index += 1) {
    handle.requestDataOnSimObject(
      index + 1,
      index + 1,
      SimConnectConstants.OBJECT_ID_USER,
      SimConnectPeriod.SIM_FRAME,
    );
  }

  await wait(WAIT_MS);
  handle.close();

  const rejectedBySendId = new Map();
  for (const exception of exceptions) rejectedBySendId.set(exception.sendId, exception);

  const rows = entries.map((entry, index) => {
    const defId = index + 1;
    const addSendId = [...sendIdToEntry.entries()].find(([, e]) => e === entry)?.[0];
    const exception = addSendId !== undefined ? rejectedBySendId.get(addSendId) : undefined;
    const sample = values.get(defId) ?? null;
    return {
      entry,
      sendId: addSendId ?? null,
      rejected: Boolean(exception),
      exceptionName: exception?.exceptionName ?? null,
      value: sample?.value ?? null,
      remaining: sample?.remaining ?? null,
    };
  });

  return { rows, exceptions, frames };
}

function formatValue(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (value === 0) return '0';
    if (Math.abs(value) < 1e-3 || Math.abs(value) >= 1e6) return value.toExponential(6);
    return value.toPrecision(8);
  }
  return value === null || value === undefined ? '-' : String(value);
}

function classifyValue(row, ambient) {
  if (row.rejected) return 'reject';
  const value = row.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'no-data';
  if (row.entry.kind === 'temperature') {
    if (value <= -200) return 'sentinel';
    if (ambient !== null && Math.abs(value - ambient) < 1) return 'ambient';
    if (value < 0) return 'implausible';
    return 'plausible';
  }
  if (row.entry.kind === 'fuel_flow') {
    return Math.abs(value) < 0.5 ? 'zero' : 'plausible';
  }
  return 'ref';
}

function printValuesTable(rows) {
  const ambientRow = rows.find((row) => row.entry.kind === 'ambient');
  const ambient = typeof ambientRow?.value === 'number' ? ambientRow.value : null;

  console.log('');
  console.log(
    `${pad('verdict', 12)}  ${pad('engine', 6)}  ${pad('unit', 16)}  ${pad('accepted', 8)}  ` +
      `${pad('value', 22)}  ${pad('bytes', 5)}  name  [label]`,
  );
  for (const row of rows) {
    const accepted = row.rejected ? 'REJECT' : 'accept';
    const kind = row.entry.kind;
    const verdict =
      kind === 'temperature' || kind === 'fuel_flow'
        ? classifyValue(row, ambient)
        : kind === 'n1'
          ? 'ref N1'
          : kind === 'ambient'
            ? 'ref ambient'
            : 'ref';
    const suffix = row.rejected ? ` <- ${row.exceptionName}` : '';
    console.log(
      `${pad(verdict, 12)}  ${pad(row.entry.engine ?? '-', 6)}  ${pad(row.entry.unit ?? '-', 16)}  ` +
        `${pad(accepted, 8)}  ${pad(formatValue(row.value), 22)}  ${pad(row.remaining ?? '-', 5)}  ` +
        `${row.entry.name}  [${row.entry.label}]${suffix}`,
    );
  }
}

const args = process.argv.slice(2);
const valuesMode = args.includes('--values');
const includeUnverified = args.includes('--include-unverified');
const groupsFlagIndex = args.indexOf('--groups');
const groupsValue = groupsFlagIndex >= 0 ? args[groupsFlagIndex + 1] : null;
const groups = parseGroups(groupsValue);
const checkBuffer = groups !== null;

if (valuesMode) {
  const entries = engineValueCandidates();
  console.log(`[probe] VALUES mode: ${entries.length} candidates, one data definition each (read-only)`);
  let valueResult;
  try {
    valueResult = await probeValues(entries);
  } catch (error) {
    console.error('[probe] connect/registration failed:', error);
    process.exit(2);
  }
  printValuesTable(valueResult.rows);
  console.log('');
  console.log(`[probe] frames received: ${valueResult.frames}, exceptions: ${valueResult.exceptions.length}`);
  for (const row of valueResult.rows.filter((r) => r.rejected)) {
    console.log(`  REJECTED: '${row.entry.name}' (${row.entry.unit ?? '-'}) — ${row.exceptionName}`);
  }
  process.exit(0);
}

const entries = checkBuffer
  ? definitionEntries(groups, includeUnverified)
  : candidateEntries();

if (checkBuffer) {
  console.log(
    `[probe] runtime definition: base + FOQA groups ` +
      `[${groups.length > 0 ? groups.join(', ') : 'none'}]` +
      `${includeUnverified ? ' + include-unverified (no-op)' : ''} → ${entries.length} fields`,
  );
} else {
  console.log(`[probe] candidate table: ${entries.length} entries (read-only)`);
}

let result;
try {
  result = await probe(entries, { checkBuffer });
} catch (error) {
  console.error('[probe] connect/registration failed:', error);
  process.exit(2);
}

printTable(result.rows);
const { rejected } = summarize(result.rows);

if (result.exceptions.length > 0) {
  console.log('');
  console.log(`EXCEPTIONS (${result.exceptions.length}):`);
  for (const exception of result.exceptions) {
    const entry = result.rows.find((row) => row.sendId === exception.sendId)?.entry;
    console.log(
      `  sendId ${exception.sendId} index ${exception.index} ` +
        `${exception.exceptionName} → ${entry ? `'${entry.name}' (${entry.unit ?? '-'})` : 'unknown field'}`,
    );
  }
}

if (checkBuffer) {
  console.log('');
  console.log(`EXPECTED PAYLOAD: ${result.expectedBytes} bytes`);
  console.log(`OBSERVED PAYLOAD: ${result.actualBytes ?? 'n/a'} bytes`);
  const mismatch = result.actualBytes !== null && result.actualBytes !== result.expectedBytes;
  if (mismatch) {
    console.log(
      `MISMATCH: deficit ${result.expectedBytes - result.actualBytes} bytes ` +
        `(likely ${(result.expectedBytes - result.actualBytes) / 8} rejected float64)`,
    );
  }
  const clean = rejected.length === 0 && result.actualBytes === result.expectedBytes;
  console.log(clean ? 'RESULT: CLEAN (no NAME_UNRECOGNIZED, no layout mismatch)' : 'RESULT: DIRTY');
  process.exit(clean ? 0 : 1);
}

process.exit(rejected.length > 0 ? 0 : 0);
