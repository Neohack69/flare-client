/**
 * simvar-layout.mjs — «на один взгляд»: ожидаемый размер payload SimConnect и
 * смещения полей для набора SimVars (без сима, без SimConnect).
 *
 * Зачем: SimConnect молча отклоняет неизвестный SimVar, из-за чего фактический
 * размер буфера расходится с ожидаемым layout (P0-инцидент 0.3.x: ожидалось
 * 1312 байт, пришло 1308 — один bool/enum SimVar был отвергнут). Скрипт считает
 * ОЖИДАЕМОЕ по `SIMVAR_DEFINITION` (или по кандидатам), чтобы при live-проверке
 * сравнить одно число с one-time логом агента
 * (`SimConnect data layout mismatch: expected X bytes, got Y`).
 *
 * Схема байт: `float64` = 8, `int32` = 4, `string256` = 256 (см. `simVarFieldSize`).
 *
 * Запуск (после `pnpm --filter @flightlog/agent build`):
 *   pnpm --filter @flightlog/agent simvar:layout                       # default → 1380 (all verified)
 *   pnpm --filter @flightlog/agent simvar:layout -- --groups none      # база → 940
 *   pnpm --filter @flightlog/agent simvar:layout -- --groups engines   # engines only → 1144
 *   pnpm --filter @flightlog/agent simvar:layout -- --groups config,ils  # override → 1036
 *   pnpm --filter @flightlog/agent simvar:layout -- --groups all --expect 1380
 *   pnpm --filter @flightlog/agent simvar:layout -- --groups all --include-unverified --expect 1380
 *
 * `--groups <csv|all|none>`: база + FOQA-группы (override, как `FLIGHTLOG_FOQA_SIMVARS`);
 * `--include-unverified` добавляет поля с `verification: 'VERIFY-LIVE'`
 * (сейчас таких нет — engine-mode подтверждены live 2026-10-20).
 * Плейсхолдер `--definition <file.json>`: свой набор вместо базового
 * (массив `{name, unit, type, field?}`), напр. known-good 0.2.5 или Wave-4.
 * `--append <spec>`: JSON-файл (`[{...}]` или `{candidates:[...]}`) ИЛИ список
 * `Имя|unit|type`, разделённый `;`, — добавляется в конец текущего набора.
 * `--expect <bytes>`: жёсткая проверка; при расхождении exit code 1.
 *
 * Read-only: ничего не пишет в сим; только печатает layout.
 */
import { readFileSync } from 'node:fs';

import {
  BASE_SIMVAR_DEFINITION,
  DEFAULT_FOQA_GROUPS,
  FOQA_GROUP_ORDER,
  buildSimVarDefinition,
  expectedSimVarLayoutSize,
  parseFoqaGroups,
  simVarFieldSize,
} from '../dist/sim/node-simconnect-adapter.js';

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** `---` — разделитель, чтобы `--append` можно было задавать несколькими токенами. */
function readCandidates(spec) {
  if (!spec) return [];
  const trimmed = spec.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : (parsed.candidates ?? []);
  }
  if (/\.json$/i.test(trimmed)) {
    const parsed = JSON.parse(readFileSync(trimmed, 'utf8'));
    return Array.isArray(parsed) ? parsed : (parsed.candidates ?? []);
  }
  return trimmed
    .split(';')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const [name, unit, type = 'int32'] = token.split('|').map((part) => part.trim());
      return { name, unit: unit === 'null' ? null : (unit ?? null), type };
    });
}

function loadDefinition(path) {
  if (!path) return [...BASE_SIMVAR_DEFINITION];
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(parsed) ? parsed : (parsed.definition ?? []);
}

const definitionFlag = flagValue('--definition');
const groupsFlag = flagValue('--groups');
const includeUnverified = args.includes('--include-unverified');
const groupSelection =
  groupsFlag !== undefined
    ? parseFoqaGroups(groupsFlag)
    : { groups: [...DEFAULT_FOQA_GROUPS], unknown: [] };

