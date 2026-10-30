#!/usr/bin/env node
/**
 * xplane-probe.mjs — read-only probe для X-Plane 12 (Stage 0,
 * `docs/architecture/xplane-12-probe-plan.md`).
 *
 * Что делает (ТОЛЬКО чтение — GET + WS subscribe + RREF):
 *   1. `GET /api/capabilities` — версия сима и версии API.
 *   2. Перечисляет ВСЕ dataref-кандидаты из таблицы (`present | value_type | unit | writable`).
 *   3. Меряет достигнутую частоту потока WS и REST-latency.
 *   4. Читает служебные датарефы pause/time-warp/replay.
 *   5. Печатает PASS/FAIL/REVIEW-таблицу acceptance (probe-plan §3).
 *
 * Запуск (после `pnpm --filter @flightlog/agent build`):
 *   node packages/agent/scripts/xplane-probe.mjs
 *   node packages/agent/scripts/xplane-probe.mjs --url http://127.0.0.1:8086 --seconds 20
 *   node packages/agent/scripts/xplane-probe.mjs --no-rref
 *   node packages/agent/scripts/xplane-probe.mjs --datarefs-txt "C:/X-Plane 12/Resources/plugins/DataRefs.txt"
 *
 * ⚠️ НЕ пишет в сим: ни одного write-запроса/пакета (read-only инвариант).
 * Web API может быть недоступен (XP < 12.1.1 / --no_web_server / «Disable Incoming
 * Traffic» → 403) — тогда отчёт по web-стадиям помечается, работает RREF-проба.
 */
import {
  XPLANE_CORE_REQUIRED_DATAREFS,
  XPLANE_DATAREFS,
  XPLANE_NO_EQUIVALENT_FIELDS,
  XPLANE_REQUIRED_DATAREFS,
  XPlaneRestClient,
  XPlaneWebApiError,
  buildSubscribeMessage,
  buildUnsubscribeMessage,
  probeXPlaneRref,
  toXPlaneWebSocketUrl,
} from '../dist/sim/xplane/index.js';

const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const hasFlag = (name) => args.includes(name);

const baseUrl = flagValue('--url', 'http://127.0.0.1:8086');
const seconds = Math.max(3, Number(flagValue('--seconds', '10')) || 10);
const runRref = !hasFlag('--no-rref');
const datarefsTxt = flagValue('--datarefs-txt', null);

const pad = (value, width) => String(value ?? '-').padEnd(width);
const padStart = (value, width) => String(value ?? '-').padStart(width);

