#!/usr/bin/env node
/**
 * xplane-td-capture.mjs — read-only high-rate touch-down capture (Stage 0).
 *
 * ТОЛЬКО RREF (UDP :49000, freq push) — без единого write-пакета в сим.
 * Пишет NDJSON-снимки (по одному на каждую принятую датаграмму) с полной
 * картой «последних известных» значений и стенным таймстампом приёма.
 *
 * Запуск:
 *   node packages/agent/scripts/xplane-td-capture.mjs --seconds 1200 --freq 50 --out td.ndjson
 */
import { createSocket } from 'node:dgram';
import { createWriteStream } from 'node:fs';
import { encodeRrefRequest, decodeRrefValues } from '../dist/sim/xplane/index.js';

const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const seconds = Math.max(10, Number(flagValue('--seconds', '1200')) || 1200);
const freq = Math.max(1, Math.min(100, Number(flagValue('--freq', '50')) || 50));
const port = Number(flagValue('--port', '49000')) || 49000;
const host = '127.0.0.1';
const outPath = flagValue('--out', 'C:/Users/Igor/AppData/Local/Temp/opencode/xp-td.ndjson');

const DATAREFS = [
  'sim/flightmodel/position/latitude',
  'sim/flightmodel/position/longitude',
  'sim/flightmodel/position/elevation',
  'sim/flightmodel/position/y_agl',
  'sim/flightmodel/position/vh_ind_fpm',
  'sim/flightmodel/position/groundspeed',
  'sim/flightmodel/position/indicated_airspeed',
  'sim/flightmodel/position/true_psi',
  'sim/flightmodel/position/true_theta',
  'sim/flightmodel/position/true_phi',
  'sim/flightmodel/forces/g_nrml',
  'sim/flightmodel/failures/onground_any',
  'sim/flightmodel2/gear/on_ground[0]',
  'sim/flightmodel2/gear/on_ground[1]',
  'sim/flightmodel2/gear/on_ground[2]',
  'sim/flightmodel2/gear/tire_vertical_force_n_mtr[0]',
  'sim/flightmodel2/gear/tire_vertical_force_n_mtr[1]',
  'sim/flightmodel2/gear/deploy_ratio[0]',
  'sim/flightmodel2/gear/deploy_ratio[1]',
  'sim/flightmodel2/gear/deploy_ratio[2]',
  'sim/cockpit2/controls/flap_ratio',
  'sim/cockpit2/controls/speedbrake_ratio',
  'sim/cockpit2/controls/left_brake_ratio',
  'sim/cockpit2/controls/right_brake_ratio',
  'sim/time/paused',
  'sim/time/sim_speed',
];

const out = createWriteStream(outPath, { flags: 'a' });
out.write(
  `${JSON.stringify({
    _meta: 'xplane-td-capture/1',
    startedAt: new Date().toISOString(),
    freq,
    datarefs: DATAREFS,
  })}\n`,
);

const socket = createSocket('udp4');
const indexToName = new Map();
const latest = new Map();
let rows = 0;
let lastStatus = Date.now();

socket.on('message', (buf) => {
  const values = decodeRrefValues(buf);
  if (values.size === 0) return;
  for (const [index, value] of values) {
    const name = indexToName.get(index);
    if (name !== undefined) latest.set(name, value);
  }
  const snapshot = { t: Date.now() };
  for (const [name, value] of latest) snapshot[name] = value;
  out.write(`${JSON.stringify(snapshot)}\n`);
  rows += 1;
  if (rows % 500 === 0) out.once('drain', () => {});
});

socket.on('error', (error) => {
  console.error(`[td] socket error: ${error.message}`);
});

socket.bind(() => {
  DATAREFS.forEach((name, i) => {
    const index = i + 1;
    indexToName.set(index, name);
    socket.send(encodeRrefRequest(name, freq, index), port, host);
  });
  console.log(`[td] subscribed ${DATAREFS.length} datarefs @ ${freq} Hz → ${outPath}`);
  const status = setInterval(() => {
    const now = Date.now();
    if (now - lastStatus > 10000) {
      lastStatus = now;
      const og = latest.get('sim/flightmodel/failures/onground_any');
      const g0 = latest.get('sim/flightmodel2/gear/on_ground[0]');
      const g1 = latest.get('sim/flightmodel2/gear/on_ground[1]');
      const g2 = latest.get('sim/flightmodel2/gear/on_ground[2]');
      console.log(
        `[td] rows=${rows} onground_any=${og} gear=${g0}/${g1}/${g2} ` +
          `agl=${latest.get('sim/flightmodel/position/y_agl')} ` +
          `vs=${latest.get('sim/flightmodel/position/vh_ind_fpm')} ` +
          `gs=${latest.get('sim/flightmodel/position/groundspeed')}`,
      );
    }
  }, 1000);
  setTimeout(() => {
    clearInterval(status);
    DATAREFS.forEach((name, i) => {
      try {
        socket.send(encodeRrefRequest(name, 0, i + 1), port, host);
      } catch {
        // ignore
      }
    });
    out.end(() => {
      console.log(`[td] done: ${rows} rows → ${outPath}`);
      socket.close();
    });
  }, seconds * 1000);
});