let base;
if (definitionFlag) {
  base = loadDefinition(definitionFlag);
} else {
  base = [...buildSimVarDefinition(groupSelection.groups, { includeUnverified })];
}

if (groupSelection && groupSelection.unknown.length > 0) {
  console.error(`WARN unknown FOQA groups ignored: ${groupSelection.unknown.join(', ')}`);
}

const appended = readCandidates(flagValue('--append'));
const definition = [...base, ...appended];

const pad = (value, width) => String(value).padEnd(width);
const padStart = (value, width) => String(value).padStart(width);

let offset = 0;
let floats = 0;
let ints = 0;
let strings = 0;

console.log(
  `${padStart('#', 3)}  ${padStart('off', 5)}  ${padStart('size', 4)}  ${pad(
    'type',
    9,
  )}  ${pad('unit', 10)}  name`,
);
for (let index = 0; index < definition.length; index += 1) {
  const def = definition[index];
  const size = simVarFieldSize(def.type);
  if (def.type === 'float64') floats += 1;
  else if (def.type === 'int32') ints += 1;
  else strings += 1;
  console.log(
    `${padStart(index, 3)}  ${padStart(offset, 5)}  ${padStart(size, 4)}  ${pad(
      def.type,
      9,
    )}  ${pad(def.unit ?? '-', 10)}  ${def.name}`,
  );
  offset += size;
}

const expected = expectedSimVarLayoutSize(definition);
const baseBytes = expectedSimVarLayoutSize(base);
const delta = expected - baseBytes;

console.log('');
console.log(
  `FIELDS: ${definition.length} (base ${base.length} + appended ${appended.length}) = ` +
    `${floats}xfloat64 + ${ints}xint32 + ${strings}xstring256`,
);
if (appended.length > 0) {
  console.log(`BATCH DELTA: +${delta} bytes (${appended.length} fields)`);
}
console.log(`EXPECTED PAYLOAD: ${expected} bytes`);

if (groupSelection) {
  console.log(
    `ENABLED GROUPS (` +
      `${definitionFlag ? '--definition' : 'FOQA'}): ` +
      `${groupSelection.groups.join(', ') || 'none'}`,
  );
}

const foqaBaseBytes = expectedSimVarLayoutSize(BASE_SIMVAR_DEFINITION);
console.log('');
console.log(
  `FOQA GROUPS (default: ${DEFAULT_FOQA_GROUPS.join(', ')}; env FLIGHTLOG_FOQA_SIMVARS=<csv|all|none>; ` +
    `base ${foqaBaseBytes} B${includeUnverified ? '; include-unverified ON (no-op)' : ''}):`,
);
let cumulative = foqaBaseBytes;
for (const group of FOQA_GROUP_ORDER) {
  const groupDefinition = buildSimVarDefinition([group], { includeUnverified });
  const groupDefs = groupDefinition.slice(BASE_SIMVAR_DEFINITION.length);
  const bytes = expectedSimVarLayoutSize(groupDefs);
  cumulative += bytes;
  console.log(
    `  ${pad(group, 10)} +${padStart(bytes, 4)} B (${padStart(groupDefs.length, 2)} fields) → ${cumulative}`,
  );
}
console.log(
  `  ${pad('all', 10)} +${padStart(cumulative - foqaBaseBytes, 4)} B ` +
    `(${FOQA_GROUP_ORDER.length} groups) → ${cumulative}`,
);

const expectRaw = flagValue('--expect');
if (expectRaw !== undefined) {
  const expect = Number.parseInt(expectRaw, 10);
  if (expected === expect) {
    console.log(`ASSERT --expect ${expect}: OK`);
  } else {
    console.error(`ASSERT --expect ${expect}: FAIL (computed ${expected})`);
    process.exit(1);
  }
}