function versionAtLeast(version, minimum) {
  if (typeof version !== 'string') return false;
  const parse = (text) => text.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(version);
  const b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

async function main() {
  const acceptance = new Map();

  console.log('=== X-Plane 12 read-only probe (Stage 0) ===');
  console.log(`base URL: ${baseUrl}`);
  console.log(`measurement window: ${seconds}s; RREF probe: ${runRref ? 'on' : 'off'}`);
  console.log('');

  let rest = null;
  let capabilities = null;
  try {
    rest = new XPlaneRestClient({ baseUrl });
    capabilities = await rest.getCapabilities();
    console.log(
      `[capabilities] sim version: ${capabilities.simVersion ?? 'unknown'}; ` +
        `api versions: ${capabilities.apiVersions.join(', ') || 'unknown'}`,
    );
  } catch (error) {
    const reason = error instanceof XPlaneWebApiError ? error.reason : 'error';
    console.log(`[capabilities] unavailable (${reason}): ${error.message}`);
  }

  if (capabilities) {
    acceptance.set(
      'AC-1',
      versionAtLeast(capabilities.simVersion, '12.1.1') ? 'PASS' : 'REVIEW (xp<12.1.1?)',
    );
  } else {
    acceptance.set('AC-1', 'REVIEW (web down → RREF?)');
  }

  // --- Stage 2: dataref enumeration ---------------------------------------
  const resolved = [];
  const missing = [];
  const info = new Map();
  if (rest && capabilities) {
    console.log('');
    console.log(
      `${padStart('#', 3)}  ${pad('field/dataref', 62)}  ${pad('present', 7)}  ` +
        `${pad('value_type', 12)}  ${pad('unit', 9)}  writable`,
    );
    let index = 0;
    for (const spec of Object.values(XPLANE_DATAREFS)) {
      index += 1;
      let entry = null;
      try {
        entry = await rest.findDataref(spec.dataref);
      } catch {
        entry = null;
      }
      if (entry) {
        resolved.push(spec.dataref);
        info.set(spec.dataref, entry);
      } else {
        missing.push(spec.dataref);
      }
      console.log(
        `${padStart(index, 3)}  ${pad(spec.dataref, 62)}  ${pad(entry ? 'present' : 'ABSENT', 7)}  ` +
          `${pad(entry?.valueType ?? spec.valueType, 12)}  ${pad(spec.unit, 9)}  ` +
          `${entry?.writable === null || entry?.writable === undefined ? '?' : String(entry.writable)}`,
      );
    }
  }

  if (resolved.length > 0) {
    const corePresent = XPLANE_CORE_REQUIRED_DATAREFS.filter((name) => resolved.includes(name));
    const requiredPresent = XPLANE_REQUIRED_DATAREFS.filter((name) => resolved.includes(name));
    console.log('');
    console.log(
      `[datarefs] resolved ${resolved.length}/${resolved.length + missing.length}; ` +
        `core R ${corePresent.length}/${XPLANE_CORE_REQUIRED_DATAREFS.length}; ` +
        `all R ${requiredPresent.length}/${XPLANE_REQUIRED_DATAREFS.length}`,
    );
    console.log(`[datarefs] no XP-equivalent (honest null): ${XPLANE_NO_EQUIVALENT_FIELDS.length}`);
    acceptance.set(
      'AC-2',
      requiredPresent.length === XPLANE_REQUIRED_DATAREFS.length
        ? 'PASS'
        : `FAIL (missing: ${XPLANE_REQUIRED_DATAREFS.filter((n) => !resolved.includes(n)).join(', ')})`,
    );
    acceptance.set('AC-3', 'REVIEW (сверить unit/type по DataRefs.txt руками)');
  } else {
    acceptance.set('AC-2', capabilities ? 'FAIL (нет web-результата)' : 'REVIEW (web down)');
    acceptance.set('AC-3', 'REVIEW (web down)');
  }

  // --- Stage 4: WS rate + REST latency ------------------------------------
  if (rest && capabilities && resolved.length > 0) {
    const ids = resolved.map((name) => info.get(name)?.id).filter((id) => typeof id === 'number');
    const ws = await measureWebSocket(toXPlaneWebSocketUrl(baseUrl), ids, seconds);
    console.log('');
    if (ws.error) {
      console.log(`[ws] measurement error: ${ws.error.message}`);
    } else {
      console.log(
        `[ws] messages: ${ws.messages}; update messages: ${ws.updates}; ` +
          `achieved ~${ws.hz.toFixed(2)} Hz over ${seconds}s; ` +
          `first update: ${ws.firstUpdateMs === null ? 'n/a' : `${ws.firstUpdateMs} ms`}`,
      );
    }
    acceptance.set(
      'AC-5',
      ws.updates > 0 && ws.hz >= 5 ? 'PASS' : ws.updates > 0 ? 'REVIEW (<5 Hz)' : 'FAIL (no updates)',
    );

    const sampleName = XPLANE_DATAREFS.latitude.dataref;
    const sampleId = info.get(sampleName)?.id;
    if (typeof sampleId === 'number') {
      const startedAt = Date.now();
      try {
        const value = await rest.getDatarefValue(sampleId);
        console.log(
          `[rest] GET /datarefs/${sampleId}/value: ${value} (round-trip ${Date.now() - startedAt} ms)`,
        );
      } catch (error) {
        console.log(`[rest] value read error: ${error.message}`);
      }
    }
  } else {
    acceptance.set('AC-5', 'REVIEW (web down)');
  }

  // --- Stage 6: pause / time-warp / replay hooks --------------------------
  if (rest && capabilities) {
    console.log('');
    let replayValue = null;
    for (const [role, label] of [
      ['paused', 'pause'],
      ['sim_speed', 'time-warp (sim_speed)'],
      ['sim_speed_actual', 'time-warp (actual ratio)'],
      ['is_in_replay', 'replay (is_in_replay)'],
    ]) {
      const dataref = XPLANE_DATAREFS[role].dataref;
      const id = info.get(dataref)?.id;
      if (typeof id !== 'number') {
        console.log(`[hooks] ${label}: dataref absent (${dataref})`);
        continue;
      }
      try {
        const value = await rest.getDatarefValue(id);
        if (role === 'is_in_replay') replayValue = value;
        console.log(`[hooks] ${label}: ${value}`);
      } catch (error) {
        console.log(`[hooks] ${label}: read error (${error.message})`);
      }
    }
    acceptance.set('AC-7', info.has(XPLANE_DATAREFS.paused.dataref) ? 'REVIEW (проверить pause на живом симе)' : 'FAIL');
    acceptance.set('AC-8', info.has(XPLANE_DATAREFS.sim_speed.dataref) ? 'REVIEW (проверить time-warp)' : 'FAIL');
    if (info.has(XPLANE_DATAREFS.is_in_replay.dataref)) {
      acceptance.set(
        'AC-9',
        `PASS (прямой признак sim/time/is_in_replay=${replayValue ?? '?'} → slew/replay-детект)`,
      );
    } else {
      acceptance.set('AC-9', 'REVIEW (нет признака replay — детект по позиции/времени)');
    }
  } else {
    acceptance.set('AC-7', 'REVIEW (web down)');
    acceptance.set('AC-8', 'REVIEW (web down)');
    acceptance.set('AC-9', 'REVIEW (web down)');
  }

  // --- Stage 7: RREF fallback ---------------------------------------------
  if (runRref) {
    const rref = await probeXPlaneRref({ timeoutMs: 1000 });
    console.log('');
    console.log(`[rref] UDP :49000 read-only probe: ${rref ? 'OK' : 'NO RESPONSE'}`);
    if (!capabilities) acceptance.set('AC-1', rref ? 'PASS (RREF fallback)' : 'FAIL (no web, no rref)');
    acceptance.set('AC-5', acceptance.get('AC-5') ?? (rref ? 'REVIEW (rate via RREF freq)' : 'FAIL'));
  }

  acceptance.set('AC-4', 'REVIEW (дефолтные настройки: пользователь ничего не включает)');
  acceptance.set('AC-6', 'REVIEW (знаки/оси тангажа/крена/g_nrml — по приборам)');
  acceptance.set('AC-10', 'PASS (probe шлёт только GET/subscribe/RREF)');
  acceptance.set('AC-11', 'REVIEW (сверка 5 сценариев руками)');
  acceptance.set(
    'AC-12',
    datarefsTxt ? `REVIEW (проверить ${datarefsTxt})` : 'REVIEW (укажите --datarefs-txt)',
  );

  console.log('');
  console.log('=== Acceptance (probe-plan §3) ===');
  for (const key of [...acceptance.keys()].sort()) {
    console.log(`${pad(key, 7)} ${acceptance.get(key)}`);
  }
  console.log('');
  console.log('Read-only proof: исходящие — только GET /api/*, WS subscribe/unsubscribe, RREF.');
}

function measureWebSocket(wsUrl, ids, windowSeconds) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (error) {
      resolve({ error, messages: 0, updates: 0, hz: 0, firstUpdateMs: null });
      return;
    }
    let opened = false;
    let done = false;
    let messages = 0;
    let updates = 0;
    let openedAt = null;
    let firstUpdateAt = null;

    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      try {
        if (opened && ids.length > 0) socket.send(buildUnsubscribeMessage(99, ids));
      } catch {
        // ignore
      }
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve({
        error: error ?? null,
        messages,
        updates,
        hz: updates / windowSeconds,
        firstUpdateMs: firstUpdateAt !== null && openedAt !== null ? firstUpdateAt - openedAt : null,
      });
    };

    const watchdog = setTimeout(() => finish(new Error('websocket timeout')), windowSeconds * 1000 + 3000);

    socket.onopen = () => {
      opened = true;
      openedAt = Date.now();
      try {
        socket.send(buildSubscribeMessage(1, ids));
      } catch (error) {
        finish(error);
      }
    };
    socket.onmessage = (event) => {
      messages += 1;
      try {
        const message = JSON.parse(typeof event.data === 'string' ? event.data : '');
        if (message.type === 'dataref_update_values') {
          updates += 1;
          if (firstUpdateAt === null) firstUpdateAt = Date.now();
        }
      } catch {
        // ignore non-JSON
      }
    };
    socket.onerror = () => finish(new Error('websocket error'));
    socket.onclose = () => finish(null);

    setTimeout(() => finish(null), windowSeconds * 1000);
  });
}

main().catch((error) => {
  console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
